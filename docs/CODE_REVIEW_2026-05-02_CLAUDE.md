# Code Review — 2026-05-02 (Claude, independent pass)

## Scope
Independent review of the same tree covered by `docs/CODE_REVIEW_2026-05-02.md`. Read every file under `src/`, `ui/src/`, the test suites, the install/deploy scripts, the Dockerfile and compose file, the env config, and the handoff docs (`README.md`, `DEVLOG.md`, `TODO.md`, `docs/PLAN.md`, `docs/API.md`). Focus on correctness, security, runtime failure modes, and the user-stated priorities (Browse, Search, Queue, Zone Switching).

This pass confirms or rejects the prior findings, then adds issues the prior review did not surface.

## Validation
Did not re-run validation in this pass — the prior review on the same tree reports build/test/lint/check passing on this exact file set. No source changes since then in tracked files (only `DEVLOG.md`, `TODO.md`, `docs/PLAN.md` and this new file are untracked/modified).

## Summary of agreement with the prior review

| # | Prior finding | Verdict | Notes |
|---|---|---|---|
| 1 | Default `0.0.0.0` + `*` socket origin + no auth | **Agree, P1** | Reaffirm; expand below (no Helmet, no rate limit, no CSP). |
| 2 | Socket ack errors swallowed by UI | **Agree, P1** | Confirmed in `+layout.svelte:84` and `queue/+page.svelte`. Plus the ack vs. event branching in the server inverts the contract — see new finding C-2. |
| 3 | Reconnect leaves UI offline | **Agree, P1** | Confirmed. Server hydrates zones/now-playing on `connection`, never re-emits `core-status`. Client treats *socket disconnect* as *core unpaired*. |
| 4 | Weak runtime validation on REST/socket payloads | **Agree, P2** | Reaffirm; specifically `seek` accepts string `seconds` over REST (`seconds === undefined` check passes "abc"), and `setVolume` accepts NaN. |
| 5 | SPA fallback returns HTML for unknown `/api/*` | **Agree, P2** | One-line fix: gate the fallback on `!req.path.startsWith('/api/')`. |
| 6 | Browse loads entire result set synchronously | **Agree, P2** | The "load all then render" loop in `loadItemsForList` runs `count/100` sequential round-trips with no cancellation, even for `pop` which always passes `offset: 0`. |
| 7 | Search UI truncates to 8 results | **Agree, P2** | Plus stale-results-after-zone-change is a real footgun on a multi-zone setup. |
| 8 | Token written with default mode | **Agree, P2** | Trivial fix: `fs.writeFileSync(path, data, { mode: 0o600 })` and `fs.mkdirSync(dir, { recursive: true, mode: 0o700 })`. |
| 9 | Image cache filename is unsanitized route param | **Agree — would raise to P1**, see C-1 below | The prior review describes this mostly as a cache-integrity issue; it is also a path-traversal vulnerability (Express 5 decodes `%2E%2E%2F` in `req.params.key`). |
| 10 | Pending play-bar searches dropped on reconnect | **Agree, P3** | Confirmed. |
| 11 | Zone subscription idempotency lives outside the service | **Agree, P3** | Confirmed; also see C-7 (zone-update fan-out). |
| 12 | Test coverage misses risky integration paths | **Agree, P3** | The two existing test files are competent unit tests but the surface they cover is small. |

## New findings (not raised by the prior review)

### C-1. P1 High — Path traversal in image cache via decoded route parameter
Evidence: `src/server/http/routes/image.ts:17`, `src/server/http/routes/image.ts:19`, `src/core/roon/ImageService.ts:65-69`, `src/core/roon/ImageService.ts:87-89`

`req.params.key` is decoded by Express, and the value flows directly into `path.join(cacheDir, cacheKey)` (with `cacheKey = imageKey` or `${imageKey}_${scale}_${w}x${h}`). A request to `GET /api/image/%2E%2E%2F%2E%2E%2Ftmp%2Fpwn?scale=fit&width=1&height=1` decodes to `key = "../../tmp/pwn"`, producing a `cachePath` of `<cacheDir>/../../tmp/pwn_fit_1x1`.

Two concrete consequences:
1. **Arbitrary read of files inside the runtime user's reach** on cache hit: the first branch in `getImage` is `fs.promises.readFile(cachePath)` followed by `readFile(metaPath)`. Both must succeed for a cache hit, so a fully crafted attack would need two attacker-controlled files, but reading sensitive files in a sibling directory is plausible (e.g. `../config/roon-token.json` if the meta file exists or is created elsewhere).
2. **Arbitrary write of attacker-controlled bytes to attacker-chosen paths** on cache miss: `fs.promises.writeFile(cachePath, result.data)` writes whatever bytes Roon returns (or anything the attacker can convince Roon to return for an image key) under the traversed path. `result.data` is the Roon response — bounded by what the Roon API returns for `get_image(imageKey, …)`. In the worst case an attacker can fill disk in arbitrary locations or overwrite files under the service user's permissions if Roon returns content for any key (which it usually does not for unknown keys, but error paths vary).

Recommendation: hash `imageKey + scale + width + height` with SHA-256 and use that hex as the filename. Validate `scale` against the literal set `{"fit","fill","stretch"}` and require positive integer width/height. Reject keys longer than a fixed size before they reach the filesystem layer.

Suggested tests: route tests for `%2E%2E%2F`, embedded NUL (`%00`), uppercase encoding, mixed encoding, very long keys, missing scale + present width, scale + missing width.

### C-2. P1 High — Server's ack/error contract inverts what the client expects
Evidence: `src/server/socket/index.ts:44-84`, `ui/src/lib/socket/register.ts:127-154`

The server emits the topic-specific error event (`transport:error`, `browse:error`, `queue:error`) **only when the caller did not provide an ack**. When the caller did provide an ack, only the ack receives the error. This means:

- Clients that always pass an ack callback (the play bar in `+layout.svelte:84`, the queue page in `queue/+page.svelte:51,76,102`) **never** see a `transport:error` event, so the error toast never fires for ack-bearing commands.
- Clients that ignore the error inside the ack (today: all of them — the ack callback discards its argument) see no error feedback at all.

Combined with finding #2 from the prior review, this means failed Roon commands are completely invisible to the user when they originate from any UI surface that uses ack callbacks. The error toast is essentially dead code for transport/queue.

Recommendation: pick one shape and stick to it. Either (a) emit the error event always and let the ack carry only success, or (b) keep the bifurcation but fix every client to inspect the ack payload. Standardize the ack as `{ success: true } | { success: false; error: string; code?: string }` and route ack errors through `pushCommandFeedback` in a single `emitWithAck` helper. Today every callsite re-implements the timeout-and-ignore-result pattern.

Suggested tests: integration tests where the transport service rejects a command; assert (1) the ack receives `{ error }` and (2) `commandFeedbackStore` updates.

### C-3. P2 Medium — Queue items are sorted by `queue_item_id` as if it were a play-order index
Evidence: `src/core/roon/TransportService.ts:570`

After every queue mutation, `nextItems.sort((a, b) => a.queue_item_id - b.queue_item_id)`. This treats `queue_item_id` as the play position. The Roon transport API documents `queue_item_id` as an opaque, monotonically increasing identifier — for an append-only queue it happens to coincide with play order, but inserting before existing items (Play Next, reordering, splice operations from another control point) breaks the assumption. The result is a queue that quietly displays in ID order while Roon plays in a different order, and the "Play Here" button will jump to a different track than the user clicked.

Roon's queue subscription delivers items in the correct play order in the `items` array; reordering (`items_changed`/`items_added`/`items_removed`) provides positional info that the current code throws away by re-sorting. This is also why `likelyCurrent()` in `queue/+page.svelte:158` had to fall back to fuzzy title matching — the row index can't be trusted as "the current track."

Recommendation: do not sort. Apply diffs positionally using whatever index info Roon provides for `items_changed`/`items_added` (Roon supplies `from_queue_item_id`/index hints in the queue subscription delta). Until that's wired up, prefer trusting the most recent full `items` array on subscribe over reconstructing one from deltas.

Suggested tests: a queue update sequence where a "Play Next" inserts a track between two existing items; assert that the rendered order matches Roon's order, not numeric ID order.

### C-4. P2 Medium — `extractQueueItemId` falls back to `queue_item_id: 0`, collapsing unknown items
Evidence: `src/core/roon/TransportService.ts:583-591`, `src/core/roon/TransportService.ts:594-602`

`normalizeQueueItem` returns `queue_item_id: this.extractQueueItemId(item) ?? 0`. `extractQueueItemId` returns `undefined` if neither `item` (number) nor `item.queue_item_id` (number) is finite. Multiple malformed items therefore collapse onto id `0`, and the subsequent `findIndex(c => c.queue_item_id === item.queue_item_id)` in items_changed/items_added treats them as the same row. "Play Here" on row N would issue `play_from_here(zone, 0)` and fail or land on the wrong item.

Recommendation: drop items without a valid id rather than synthesizing one. Log at warn level when this happens.

### C-5. P2 Medium — Track-list detection relies on titles starting with a digit
Evidence: `ui/src/routes/library/+page.svelte:300-322`, `ui/src/routes/library/+page.svelte:374-382`

`isTrackList`, `pageActions`, `trackItems`, `trackNum`, and `trackTitle` all depend on parsing a leading `\d+\.` out of the title string. This breaks for:
- Albums where Roon does not prepend a track number (some streaming sources, classical movements, single-track albums).
- Non-Latin titles where Roon localizes the prefix.
- "Various Artists" compilations where Roon shows artist before title.

The Roon browse item already exposes `item_subtype`/`item_type` and `hint`. The prior review (#7) mentioned this in passing for search; it also affects every album view. When the heuristic misfires, `pageActions` and `trackItems` partition items incorrectly and the track-list view either shows nothing or renders actions as tracks.

Recommendation: identify track rows by `hint === 'action_list'` plus an explicit Roon item-type check, not by title regex. If a tracklist needs numbering, use the row index, not parsed leading digits.

### C-6. P2 Medium — No CSP, no Helmet, no compression, no body-size hardening
Evidence: `src/server/http/app.ts:24-34`

Only `app.disable("x-powered-by")` and `express.json()` are wired. There is no CSP, no `X-Content-Type-Options: nosniff`, no `X-Frame-Options`, no `Referrer-Policy`, no rate-limit middleware, no body size cap beyond the json default (100kb). For a service intended to be exposed on the LAN with no auth, this is the wrong default. The image route is the riskiest surface because it serves whatever `Content-Type` Roon hands back and that response is cached on disk under a 24-hour `immutable` directive — a poisoned cache entry would persist across restarts.

Recommendation: add `helmet()` with sensible defaults, set `Content-Type` allowlist on the image route (only `image/*`), add `express-rate-limit` on `/api/*`, and lower body size to ~32kb. Done together this is ~10 lines and one new dep.

### C-7. P2 Medium — Every Roon zone update triggers two full-zones broadcasts
Evidence: `src/server/server.ts:96-107`, `src/core/roon/TransportService.ts:404-450`

`handleZonesUpdate` emits `zone-updated` per zone in a loop. The server-side handler then *also* emits the full `zones` snapshot per zone-updated event. A Roon update touching N zones produces N `zone-updated` + N `zones` socket emissions, each carrying the full zones array. With many zones and frequent now-playing tick updates, this is significant bandwidth and CPU on socket fan-out.

Also: `zone-removed` triggers a `zones` broadcast on its own, then the next zones snapshot will also be sent — the client receives redundant updates that all converge to the same state.

Recommendation: emit `zones` once per Roon callback batch, not once per zone. Either (a) add a microtask coalescer in the server-side wiring, or (b) move the per-batch broadcast into TransportService and have it emit a single `zones-changed` event after the batch.

### C-8. P2 Medium — Volume is hardcoded to absolute mode; UI cannot change volume; incremental outputs cannot be controlled
Evidence: `src/core/roon/TransportService.ts:188-202`, `ui/src/routes/+layout.svelte` (no volume control), `src/shared/types.ts:101-119`

`setVolume` always calls `change_volume(output_id, "absolute", value, …)` regardless of `VolumeSettings.type`. Outputs whose volume type is `"incremental"` cannot be driven through this code path — Roon expects `"relative"` with a step delta, not an absolute value. Combined with the absence of any volume slider in the UI (the play bar has play/prev/next but no volume), this entire surface is untestable by hand and never validated.

Recommendation: branch on the output's `VolumeSettings.type`, and add at least a basic volume slider to the play bar so the code path is exercised.

### C-9. P2 Medium — Theme flashes on first paint
Evidence: `ui/src/lib/stores/themeStore.ts`, `ui/src/routes/+layout.svelte:31-41`, `ui/src/app.html` (not read but inferred)

`+layout.ts` declares `prerender = true`, so the page ships pre-rendered HTML with whatever default theme the static build chose. `initializeTheme` only runs in `onMount`, which fires after first paint. A user with a stored `light` theme will see the dark page flash before it switches. This also breaks `localStorage` access in privacy modes — `localStorage.getItem` and `setItem` are not wrapped in try/catch and will throw.

Recommendation: add a tiny inline `<script>` in `app.html` that reads the stored theme and sets `data-theme` on `<html>` before the body renders. Wrap `localStorage` calls in try/catch.

### C-10. P2 Medium — Browse history is component-local and lost on reload, route change, or zone switch
Evidence: `ui/src/routes/library/+page.svelte:14-17`, `ui/src/routes/library/+page.svelte:31-35`

`historyStack` and `forwardStack` are `$state` inside the Library page. Any of:
- Hard reload
- Switching to /queue and back
- Clicking the play-bar artist link (which calls `goto('/library')` after setting `pendingSearchStore`)

…destroys the back/forward state and resets navigation to the browse root. Users who drilled three levels deep lose their place every time they peek at the queue. This is the #1 thing that will feel broken in daily use.

Recommendation: lift the stacks into a store (`browseHistoryStore`) and rehydrate on mount. Optionally encode the active path in the URL so reload restores it.

### C-11. P3 Low — Socket.IO client uses websocket-only transport and has no `connect_error` handling
Evidence: `ui/src/lib/socket/client.ts:11-15`, `ui/src/lib/socket/register.ts:183-190`

`io({ transports: ['websocket'] })` skips the polling fallback. On networks that block or downgrade WebSockets (some corporate proxies, captive portals, mobile carrier weirdness), the client never connects and the UI stays in the disconnect-handler state forever. There is no `connect_error` listener to surface this — only `disconnect`.

Recommendation: include `'polling'` as a fallback transport, and listen for `connect_error` to update the status pill with something more useful than "Offline."

### C-12. P3 Low — Roon shutdown is not graceful
Evidence: `src/index.ts:14-30`, `src/core/roon/RoonClient.ts` (no shutdown method)

Shutdown closes the socket and HTTP servers but does not unsubscribe Roon zone/queue listeners or call any teardown on the Roon API. The Roon Core sees the connection drop but the extension process still has live callbacks queued until the OS cleans up. Not catastrophic, but in long-running service mode (systemd restart) it's the kind of thing that surfaces as "stale subscriptions persist for ~30s after restart."

Recommendation: add `RoonClient.stop()` that calls `transport.unsubscribe_zones`/`unsubscribe_queue` for each known subscription and clears callbacks; call it from the `shutdown` handler before closing HTTP.

### C-13. P3 Low — Image cache has no eviction and no size cap
Evidence: `src/core/roon/ImageService.ts:14-26`, `src/core/roon/ImageService.ts:87-92`

The cache grows unbounded for the lifetime of the install. Every unique `(imageKey, scale, w, h)` tuple becomes a file. Over months this becomes gigabytes for users with large libraries. There is no LRU, no size cap, no max-age cleanup.

Recommendation: cap by directory size or count and evict oldest. Even a simple "delete files older than N days at startup" job would suffice.

### C-14. P3 Low — `BrowseService` declares event types it never broadcasts to Socket.IO
Evidence: `src/core/roon/BrowseService.ts:17-23`, `src/server/server.ts:121-123`

`BrowseService` is an `EventEmitter` that emits `browse-result` and `search-result`, but the server intentionally does not subscribe to them (per the comment at `server.ts:121-123` — REST-initiated browses must not broadcast). Socket-initiated browses emit per-socket inside the socket handler, which is correct. The result is that the EventEmitter machinery and typed `on/emit` declarations on `BrowseService` are dead code that future maintainers will mistakenly try to wire up.

Recommendation: remove `extends EventEmitter` from `BrowseService` and the `declare interface BrowseService` block. Browse is request/response, not pub/sub.

### C-15. P3 Low — `(error as Error).message` in socket handlers will throw on non-Error rejections
Evidence: `src/server/socket/index.ts:118,139,160,181,207,233,268,294,319,345,370,395,420,445`

Every catch block uses `(error as Error).message`. Roon callbacks deliver errors as strings (e.g. `cb('Roon error')` in the test fixture at `TransportService.test.ts:67`), and `RoonOperationError` wraps these as `${operation} failed: ${message}` where `message` is the original string. That's fine for `RoonOperationError`. But `setVolume` rejects with `new RoonOperationError("setVolume", error, …)` where `error` is the raw Roon string — fine. The risk is non-`Error` rejections that bypass the wrapper (e.g. anything throwing inside an async handler before the try/catch). `(undefined as Error).message` throws `TypeError: Cannot read properties of undefined`, which an unhandledRejection handler may or may not catch.

Recommendation: a tiny helper `errorMessage(e: unknown): string` that returns `e instanceof Error ? e.message : String(e ?? "Unknown error")`. Use everywhere.

### C-16. P3 Low — `inferSearchType` uses `hint || itemType`, but Roon search items usually report `hint: "action_list"`
Evidence: `src/core/roon/BrowseService.ts:405-438`, `src/core/roon/__tests__/BrowseService.test.ts:316-318`

The existing test asserts that `hint: "action"` falls through to `"unknown"`. In practice, Roon search results come back with `hint: "action_list"` or `hint: "list"` plus a `subtype`/`item_subtype` like `"album"`/`"artist"`. The current logic checks `hint || type`, so it almost always gets the wrong token (the structural hint, not the semantic subtype). The visible symptom: search results are labeled `"unknown"` or `"list"` instead of `"album"`/`"artist"`.

Recommendation: prefer `itemType` over `hint`, and only fall back to `hint` when `itemType` is missing. Add fixtures that match real Roon search payloads (a captured response from a live core would be ideal).

### C-17. P3 Low — Browse spam at info level
Evidence: `src/core/roon/BrowseService.ts:49,73,96,124`

Every browse, load, pop, and search logs at `info`. With auto-loaded full lists in `loadItemsForList` (finding #6), one user click on a 5000-item list emits ~50 info-level "Invoking Roon browse API" lines. Production logs become noisy and the actual signal (errors, pairing transitions) gets buried.

Recommendation: drop these to `debug`; keep `info` for browse failures only.

### C-18. P3 Low — `subscribe_zones` callback also triggers `handleSeekChanged`, but the initial "Subscribed" event has no `zones_seek_changed`
Evidence: `src/core/roon/TransportService.ts:343-358`

In the `Changed` branch, `handleZonesUpdate(data)` and `handleSeekChanged(data)` are both called. In the `Subscribed` branch, only `handleZonesUpdate` is called. That's fine today because the initial snapshot doesn't carry `zones_seek_changed`, but the asymmetry isn't documented and would silently break if Roon ever sends a combined initial payload.

Recommendation: call both in both branches; `handleSeekChanged` already noops when the field is absent.

### C-19. P3 Low — `+page.svelte` (root) blank-flashes a redirect
Evidence: `ui/src/routes/+page.svelte:1-8`

The root page renders an empty `<script>` block and only redirects in `onMount`. Static prerender ships an empty HTML body. A user landing on `/` sees blank, then `/library`. A static `<meta http-equiv="refresh">` or moving the redirect into a server hook would feel snappier.

### C-20. P3 Low — `likelyCurrent` substring matching highlights the wrong row in repetitive queues
Evidence: `ui/src/routes/queue/+page.svelte:158-162`

`title.includes(current)` with `current = nowPlaying?.title.toLowerCase()`. Two queue items with overlapping titles ("Symphony No. 9", "Symphony No. 9 — Movement II") both match. The currently playing one is not distinguished.

Recommendation: Roon's queue subscription includes the currently playing `queue_item_id` on the zone object; use that instead of fuzzy text matching.

### C-21. P3 Low — `setVolume` REST/socket validators do not bound the value to `VolumeSettings.{min,max}`
Evidence: `src/server/socket/index.ts:218`, `src/server/http/routes/transport.ts:140`

A volume of `1e308` or `-50` is forwarded to Roon. Roon will reject it, but the rejection path (finding C-2) is invisible to the user, so they get a silent no-op.

Recommendation: cross-reference the output's known min/max from `transportService.getZones()` and reject before invoking Roon.

### C-22. P3 Low — `selectedZoneStore` defaults to first zone but never persists
Evidence: `ui/src/lib/stores/selectedZoneStore.ts`, `ui/src/routes/+layout.svelte:43-53`

Refresh resets the selected zone to "the first zone in the list," which is non-deterministic across Roon restarts. A multi-zone user has to re-pick their preferred zone on every reload.

Recommendation: persist to `localStorage`, similar to `themeStore`.

### C-23. P3 Low — No `connect_error`, no exponential backoff status, no health UI when Roon Core is dropping in/out
Evidence: `ui/src/lib/socket/register.ts:156-162`

Disconnect → reset everything to empty. There is no transient "reconnecting…" state, no countdown, no retry indicator. The status pill's `Connected | Offline` is binary.

## Correctness/quality items not worth a formal finding
- `RoonClient.start` reads `this.options.logger.level ?? "info"` and passes it as `log_level` to Roon API. Pino's `level` is a string like `"info"`, which matches what Roon expects, but verify this matches Roon API's enum exactly.
- `pino-pretty` is in `devDependencies` but `createLogger` uses it whenever `NODE_ENV !== "production"`. If the deployed env file forgets to set `NODE_ENV=production` (the systemd installer does set it; Docker does not — only `ENV NODE_ENV=production`, which is fine), `pino` will fail to load `pino-pretty` because it isn't installed in the prod node_modules. The Linux installer runs `npm ci --omit=dev` after copying — `pino-pretty` is dev-only — so a misconfigured env (`NODE_ENV` unset) crashes the logger at startup. Worth a defensive check.
- `BrowseService.loadItemsForList` reads `browseResponse?.list?.count` twice and assigns it to two different local names (`count` then `totalCount`). Cosmetic.
- `extractQueueItemId(item: any)` accepts a bare number — that branch exists for `items_removed`, which Roon delivers as either an array of IDs or an array of objects. Worth a comment.
- `ImageService.getCacheHeaders` returns `Cache-Control: public, max-age=86400, immutable`. `immutable` plus `max-age=86400` is contradictory in spirit (`immutable` claims the resource never changes; the 24h max-age suggests otherwise). Pick one.
- `Search.svelte` calls `setSearchLoading(query)` then `liveSocket.emit('browse:search', options)` without an ack. If the socket never delivers a `search-result` event (e.g. Roon error path), the loading state sticks forever. There is no client-side timeout.
- `library/+page.svelte` defines `noop` after `onMount` references it via `pop`/`forward`/`resetRoot`. Hoisting works for `function` declarations but not for `const noop = () => {}` — the reference happens to work because `onMount` runs after script init, but it's brittle. (`noop` is only used in the cleanup path, well after init.)
- `socket.io-client` types are not present in `ui/package.json` (only the runtime). `Socket` and `io` imports rely on bundled types — fine today, fragile if the package ever splits them out.

## Positive observations (independent corroboration)
- The `multi_session_key` plumbing through browse/search/load/pop is the right fix for the reported corruption issue. The new BrowseService tests cover the regression cleanly.
- `ensureTransport`, `ensureImage`, `getBrowseService` all re-fetch from `roonClient` rather than caching. That means a rebind after unpair → pair "just works" without an explicit re-attach step. Subtle but correct.
- The `queueSubscriptions` map's "only re-subscribe if the requested cap is bigger" logic in `subscribeQueue` avoids needless churn during normal zone updates while still allowing growth.
- `errorHandler` middleware correctly translates `RoonError.statusCode` and avoids leaking generic 500s for known service errors.
- Static SvelteKit + Express on a single port with one Dockerfile is a clean deployment story; the SPA fallback issue (#5) is the only thing standing in the way of it being correct.

## Recommended fix order (independent)
1. **C-1** image path traversal — five-line fix (hash the cache key), highest blast radius.
2. **Prior #1** + **C-6** — bind to localhost by default, add Helmet, rate-limit `/api/*`, restrict CORS origin. Couple this with the docs change so LAN exposure is opt-in.
3. **Prior #2** + **C-2** — fix the ack/error contract in one pass (server emits `{ success } | { error }`, client centralizes `emitWithAck`, error toast wired through).
4. **Prior #3** — re-emit `core-status` on socket connection so the UI doesn't conflate socket and core.
5. **C-3** + **C-4** + **C-20** — queue ordering correctness. Today the Queue page is the most likely surface to silently mislead the user.
6. **Prior #5** — `/api` JSON 404 before SPA fallback. One-line gate.
7. **Prior #4** + **C-21** — runtime validators with bounded numerics.
8. **C-10** — lift browse history into a store; this is the most visible UX regression in normal use.
9. **C-7** — coalesce `zones` broadcasts.
10. **C-13** — image cache eviction.
11. **Prior #12** + tests covering: ack error paths, image path traversal, reconnect hydration, queue ordering, browse navigation history.

## Open questions for the owner
- Is there a target deployment shape (LAN appliance vs. localhost + reverse proxy vs. single-user laptop)? The right answers for #1/C-6 differ between them.
- Are queue reordering and remove out of scope permanently (per README) or pending Roon API changes? If permanent, the queue page can be simplified; if pending, the data plumbing should already accommodate index-based diffs (C-3).
- Should the Library back/forward survive route changes, page reloads, or both? The fix shape depends on the answer.
- Is there appetite for a CI workflow? The validation steps in `README.md` are exactly four commands and would slot into GitHub Actions cleanly.
