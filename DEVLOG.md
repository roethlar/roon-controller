# Dev Log

## 2026-05-16 (truly final) — RP: epoch + snapshot-authoritative apply

Two real gaps the prior revision-based fix had:

1. **Server restart broke connected clients.** Server revision counter resets to 0 on restart; a client at `lastApplied=100` would reject every GET / socket event from the new process until it caught up to 101. A persisted recently-played list could stay invisible to the client for a long time.
2. **Equal-revision snapshots were discarded.** Apply was `revision > lastApplied` for *both* snapshots and deltas. For deltas that's right (equal = duplicate). For snapshots that's wrong — a snapshot at the current revision is authoritative and can repair drift from missed deltas. Also: a fresh client loading persisted entries at revision 0 (server hasn't mutated anything yet) would ignore them, because `lastApplied=0` already.

### Fix
Added an `epoch: number` field to every RP payload (per-server-process ID, `Date.now()` at construction). Apply rules split:

- **Snapshots** (`RecentlyPlayedSnapshot`, returned by GET / DELETE): apply if `epoch !== lastApplied.epoch` OR `revision >= lastApplied.revision`. Different epoch = new authority (adopt); equal revision still applies (authoritative repair).
- **Deltas** (`inserted` / `cleared` socket events): apply if `epoch !== lastApplied.epoch` OR `revision > lastApplied.revision`. Strict-newer keeps duplicates from double-applying within an epoch.

When a payload applies, both `lastAppliedEpoch` and `lastAppliedRevision` adopt the payload's values — so an epoch change resets the revision baseline naturally.

### Server
- `RecentlyPlayedService` has `private readonly epoch = Date.now()` and `getEpoch()`. All payloads (REST responses + socket emits in `server.ts`) include it alongside revision.
- Shared types refactored: `RecentlyPlayedSync { revision, epoch }` is the common shape; snapshot/inserted/cleared payloads extend it.

### Tests (+2)
- "snapshot at equal revision still applies (authoritative repair)" — proves the < vs ≤ change for snapshots.
- "different epoch (server restart) adopts the new authority even with lower revision" — proves the epoch tracking handles restart.
- Verified both catch the bug by temporarily reverting `applySnapshot` to the old strict rule without epoch tracking — both tests failed exactly as expected.

UI 142 → 144 (backend 98 unchanged). svelte-check 0/0, builds + lint clean.

## 2026-05-16 (later) — Clear RP: monotonic revisions, end of the race series

The deferral buffer closed the "snapshot wipes post-snapshot insert" race but not its complement: a queued `cleared` event draining after the snapshot would itself wipe the authoritative state. Patching the buffer per case (drop cleared events, count operation IDs, etc.) kept moving the goalposts. The reviewer's pointed recommendation — operation/revision metadata — is the real fix: each state change carries a monotonic revision, and the client filters anything not strictly newer than what it's already applied. With that, arrival order stops mattering at all.

### Server
- `RecentlyPlayedService` keeps a `private revision = 0`, exposed via `getRevision()`. Bumped after every state mutation (insert + cap, clear). On clear() failure the revision is rolled back along with `this.entries`, so a failed clear is fully transparent.
- Route responses now `{ entries, revision }`.
- `server.ts` wraps socket emits with the post-mutation revision: `recently-played-inserted` carries `{ entry, revision }`, `recently-played-cleared` carries `{ revision }`.

### Shared
- New types in `src/shared/types.ts`: `RecentlyPlayedSnapshot`, `RecentlyPlayedInsertedPayload`, `RecentlyPlayedClearedPayload`.

### Frontend
- `recentlyPlayedStore` tracks `lastAppliedRevision`. All apply paths check `if (incoming.revision <= lastAppliedRevision) return` before mutating; on apply they bump the counter.
- Renamed handlers to make the responsibility explicit: `applyRecentlyPlayedInserted`, `applyRecentlyPlayedCleared`, `applyClearResponse`. `loadRecentlyPlayed` adopts the load's revision via the same `applySnapshot` helper used by the DELETE path.
- The deferral buffer and `clearGen` machinery are gone — revisions subsume both. The UI handler is a simple `await clearRecentlyPlayed(fetch); applyClearResponse(snapshot);`.

### Why this is comprehensive
Every documented race in this series falls out of "ignore non-strictly-newer revisions":
- Snapshot wipes post-snapshot insert → snapshot has smaller revision than the insert → discarded.
- Queued `cleared` wipes the snapshot → `cleared` has smaller revision than the snapshot → discarded.
- Stale `cleared` after the snapshot → smaller revision → discarded.
- Load lands after a clear → load's revision < clear's revision → discarded.
- Dropped events leave a revision gap but the next event/load still applies normally (we accept partial state, recoverable via reload).

Server restart resets the server's counter to 0; the client's reconnect path runs `initializeStores → loadRecentlyPlayed`, which re-baselines `lastAppliedRevision` from the load's revision.

### Tests
- Frontend store tests rewritten end-to-end against the new API. New revision-focused cases: stale insert discarded, stale cleared discarded (load-vs-clear guard), applyClearResponse wins over earlier stale events, post-clear insert applies on top.
- Page test for the original race rewritten: socket insert at rev 100 + stale DELETE response at rev 99 → store keeps `['NewTrack', 'Hey Jude']`, not wiped to `[]`.
- **Verified the test catches the bug** by temporarily removing the revision guard — test failed exactly as expected.
- Backend 98 (unchanged), UI 139 → 142. svelte-check 0/0, builds + lint clean.

## 2026-05-16 — Clear RP: defer socket events during in-flight DELETE

The authoritative-response fix didn't close the last race: the DELETE response is a snapshot at *server clear-resolve time*, but the response can arrive at the client AFTER subsequent socket events. Concrete bug shape:

1. DELETE clears with no buffered events → server snapshots `[]`.
2. Between snapshot and HTTP-response delivery, a normal post-clear `now-playing-updated` fires → server inserts NewTrack → `recently-played-inserted` broadcast.
3. Client receives the socket insert first → store=`[NewTrack]`.
4. Slower HTTP response arrives → `setRecentlyPlayedEntries([])` → store=`[]`.

Final: initiator empty, server/other clients have NewTrack. Same divergence pattern as every prior fix, just one transport-ordering layer deeper.

### Fix
While a clear is in flight, defer socket events. After the DELETE response lands, apply the authoritative snapshot first, then drain the queue in arrival order (which is server-emit order per socket.io's per-connection guarantee). Two new store helpers:
- `beginClearDeferral()` — flips a flag; subsequent `appendRecentlyPlayedFromSocket` / `clearRecentlyPlayedEntries` calls push to a buffer instead of mutating the store.
- `endClearDeferral(entries?)` — if entries supplied (success path), applies them via `setRecentlyPlayedEntries` first; then flips the flag and drains the buffer through the normal handlers.

UI `clearRecentEntries` wraps the DELETE: `beginClearDeferral()` before, `endClearDeferral(entries)` on success, `endClearDeferral()` (no apply, just drain) on failure so legitimate server activity isn't lost.

### Tests
- New regression: stall the DELETE via `mockImplementationOnce(() => new Promise(...))`. Click Clear; fire a `appendRecentlyPlayedFromSocket(newTrack)` during the in-flight; assert the store still shows the pre-clear entry (insert was queued). Then resolve the DELETE with `[]`; assert the store converges to `[NewTrack]` (snapshot applied, then queued insert drained on top).
- Verified the test catches the bug by temporarily stripping the deferral check — test failed as expected.

### Minor (P3)
Updated the route's DELETE comment, which still claimed a 200 meant every client agreed the list is empty. After the authoritative-response change, 200 means the clear committed and the body carries the post-drain state — which may be non-empty.

### Validation
Backend 98, UI 139 → 140. svelte-check 0/0, builds + lint clean.

## 2026-05-15 (truly final pass) — Clear RP: authoritative DELETE response

The socket-status gate from the previous pass narrowed the initiator-divergence race but didn't close it: socket status isn't a delivery guarantee. A connected socket whose broadcast got dropped (or whose listener threw silently — see the throwing-`cleared`-listener case) leaves the initiator stale. The opposite race exists too: socket connected at decision time but dropped between socket events landing and the HTTP response resolving.

GPT has been pointing at the right fix the whole time: have the DELETE response carry the post-drain authoritative entries, and have the UI apply that response.

### Fix
- **Backend**: `DELETE /api/recently-played` returns `{ entries: service.getEntries() }` (live post-drain state) instead of a hardcoded `[]`. If a now-playing event was buffered + drained during clear, it's included.
- **Frontend client**: `clearRecentlyPlayed(fetch)` returns `Promise<RecentlyPlayedEntry[]>`.
- **Store**: new `setRecentlyPlayedEntries(entries)` replaces the entries with an authoritative snapshot, bumps `clearGen` (so a stale in-flight load can't repopulate after), keeps `loaded: true`.
- **UI**: handler applies the response unconditionally; socket-status check removed.

The socket `cleared` and `inserted` broadcasts still fire for all clients (including the initiator). They converge to the same final state because they ARE this clear's outcome via a different transport. The only cost is a brief sub-frame flicker on the rare ordering where the HTTP response wins the race against socket events; eventual state is correct in every ordering, including dropped-broadcast and throwing-listener cases.

### Tests
- Frontend: "Clear button issues DELETE and applies the empty response" (the common case). "Clear button applies post-drain entries from the DELETE response" (regression for the drain-during-clear race — mock returns `[{title: 'Drained Mid-Clear'}]`, asserts the initiator's store reflects it).
- Existing backend route test still passes — `getEntries()` returns `[]` in the no-concurrent-insert case.
- Backend 98, UI 139 (same — rewrote 2 in place).

### Cleanup
The `socketStatusStore` import in `+page.svelte` is gone; `clearRecentlyPlayedEntries` import too (the UI handler uses `setRecentlyPlayedEntries` now). The `clearRecentlyPlayedEntries` export is still used by the socket-broadcast handler in `register.ts` for non-initiator clients.

## 2026-05-15 (final pass) — Clear RP: optimistic-clear race + listener-throw isolation

### 1. Initiator divergence from optimistic clear
With the server now correctly emitting `cleared` then any deferred `inserted` during a clear, the UI's unconditional optimistic clear after the DELETE response was racing against those broadcasts. If the socket events arrived before the HTTP response, the initiator's `clearRecentlyPlayedEntries()` would re-empty the store and wipe the just-arrived `inserted:X`, leaving the initiator empty while server, disk, and other clients held `[X]`.

**Fix.** Optimistic clear now runs only when `socketStatusStore !== 'connected'`. Connected case trusts the broadcast (which is the source of truth and includes the post-drain inserts). Disconnected case still optimistically clears so the user sees their action — and reconnect-triggered `initializeStores()` re-fetches the post-clear state on socket recovery, so even the disconnected fallback converges.

### 2. Throwing `cleared` listener wedged service state
`emit("cleared")` is synchronous; a listener exception propagates back through `runClear()`, skipping `clearInFlight = false` and `pendingClear = null`. After that, every now-playing event would buffer forever and every subsequent `clear()` would coalesce into the dead rejected promise.

**Fix.** The post-`emit` reset moved into a `try/finally`; the `emit("cleared")` itself wrapped in its own `try/catch` (logged on listener throw). The drain still runs (via the `finally`), so even a misbehaving listener can't strand state.

### Tests
- Backend: throwing-listener resilience — `svc.on("cleared", () => { throw … })`, then `clear()` resolves, a follow-up insert *applies* (not buffered), and a follow-up `clear()` runs (not coalesced into the dead op).
- Frontend: connected-socket Clear button issues DELETE but does NOT optimistically empty (tile + entries intact post-fetch). Existing default-status (connecting) test renamed to clarify it exercises the disconnected-fallback path.
- Backend 97 → 98, UI 138 → 139. svelte-check 0/0, builds + lint clean.

## 2026-05-15 (still later) — Clear RP: coalesce overlapping clears

Single-flag linearization wasn't enough: two concurrent `clear()` calls (e.g. simultaneous DELETEs from two clients) each queued their own persist, and the first to finish would reset `clearInFlight`, drain the buffer, and broadcast `inserted` — only for the *second* `clear`'s delayed `cleared` to land afterwards. Clients ended up empty while server/disk still held the drained entry. Worse: `persist()` reads `this.entries` lazily, so the second clear's write could capture the post-drain state and persist the inserted entry as part of a "clear" write.

### Fix
A `pendingClear: Promise<void> | null` coalesces overlapping callers. The first `clear()` starts an internal `runClear()` and stores the resulting promise; subsequent callers return the *same* promise until it settles. So:
- One persist round-trip, one `cleared` broadcast, one drain.
- All overlapping callers (e.g. both DELETE responses) resolve from the same outcome — both 200 on success, both 500 on failure with one rollback.
- `pendingClear` is reset *before* drain so an `inserted`-listener-triggered clear during drain starts a fresh op rather than coalescing into the about-to-finish one.

### Tests (+2, 95 → 97 backend)
- "coalesces overlapping clear() calls into one persist + one cleared broadcast": two `svc.clear()` calls, asserts `a === b` (same promise) and exactly one `cleared` event.
- "overlapping clears + concurrent insert: one cleared broadcast, deferred insert after": exact reviewer scenario — two clears overlap while a now-playing event arrives; broadcast order is `["cleared", "inserted:MidClear"]`, final entries `["MidClear"]`, disk converges.

UI still 138. svelte-check 0/0, builds + lint clean.

## 2026-05-15 (later) — Clear RP: linearize concurrent inserts

Review caught the residual concurrency hole the durability fix didn't address: a `now-playing-updated` event arriving between `clear()`'s synchronous in-memory wipe and its awaited persist would mutate `this.entries` back to `[entry]`, fire `inserted` *before* `cleared`, and leave the world inconsistent — `persist()` reads `this.entries` lazily at write time, so the file ended up with the new entry while clients (having processed `inserted` then `cleared` in order) were empty. Rollback was worse: it overwrote the concurrently-inserted entry from memory after that entry had already been broadcast.

### Fix
`handleNowPlaying` is now a thin dispatcher: while `clearInFlight` is set, incoming events go into a `pendingDuringClear` buffer instead of mutating `this.entries`. `clear()` sets the flag before awaiting persist and clears it after emitting `cleared` (success) or restoring `previous` (failure); both paths then drain the buffer through the normal handler. The renamed `handleNowPlayingImpl` holds the unchanged insert logic.

This guarantees:
- The persist captures the truly-empty list, not a list a concurrent insert mutated mid-await.
- `cleared` is broadcast before any `inserted` for events that arrived during the clear window.
- On rollback, the deferred event applies to the *restored* list (not lost) and no `cleared` goes out.
- Server, disk, and clients converge on the same final state in every case.

### Tests (+2, 93 → 95 backend)
- "buffers a concurrent insert and broadcasts cleared before inserted": fires now-playing between `clear()` and `await clearPromise`; asserts buffer doesn't mutate entries pre-resolve, broadcast order is `["cleared", "inserted:MidClear"]`, final entries `["MidClear"]`, file converges to `[MidClear]`.
- "drains buffered inserts onto the rolled-back list when persist fails": same race against an unwritable path; asserts no `cleared` broadcast, both `inserted`s fire (the original `Before` and the deferred `MidClear`), final entries `["MidClear", "Before"]`.

UI tests still 138. svelte-check 0/0, builds + lint clean.

## 2026-05-15 — Clear RP: durable persist + load/clear race guard

Two review findings on the clear-all commit:

### 1. DELETE returned before the clear was durable
`clear()` called the fire-and-forget `schedulePersist()` and the route responded `200` immediately. A crash between response and write — or a write failure — would leave every client cleared (via the broadcast) but the file restored on restart. Now `clear()` is async, awaits persistence, and **only emits `cleared` once the write commits**. The DELETE route awaits the service call; the socket broadcast and the `200` only go out on durable success. On persist failure, the in-memory list is rolled back so it stays consistent with disk; the route surfaces a `500` so the user can retry.

The persist chain (`writeChain`) stays serialized, with errors swallowed so a failure doesn't poison the next queued write. A new internal `schedulePersistAsync()` returns the specific write's outcome for callers that need to await durability; `schedulePersist()` (used by `handleNowPlaying`'s fire-and-forget inserts) delegates and discards the promise.

### 2. Stale load could resurrect cleared entries
A reconnect-triggered `loadRecentlyPlayed()` GET in flight when a clear lands would `internalStore.set(...)` from its (pre-clear) response and overwrite the empty state. Added a `clearGen` counter, bumped by `clearRecentlyPlayedEntries` and `resetRecentlyPlayed`. Each load captures the generation at start; if it has advanced by the time the response arrives, the response is discarded (the post-clear state is the source of truth).

### Tests
- Backend: existing clear-emits-and-persists test now asserts that **by the time `await svc.clear()` resolves**, the file is already `[]` and `cleared` has fired. New rejection test uses an unwritable filepath (a regular file as a parent directory → `mkdir` ENOTDIR) — confirms `clear()` rejects, in-memory rolls back, no `cleared` broadcast.
- Frontend: stalled `loadRecentlyPlayed` resolves with stale data *after* a `clearRecentlyPlayedEntries` — store stays empty.
- Backend 92 → 93, UI 137 → 138. svelte-check 0/0, builds + lint clean.

## 2026-05-14 (later) — Recently Played: clear-all

A "Clear" action for the Recently Played list — it's local controller history, and users want to prune it.

### Round trip
- **Service**: `RecentlyPlayedService.clear()` — empties the list, persists the empty list (survives restart), emits a new `cleared` event. No-op-safe: clearing an empty list still persists + emits, which keeps the operation idempotent across clients without special-casing.
- **REST**: `DELETE /api/recently-played` → `service.clear()` → `{ entries: [] }`.
- **Socket**: `server.ts` wires `cleared` → `io.emit("recently-played-cleared")` so every client's list empties, not just the one that issued the DELETE.
- **Frontend client**: `clearRecentlyPlayed(fetch)` → `DELETE`.
- **Store**: `clearRecentlyPlayedEntries()` — sets `entries: []` but keeps `loaded: true` (the list is *known* empty, not unloaded, so the welcome view shows nothing rather than a loading state). Distinct from `resetRecentlyPlayed` which returns to the unloaded initial state.
- **Socket handler**: `recently-played-cleared` → `clearRecentlyPlayedEntries()`.
- **UI**: a "Clear" button in the Recently Played header. Its handler calls the REST DELETE *and* clears the store on success — so a disconnected socket doesn't leave the initiating client showing a stale list. The socket echo also clears the store; clearing twice is a harmless no-op, so the two paths converge.

### Tests
- Backend: `clear()` empties + emits `cleared` + persists `[]`; `clear()` on an empty list still emits. `DELETE /api/recently-played` route test.
- Frontend: store `clearRecentlyPlayedEntries` (empties, keeps `loaded`); page Clear-button test (calls DELETE, empties list, section disappears) + failure-path test (toast surfaced, list intact).
- Backend 89 → 92, UI 133 → 137. svelte-check 0/0, builds + lint clean.

## 2026-05-14 (later) — Recently Played: review follow-ups (key collision, load dedup, socket guard)

Three findings from the review of the bubble-to-front commit:

### 1. Dedupe key could collide on metadata containing `|`
`recentlyPlayedDedupeKey` joined free-form fields with `|`, so `title:"A|B" artist:"C"` and `title:"A" artist:"B|C"` produced the same key. Harmless when the key only *suppressed* within a window; dangerous now that it *removes/bubbles* — a collision would delete the wrong entry. Switched to `JSON.stringify([...])` tuple serialization. Also fixes a subtler case: a missing field (`null`) vs. an empty string (`""`) are now distinct keys.

### 2. Legacy duplicates not cleaned on load
`loadFromDisk` loaded persisted entries as-is. A `recently-played.json` written before move-to-front dedup could hold duplicates that would surface via `/api/recently-played` until each track happened to replay. Added `dedupeRecentlyPlayed()` (keep-first-occurrence, since the file is newest-first) and run it in `loadFromDisk`. The REST endpoint returns `getEntries()`, so a deduped load means the REST response is clean too — no separate frontend REST-path dedup needed.

### 3. Socket idempotence guard too loose
`appendRecentlyPlayedFromSocket` treated `played_at + zone_id` as enough to identify a duplicate broadcast. Backend timestamps come from millisecond `Date.now()`; two fast track changes in the same zone within one millisecond would make the guard wrongly drop the second (distinct) track. Guard now also compares the dedupe key.

### Tests
- New `src/shared/__tests__/recentlyPlayed.test.ts` — key collision (`|` in metadata), null-vs-empty-string, field-level distinction, `dedupeRecentlyPlayed` first-occurrence/no-op/empty.
- Backend: `loadFromDisk` dedup test (legacy file with a duplicate → collapsed, newest kept).
- Frontend: two distinct tracks sharing `played_at` + `zone_id` both survive the idempotence guard.
- Backend 81 → 89, UI 132 → 133. svelte-check 0/0, builds + lint clean.

## 2026-05-14 — Recently Played: replays bubble to the top instead of duplicating

### The bug
Deployed `RecentlyPlayedService` showed duplicate entries: play track X, play a few other tracks, play X again — and X appeared twice. The original design was a *chronological play log* with a noise-suppression window: `shouldSuppress` dropped same-track re-emits within `max(suppressionWindowMs=30s, duration + 5s grace)`. A genuine replay *outside* that window was treated as a legitimately distinct entry and `unshift`ed — producing the duplicate. (A 4-minute song has a ~245s window; play it, listen to a couple more, replay it → duplicate.)

The user's expectation — and the correct model — is move-to-front: a replay bubbles to the top, the list holds at most one entry per track.

### Why the noise window has to stay
`now-playing-updated` fires on *every* `zones_changed` (pause, seek, volume, queue edit), not just track changes, so the same track's event arrives many times during one play. The wide noise window is what filters that. It can't distinguish a within-window *restart* from a within-window *re-emit* — Roon's event stream gives us nothing to tell them apart — so a quick restart still collapses with the noise. Deliberate trade-off, documented in `shouldSuppress`.

### The fix
`handleNowPlaying`: after `shouldSuppress` returns false (brand-new track *or* a genuine replay past the window), `filter` out any prior entry with the same dedupe key, then `unshift`. `filter` (not splice-one) also cleans up legacy duplicates left by the old behavior.

Dedupe key extracted to `src/shared/recentlyPlayed.ts` (`recentlyPlayedDedupeKey`) — `title|artist|album|duration|image_key`, deliberately excluding `zone_id` / `played_at`. Shared so the backend service and the frontend store agree on what a duplicate is.

Frontend `appendRecentlyPlayedFromSocket` mirrors the bubble: the `recently-played-inserted` socket event still carries one entry, and the store now drops any prior same-key entry before unshifting. Without this the server would dedup but the client would still show a stale duplicate.

### Tests
- Backend: two tests that asserted duplicate-on-replay rewritten to assert the bubble (one entry, fresh `played_at`, `inserted` re-emitted). New test for the reported scenario: play A, play B, replay A → `["A", "B"]`. (80 → 81.)
- Frontend: new store test — a socket replay of A (even from a different zone) drops the prior A and unshifts the fresh one. (131 → 132.)

### Validation
svelte-check 0/0, both builds clean, lint clean.

## 2026-05-13 (later) — Search result rendering unified with browse layouts

Search results used to render in a separate panel with custom `.result-item` cards (52×52 art, grid of `minmax(190px, 1fr)`) that looked nothing like the surrounding browse pane (large 320×320 cards on `minmax(180px, 1fr)`, or numbered track rows). Long-deferred TODO item; this lands the visual unification.

### Refactor
Extracted two reusable Svelte components from `library/+page.svelte`:
- `ui/src/lib/components/ItemGrid.svelte` — card-grid layout for albums/artists/etc.
- `ui/src/lib/components/TrackList.svelte` — numbered rows with Play / More buttons + now-playing ♫ indicator.

Each was extracted in its own commit (`7a457cb`, `df79611`) with zero behavior change on the library view. `Search.svelte` was then refactored to dispatch each result-type group:
- `track` → `TrackList`
- everything else (artist / album / composer / label / playlist / genre / radio / unknown) → `ItemGrid`

Per-group pagination + "Show more X" chrome kept; only the inner item rendering changed. ~110 lines of custom Search CSS deleted.

### UX note
Clicking a search result formerly worked anywhere on the row (whole row was a button). For non-track results, this is unchanged (`ItemGrid` wraps each card in a button). For tracks, clicking now requires the ▶ play button rather than the row body. The play button has `aria-label="Play <title>"` and is always visible on touch.

### Cleanup (post /simplify review)
- Pulled `trackTitle` / `trackNum` into a shared `$lib/trackTitle.ts`; both `+page.svelte` (for `isNowPlayingTrack` title matching) and `TrackList.svelte` now use it.
- Added keyed `{#each}` to both components so list churn doesn't re-mount unchanged rows / restart entrance animations.
- Deduped a per-row `trackTitle(item.title)` double call via `{@const displayTitle}`.
- Dropped a YAGNI `imageSize` prop from `ItemGrid`.

### Tests
- Three search-track tests in `library/__tests__/page.test.ts` updated: search-track click now targets `aria-label="Play <title>"` (was `getByText(title).closest('button')`, which no longer reaches a button under TrackList).
- No new tests; the unification is visual and the existing search-result tests cover the click → quickPlay path.

### Validation
- UI: 130 tests pass.
- svelte-check 0/0, lint clean, both builds clean.
- **Visual parity NOT yet verified against a live Roon Core.** Search-result panel now uses the same large card style as the browse pane, which may make the panel feel larger; intentional.

## 2026-05-13 — Layout test harness (first pass)

`+layout.svelte` (1226 lines) had zero tests despite being the home of every cross-route navigation surface — rail clicks, header search, play-bar links, mobile hamburger. The recent R7 finding (where `resolveAndNavigate` had dropped the `searchQuery` argument to `pushHistory`) was caught by static review only; a layout-level test would have failed on it.

### Added
- `ui/src/test/app-stubs/navigation.ts` + `stores.ts` — minimal stubs for `$app/navigation` / `$app/stores` so vite's import resolver doesn't fail on `+layout.svelte`. Existing `$app/environment` stub was already in place.
- `ui/src/routes/__tests__/layout.test.ts` — 5 tests covering the four explicit residual-risk paths from TODO.md:
  - **Header search submit** routes through `pendingSearchStore` + `goto('/library')` (R7 fix path).
  - **Mobile hamburger** opens the sidebar; clicking the scrim closes it.
  - **Explore rail click on /library** label-walks via `apiBrowse`, pushes history with breadcrumbs, no `goto`.
  - **Explore rail click from /queue** triggers `goto('/library')` after the walk.
  - **Play-bar artist click** (R7 regression guard) — asserts `searchQuery` lands on the persisted history state, the breadcrumb carries `itemType: 'artist'`, and `browseStore.hierarchy` switches to `'search'`.

### Mocking approach
The layout pulls in socket / API / explore-rail / store-init plumbing. Tests use `vi.mock` to:
- intercept `$lib/api/client` (so `apiBrowse` is a controllable spy);
- replace `$lib/stores/exploreRailStore` with a test-controlled writable (the real resolver is covered by `exploreRailStore.test.ts`);
- override `$lib/stores`' `initializeStores` to a no-op (one shared mock instead of three per-store loader stubs);
- swap `$app/navigation`'s `goto` and `$app/stores`' `page` for spies/writables.

Children snippet uses `createRawSnippet` so the non-optional `{@render children()}` in the layout doesn't throw at mount.

### Validation
- Backend: 80 tests.
- UI: 125 → 130 tests.
- svelte-check 0/0, both builds clean, lint clean.

## 2026-05-12 (R10) — Recently Played quickPlay must not record history under stale query

Recently Played calls `quickPlay({hierarchy:'search', resetSearch:false})`. If the action-list lookup for the matched track returns no playable action (rare for tracks but possible), `quickPlay` falls back to a `browse()` that records history. `browse()` writes `$browseStore.lastSearchQuery` into the history entry — and after R9, that query is deliberately preserved as the user's *prior visible search* (e.g., "beatles"), not the Recently Played title. A future `restoreBrowse` would then re-seed the wrong search session and try to walk the breadcrumb in the wrong results.

### Fix
Added a `playOnly?: boolean` option to `quickPlay`. When true, the no-play-action path surfaces a feedback toast (`Couldn't play "<title>".`) instead of falling back to an action-menu browse. Recently Played passes `playOnly: true`; browse-hierarchy and search-result quickPlay continue using the existing fallback (their lastSearchQuery is meaningful for those flows).

### Test (+1)
- "matched track with no play action: toast + no fallback browse + prior search preserved" — seed prior "beatles" search, action lookup returns no playable action, assert: no `browse:browse` emit, empty history, prior search state intact, feedback toast surfaced.

### Validation
- Backend: 80 tests.
- UI: 124 → 125 tests.
- svelte-check 0/0, both builds clean, lint clean.

## 2026-05-12 (later, R9) — Recently Played must not touch search-panel state

The R8 P2 fix ("clear searchLoading in finally") was the wrong fix. R9 review caught that `setSearchLoading(entry.title)` itself was wrong: it updates `lastSearchQuery` to the Recently Played title while leaving `lastSearch` (the actual results) alone. If the user had previously searched "beatles" and was looking at those results, clicking Recently Played "Hey Jude" would relabel the visible Beatles results as results for "Hey Jude". The Search component renders `lastSearch` with `lastSearchQuery`, and downstream code re-seeds the search session using `$browseStore.lastSearchQuery`, so subsequent clicks on the mislabeled results could re-query the Recently Played title instead of the original search.

### Fix
- Removed `setSearchLoading(entry.title)` from `handleRecentlyPlayedClick`. The function re-seeds Roon's server-side search session as a side-effect of the resolver, but `browseStore` search-panel state (`lastSearch` / `lastSearchQuery` / `searchLoading`) is user-facing UI state that belongs to the actual Search UI. Per-tile feedback already exists via `recentlyPlayedClickInFlight` (bound to the tile's `disabled` attribute).
- Removed the paired `clearSearchLoading()` call in `finally` (added in R8 P2).
- Deleted the `clearSearchLoading()` helper from `browseStore` — no remaining callers.

### Tests
Replaced the two R8 P2 tests (which were vacuously true after this fix) with R9 preservation tests:
- "preserves prior search-panel state on no-match (does not relabel old results)" — seed prior search → click RP tile → no match → assert `lastSearchQuery === 'beatles'`, `lastSearch` is the prior result array (identity), `searchLoading` unchanged.
- "preserves prior search-panel state on successful quickPlay (does not relabel old results)" — same seed → click → match → Play Now → assert all three preserved.

### Validation
- Backend: 80 tests.
- UI: 124 tests (net unchanged: −2 vacuous + 2 new).
- svelte-check 0/0, both builds clean, lint clean.

## 2026-05-12 (later) — Disconnected quickPlay-fallback + Recently Played searchLoading leak

Round 8 caught two more bugs in the same family.

### 1. `quickPlay()` search-track fallback resetHistory before bailed emit
When a search-result track click landed on a row whose action lookup returned no playable action, the fallback ran `resetHistory()` (because `resetSearch=true` means "new navigation thread") and then `browse()`. If the socket dropped between the REST action lookup and the fallback emit, `browse()` bailed on its readiness check but the prior history was already wiped. Fix: explicit readiness check before `resetHistory()` in the fallback, matching the pattern in `navigateSearchResult` / `resolveAlbumOrNavigate`.

### 2. Recently Played click leaked `searchLoading: true`
`handleRecentlyPlayedClick` calls `setSearchLoading(entry.title)` after the REST search seed, but nothing in the downstream paths clears it — the no-match path returns, and the matched-track quickPlay's Play Now execute doesn't touch `searchLoading`. Result: a successful Recently Played click leaves the search panel stuck on "Searching…" indefinitely. Fix: added `clearSearchLoading()` helper to `browseStore` and clear in the function's `finally` block, covering success / no-match / thrown-error paths uniformly.

### Tests (+2 net)
- "disconnected search-track quickPlay fallback preserves existing history and emits nothing" — disconnect between freshen and action lookup → no `resetHistory`, no emit, prior history intact, "Not connected" toast.
- "clears searchLoading after a successful quickPlay so the search panel does not stay stuck" — full happy path through Play Now, asserts `browseStore.searchLoading === false` after the chain.
- Existing "pushes a feedback toast when no track in library matches the entry" extended with a `searchLoading === false` assertion for the no-match path.

### Validation
- Backend: 80 tests.
- UI: 122 → 124 tests.
- svelte-check 0/0, both builds clean, lint clean.

## 2026-05-12 — Disconnected Forward + resolver-fallback

Round 7 caught two more instances of the same state-before-check bug class fixed in rounds 5 and 6.

### 1. `forward()` ghost history entry
`forward()` called `popForward()` (which moves an entry from the forward stack into history) and then `browse()`. If the socket was disconnected, `browse()` bailed on its readiness check, leaving a ghost history entry pointing at a destination the user never reached. Fix: readiness check runs BEFORE `popForward()` — matches the pattern in `pop()` and `browse()`.

### 2. `resolveAlbumOrNavigate()` stuck loading on disconnected fallback
The album-by-artist resolver sets `loading: true` up front (so the spinner shows during the resolver search). On resolver miss or thrown error it falls back to `navigate(item)` → `browse()`. If the socket was disconnected at the fallback, `browse()` bailed without touching loading, leaving the pane stuck on "Loading library data…". Fix: explicit `clearBrowseLoading()` before each `navigate(item)` fallback.

### Tests (+2)
- "disconnected Forward with non-empty forward stack preserves both stacks and emits nothing" — emit skipped, history empty, forward stack untouched (no ghost promotion).
- "disconnected 'album by artist' fallback clears loading and emits nothing" — resolver search runs (HTTP), fallback path triggers, loading=false, no emit, no history entry, "Not connected" toast.

### Validation
- Backend: 80 tests.
- UI: 120 → 122 tests.
- svelte-check 0/0, both builds clean, lint clean.

## 2026-05-11 — Disconnected-click readiness-first

Round 6 caught three more bugs that the round-5 "clear loading + skip history" fix didn't fully address.

### 1. Cross-hierarchy state corruption (e.g. browse → search-result while disconnected)
`navigateSearchResult` and `resolveAlbumOrNavigate` both called `setSearchLoading('search') + resetHistory()` BEFORE calling `browse()`. When `browse()` then bailed because the socket was disconnected, the hierarchy was already switched to `'search'` and the prior history was already cleared. The store ended up with `hierarchy: 'search'` over a stale browse result — the next click would emit browse-session itemKeys against the search session.

Fix: readiness-check-first pattern. Both `navigateSearchResult` and `resolveAlbumOrNavigate` now check `socket.connected` after the REST freshen/resolve but BEFORE `resetHistory`/hierarchy commit. `browse()` itself also checks the socket up front so it never optimistically sets hierarchy. The whole `emitBrowse` / `emitIfConnected` round-5 dance is replaced inside `browse()` and `pop()` with direct connection checks + direct `socket.emit` — equivalent fail-fast behavior with no state-mutation gap.

### 2. `pop()` rollback could promote stale forward entry into history
The rollback `popForward()` ran unconditionally on failed emit, even when `popHistory()` had been a no-op (defensive: Back triggered with empty history). A stale forward entry would then incorrectly land in history. Fix: readiness-first means `pop()` no longer needs the rollback path — if disconnected, we bail before touching state.

### 3. Test fixture leak
`fakeSocket.connected` wasn't reset in `beforeEach`. A disconnect-path test that crashed before its own restore would leave the disconnected state for later tests. Fix: `beforeEach` now resets `fakeSocket.connected = true`.

### Tests (+2)
- "disconnected click on a search result preserves prior browse hierarchy and history" — cross-hierarchy case: existing browse state + disconnected click on search result → emit skipped, hierarchy still `browse`, prior history intact, loading cleared, "Not connected" toast.
- "disconnected Back with empty history + non-empty forward does NOT pull stale forward into history" — defensive case: forward stack with stale entry, history empty, disconnected Back → no emit, history and forward both untouched.

### Validation
- Backend: 80 tests.
- UI: 118 → 120 tests.
- svelte-check 0/0, both builds clean, lint clean.

## 2026-05-11 — Disconnected browse: clear loading + don't mutate history

Round-3 review caught a real bug in the round-2 fix. `emitIfConnected` returned `false` on disconnect, but `emitBrowse` ignored the return value. The chain was:

1. User clicks a list item.
2. `browse()` sets loading optimistically.
3. `emitBrowse()` calls `emitIfConnected()` which skips the emit because `socket.connected === false`. Returns `false`.
4. `browse()` ignored that; called `pushHistory()`.
5. Result: pane stuck on "Loading…" forever, with a ghost history entry for navigation that never happened.

### Fix
- `emitBrowse(event, payload)` now returns `boolean`.
- `browse()` checks the return; on `false`, calls `clearBrowseLoading()` and skips `pushHistory`. The "Not connected to server" feedback toast was already pushed by `emitIfConnected`.
- `pop()` also fixed: it pops history *before* emitting (so the forward stack has the popped step). If the emit fails, we now `popForward()` to undo the history mutation, then `clearBrowseLoading()`.
- New `clearBrowseLoading()` in `browseStore` — clears the loading flag without touching `current` or `hierarchy`.

### Test (+1)
Library page test: socket present but `connected: false`. Clicking a list item must NOT emit, must clear loading, must NOT mutate history, and must surface a "Not connected" toast.

### Validation
- Backend: 80 tests (unchanged).
- UI: 117 → 118 tests.
- svelte-check 0/0, both builds clean, lint clean.

## 2026-05-11 — Code review round 2: Docker git, pageSize, image keys, browse emits

Four follow-ups from the next-round review of `71a6a43 / fb5eb93 / 31b9130`. All real misses.

### 1. Docker build still broke without git (lockfile fix wasn't enough)
The previous patch swapped `git+ssh://` → `git+https://` so anonymous fetch worked. But `npm ci` still shells out to `git` to clone the repo, and the `node:22-alpine` base image has no git binary. Result: Docker builds still failed on the Roon deps.
Fix: `RUN apk add --no-cache git` in the backend-build stage and the production-runtime stage. The frontend stage doesn't need git (no Roon deps).

### 2. `BrowseService.loadItemsForList` still honored unbounded pageSize
The MAX_COUNT clamp in chunk B covered the `count` param of `load.options`, but the internal `loadItemsForList` helper still used `options.pageSize` (which can be `Infinity`) to decide how many items to chain-load. A hostile or buggy client could ask the backend to do many sequential round-trips against a huge Roon list.
Fix: clamp the computed page size to `MAX_COUNT (5000)`. `Infinity` and oversized values silently snap. Test added: 10k-item list + `pageSize: Infinity` results in exactly 50 page calls × 100 items = 5000 loaded.

### 3. Search.svelte still interpolated raw image keys
Chunk B switched four call sites to `imageUrl()` but missed the search-result tile. Roon's `image_key` is opaque and may contain reserved URL characters (`/`, `?`, `#`, `%`).
Fix: Search.svelte uses `imageUrl(result.imageKey, { width, height })`.

### 4. Browse/search raw `socket.emit` calls still buffered while disconnected
`emitWithAck` fail-fast (chunk A) covered ack-based commands. Browse/search use fire-and-forget emits — they don't take an ack; the response comes back as a server-broadcast `browse-result` / `search-result`. Those raw `socket.emit` calls bypassed the connected check. socket.io still buffered + replayed them on reconnect — less dangerous than transport replay but stale browse results landing on whatever the user has navigated to is bad UX.
Fix: added `emitIfConnected(socket, event, payload, feedback?)` in `$lib/socket/emit.ts` — checks `socket.connected`, returns false + pushes feedback toast if disconnected. Updated four call sites: Search.svelte's submit, Library's pendingSearch effect, Library's `emitBrowse` helper, Library's `searchArtist`. 4 new tests.

### Validation
- Backend: 79 → 80 (+1 pageSize clamp).
- UI: 113 → 117 (+4 emitIfConnected).
- svelte-check 0/0, both builds clean, lint clean.

## 2026-05-11 — Volume slider rAF throttle (#7)

The play-bar volume slider was emitting `transport:volume` on every `input` event — dragging it produced one socket call per pixel of mouse movement, plus a corresponding ack-toast storm if the connection blipped.

Fix: rAF coalesce. The slider stores the latest value in a `pendingVolume` ref; the first `input` schedules a `requestAnimationFrame` callback; the callback emits `pendingVolume` and clears. Subsequent `input` events within the frame just update `pendingVolume`. Result: max ~60 emits/sec regardless of input rate, and the final drag-release value always lands.

The incremental `±` buttons stay as direct `sendVolume()` calls — they're discrete clicks, not drag.

UI tests still 113. svelte-check 0/0, build clean.

## 2026-05-11 — Code review chunk B: defensive cleanup

Four medium-severity issues from the same review.

### 4. API client lost non-JSON error responses
`request()` called `response.json()` first and `response.text()` in the catch — but `json()` consumes the body, so the follow-up `text()` threw too and callers lost the original error. Changed to read body once as text, then parse JSON from that string. Non-JSON responses (HTML proxy errors, plain-text 502s) now surface their content as the ApiError message.

### 5. Browse inputs were under-validated
- REST routes and socket handlers only checked `hierarchy` was present. Negative offsets, very large `count`/`pageSize`, and arbitrary hierarchy strings forwarded straight to Roon, which returned generic errors.
- Added `ALLOWED_BROWSE_HIERARCHIES` allowlist in `src/server/util.ts` (mirrors the documented + probed set: browse, search, playlists, settings, internet_radio, albums, artists, genres, composers, tracks). REST + socket browse handlers reject unknown hierarchies with `400` / socket error before reaching the service.
- Added `BrowseService.clamp()` for numeric inputs: offset clamped to `[0, 1_000_000]`; count clamped to `[1, 5_000]` with `PAGE_SIZE` default; pop levels clamped to `[1, 32]`. Out-of-range values silently snap to safe values rather than 400ing.

### 6. Image keys not URL-safe
Roon's `image_key` is opaque and may legally contain `/`, `?`, `#`, `%`. The UI was interpolating raw keys into URL path segments at four call sites. Added a centralized `imageUrl(key, { width, height })` helper that uses `encodeURIComponent`. All call sites switched.

### 8. RECENTLY_PLAYED_* env vars undocumented
The vars were parsed in `env.ts` but missing from README, `.env.example`, and the three installer templates (Linux/macOS/Windows). Added everywhere; macOS plist gets it in `EnvironmentVariables`, Windows NSSM gets it in `AppEnvironmentExtra`. README docs both knobs.

### Validation
- Backend: 79 tests passing (no new tests this round; the changes are defensive validation/encoding with low surface area).
- UI: 113 tests passing.
- svelte-check 0/0, both builds clean, lint clean.

## 2026-05-11 — Code review chunk A: token persistence, lockfile, socket buffering

GPT review caught three high-severity issues. All real bugs.

### 1. Token persistence was broken (worked by accident on systemd, lost on Docker restart)

`RoonClient` passed `token` and `save_config` options to node-roon-api. The library actually uses `get_persisted_state` / `set_persisted_state` callbacks; if those aren't supplied, it falls back to `save_config("roonstate", state)` which writes a hardcoded `config.json` next to the process cwd. Our `save_config` callback in options was never called. Result:

- On systemd: `WorkingDirectory=/opt/roon-controller`, so `config.json` landed there and pairing did persist — but at the wrong path. `ROON_TOKEN_PATH` was a no-op.
- On Docker: the cwd `config.json` was outside the documented `./config` volume mount, so pairing was lost on container recreation despite README claims to the contrary.

Fix: provide proper `get_persisted_state` (read JSON at `tokenPath`) and `set_persisted_state` (atomic write to `tokenPath` with mode `0o600`). One-time migration: if a pre-existing `config.json` is found in cwd at startup AND `tokenPath` doesn't exist, copy it over and remove the cwd file. 9 new tests.

### 2. `package-lock.json` had `git+ssh://` URLs for Roon deps

`npm ci` in a clean Docker image (`node:22-alpine`) has no git/ssh tooling and no GitHub SSH key, so fresh installs would fail. Swapped lockfile + `package.json` to `git+https://github.com/roonlabs/...git`. Verified anonymous fetch works in a tmp scratch.

### 3. Socket commands buffered & could replay after reconnect

`emitWithAck` called `socket.emit()` without checking `socket.connected`. socket.io buffers emits made while disconnected and flushes on reconnect. For transport commands (play/pause/seek/volume/queue), that's wrong: a play issued + UI-timed-out 30s ago shouldn't fire when the server comes back. Now: if `!socket.connected`, reject synchronously with "Not connected to server" + feedback toast; never call `socket.emit()` so nothing gets buffered. 3 new tests.

### Validation
- Backend: 70 → 79 tests passing.
- UI: 110 → 113 tests passing.
- svelte-check 0/0, both builds clean, lint clean.

## 2026-05-11 — Browse-rooted restore via breadcrumbs

User saw `⚠ Browse Error — Restore stopped at level 0: [BrowseService] browse failed` on every page load after a redeploy. Browse-hierarchy itemKeys are session-scoped exactly like search keys; a Roon Core or controller restart invalidates them all. Phase A taught the search-rooted restore to use breadcrumbs to find fresh keys, but the browse-rooted path was still trying raw stale keys — first step always failed.

### Fix
Browse-rooted `restoreBrowse` now mirrors the search-rooted breadcrumb walk:
- For each step, if a breadcrumb is present, find the next item by title in the freshly-loaded current items, drill the FRESH key.
- If no breadcrumb (legacy v2 entry), fall back to the raw itemKey path. Same failure mode as before for those.
- After the walk, `replaceHistory(rebuilt)` rewrites the persisted stack with fresh keys so subsequent Forward (after Back) doesn't send Roon stale ones.
- If nothing resolved (first step failed), clear history and reset `browseStore` so the page shows the welcome view, not the rail-mirroring browse root + persistent toast.

R-N follow-up: the new breadcrumb-walk path now also preserves `step.multiSessionKey` (defensive parity with the search-rooted and fallback paths; today's main browse history uses the default session, so this is undefined in practice).

### Tests (+2 from the prior 108)
- Stale-key restore via breadcrumb: walk uses fresh itemKeys, never the persisted stale ones; persisted history is rewritten with fresh keys.
- Fully-failed restore: history cleared, `browseStore` reset, welcome rendered (no rail-mirror, no persistent error toast).

Existing "records but does not crash when a replay step fails" still passes — that test uses no-breadcrumb steps and asserts partial restore works.

### Validation
- Backend: 70 tests passing.
- UI: 110 tests passing.
- svelte-check 0/0, build clean, lint clean.

## 2026-05-08 — Welcome / track-list / play-bar polish round

Six fixes from a single round of UX feedback after the Recently Played deploy, plus three corrections from a static review of the polish patch:

### A. quickPlay restored two levels too few
`popInternal` now uses `levels: 2`. quickPlay drills twice (track action list → execute Play Now), so a single pop left the user one level deeper than the album. Roon clamps to root if the level count exceeds the stack, so this is safe in shallower contexts.

### B. Now-playing indicator on the album track list
Track rows now compare against the selected zone's `now_playing` (stripped title equality + artist substring on subtitle). The matched row gets a pulsing ♫ glyph in place of the track number, accent-colored title, and a soft accent gradient.

### C. Library/Tracks and playlist contents rendered as pill buttons
Roon returns these as 100s of `action_list` rows with no `itemType` and non-numeric titles, so the prior `isTrackItem` heuristic refused to classify them as tracks.

- Added a size-threshold fallback to `isTrackList`: if every item is action_list AND the list has ≥ 5 items, treat as a track list. Keeps small Work-style pages out of the track layout while catching the 100s-of-rows tracks/playlists case.
- **R-N follow-up bug**: the size-threshold mode set `isTrackList = true` but `trackItems` still filtered by `isTrackItem()`, so all rows fell into `pageActions`. Result: empty `<ol>` plus a pile of pill buttons. Added `inferredAllTracks` mode — when the size threshold is what made the list qualify (no item passed `isTrackItem`), every action_list row IS a track row; `pageActions` is empty. Test added with 7 untyped non-numeric rows.

### D + E. Play-bar artist/title links now resolve to entity pages
Both call `resolveAndNavigate` which searches Roon's search hierarchy for the input, matches the first item by `itemType` + title (and subtitle-contains-artist for albums), drills into it, and pushes history with a breadcrumb so route remount can replay. Falls back to raw search results on miss so the user always lands somewhere useful.

- **R-N follow-up bug**: `resolveAndNavigate` pushed search-rooted history but passed `undefined` as the searchQuery to `pushHistory`. Persisted history would have `searchQuery: null` — Phase A's `restoreBrowse` would then discard the drill on remount as "search history with no query." Fix: call `setSearchLoading(input)` first and pass `input` to `pushHistory` as the searchQuery.
- **R-N P3**: The matcher used strict `=== 'album'` / `=== 'artist'`, missing Roon's plural variants (`albums`, `artists`). Added `itemTypeMatches(actual, expectedSingular)` that accepts both forms and is case-insensitive — same defensive style as `BrowseService.inferSearchType`.

### F. Header search + theme toggle right-aligned
`header-search` dropped `flex: 1`; now `flex: 0 0 auto` with `margin-left: auto` so it sits to the right alongside the theme toggle. Hamburger and back/home/forward stay on the left.

### Bonus. Recently Played as a single horizontal-scroll row
Was a multi-row wrapping grid; now a single flex row with `overflow-x: auto`, scroll-snap, and styled scrollbar.

### Tests
- 1 new in track-list classification (inferred large untyped track list).
- 4 prior recently-played-tile tests confirmed still passing.
- Total UI: 106 → 107. Backend unchanged at 67. svelte-check 0/0, build clean, lint clean.

### R-N+1 follow-up (breadcrumb itemType drift)
- `resolveAndNavigate` was storing `opts.breadcrumb.itemType` (the *expected* singular like `'album'`) in the persisted breadcrumb, not the actual matched Roon `itemType`. If Roon returned the result with a plural/capitalized variant (`'Albums'`), the live click worked — but on remount, `matchBreadcrumb` did a strict `===` comparison and the breadcrumb wouldn't match the live result anymore. Two fixes:
  1. Persist `match.itemType ?? opts.breadcrumb.itemType` so the breadcrumb records what Roon actually said.
  2. `matchBreadcrumb` now uses a singular/plural/case-tolerant compare (same normalizer style as `BrowseService.inferSearchType` and the play-bar matcher), so old persisted entries with normalized values still resolve correctly.
- Test added: a breadcrumb persisted with `'album'` matches a live result with `itemType: 'Albums'`.

### Known gap (deferred)
- Layout-level integration tests still don't exist (R7 residual risk). Two regressions in this batch (P2 `searchQuery` not passed, P-N+1 breadcrumb itemType drift) were caught only by static review. A `+layout.svelte` test harness is the right fix; tracking in TODO.
- Search-result rendering consistency (#5 from the original ask): search results panel uses its own grouped layout, browse views use list/grid/track-list. Unifying is a meaningful refactor; deferred to its own PR.

## 2026-05-08 — Recently Played, locally tracked

User flagged "Recently Played" as a priority for the welcome view. Public Roon extension API doesn't expose recent-activity history (confirmed via the full hierarchy probe + reading the RoonApiBrowse docs). Native Roon's "Home" page uses a private service that third-party clients can't reach.

What we CAN do: track plays locally as our backend observes them via `now-playing-updated` events, and surface that on the welcome view honestly labelled "Recently played on this controller." Caveat is real but the feature works for the common case where the controller's been running and watching.

### Backend — `RecentlyPlayedService`
- New service under `src/core/recently-played/`. Subscribes to `TransportService.on('now-playing-updated')`, normalizes display fields (`title / artist / album / duration / image_key / zone_id / zone_name / played_at`), persists to `data/recently-played.json` with atomic writes (write-`.tmp` + rename).
- Dedupes via `title|artist|album|duration|image_key` against any entry within an effective window of `max(30s, track_duration + 5s grace)`. Catches three patterns: Roon's chatty mid-play re-emits (seek/pause/metadata refresh) regardless of how late they arrive, group-play artifacts (zones grouped together emit per zone within milliseconds — collapses to one entry, no zone discriminator), and multi-zone interleaving (zone A plays X, zone B plays Y, A re-emits X — head-only check would miss; we scan all entries within the window).
- Caps at 50 entries (configurable via `RECENTLY_PLAYED_CAP`).
- Recovers from corrupt JSON (logs warning, starts empty), wrong-shape JSON (`{}` instead of `[]`), and ENOENT (first run). Plausibility filter at load time drops malformed entries.
- Emits `inserted` event ONLY when a new entry is actually added — not on suppressed duplicates. `server.ts` wires this to a socket broadcast (`recently-played-inserted`) so clients get live appends without seek noise.
- `setZoneNameLookup(fn)` lets the service stamp the zone's current display name onto each entry; `server.ts` wires this to `transportService.getZones()` so the name is captured at insert time even if the zone is renamed/removed later.
- New env knobs: `RECENTLY_PLAYED_PATH` (default `./data/recently-played.json`), `RECENTLY_PLAYED_CAP` (default 50, capped at 1000).

### REST + socket
- `GET /api/recently-played` → `{ entries: RecentlyPlayedEntry[] }`. Returns the in-memory list, newest first.
- Socket event `recently-played-inserted` fires per insert. Clients dedupe defensively by `(played_at, zone_id)` in case of re-broadcast.

### UI
- New `recentlyPlayedStore`. `loadRecentlyPlayed(fetch)` runs from `initializeStores` at layout mount (alongside core + zones). `appendRecentlyPlayedFromSocket` handles live updates; capped at 50 client-side too.
- Welcome view grew a "Recently played" section below the stat tiles, only rendered when there's at least one entry. 12-tile grid with artwork + title + artist + zone name. Honest section eyebrow: "on this controller".
- Section hides cleanly on first run (no entries yet), reappears as soon as something plays.

### Tests
- **18 backend tests** for the service: insert, window-collapse, window-expire (with duration:0 to exercise the configured floor), cross-zone group-play collapse, mid-play duration-window re-emit suppression, post-duration legitimate replay, multi-zone interleaved dedupe (head was different track), null payload handling, `inserted` only fires on real inserts, cap enforcement, persisted-file load, atomic write (no leftover `.tmp`), corrupt-JSON recovery, wrong-shape recovery, plausibility filter on load, ENOENT-graceful start, zone-name stamping, `stop()` detaches.
- **1 new app-routing test** for `GET /api/recently-played` end-to-end.
- **5 new UI store tests**: REST load, REST-failure preserves existing entries, socket-append unshifts, socket-append dedupes head-match, client-side cap at 50.
- Total: backend 51 → 67, UI 97 → 102. svelte-check 0/0, build clean, lint clean.

### Known scope
- Plays during service downtime aren't captured. UI labels accordingly.
- Persisted file lives next to other runtime data (`./data/...`). systemd unit's `WorkingDirectory=/opt/roon-controller` and `data/` is gitignored.
- Image keys are session-scoped — if the persisted list outlives a Roon Core restart, older artwork URLs may 404. The image route already returns a placeholder on miss, so this degrades gracefully.

## 2026-05-07 — PR1 polish round 2: Home → welcome, Settings on rail, indented tree

User feedback after the locked-panes redeploy:

1. **Home button now goes to the welcome view, not the Explore root.** The rail already mirrors the Explore root entries, so popping to root on Home just duplicated them again. `resetRoot()` now calls `resetHistory()` + `resetBrowse()` and the welcome placeholder renders. No socket emit, no apiBrowse — just clear local state.

2. **Settings surfaced on the sidebar.** Removed from `EXCLUDED_LEVEL_0` per user request. Drilling Settings (`Profile`, `Display Settings`) hits browse-only data; we don't drive its actions but the user wanted it visible. Future PR can wire specific Settings flows if any of them prove useful through the public API.

3. **Library tree indent.** Library is rendered as a section header with its children below; the children are now indented (`padding-left: 1.6rem`) so the parent-child relationship is unambiguous. Top-level entries (Playlists / Genres / My Live Radio / Settings) stay at the standard left padding via `.rail-link.top`.

4. **Recently Played / Added** — flagged by user as a priority for the welcome view. The public Roon extension API doesn't expose these as discoverable nodes at the level-0 / level-1 layers we've captured. Ran the conversation through whether deeper levels (Library/Albums sub-views) might surface them; verdict was "needs `--include-content-samples` capture against the live Core to confirm." Held pending user direction on whether to run that capture (artifact gitignored).

### Tests
- Home test rewritten: now asserts no socket emit, history cleared, welcome view visible.
- Rail store test updated: Settings expected in the rail; matched against the new resolution sequence (5 level-0 children drilled instead of 4 after dropping Settings exclusion).
- 91 tests still passing. svelte-check 0/0, build clean, lint clean.

## 2026-05-07 — PR1 follow-ups: locked panes, welcome view, zone selector relocation

User feedback from the live PR1 deploy surfaced three issues. Fixing each:

1. **Locked panes** — top, left, and bottom were all scrolling together with the right pane. The first cut used `position: sticky` on the workspace header and play-bar, which works only if the parent doesn't scroll; with `body` scrolling, sticky offsets accumulated. Restructured to a viewport-locked grid: `body { overflow: hidden; height: 100% }`, `.app-root { display: grid; grid-template-rows: 1fr auto; height: 100vh }`. Now the only scroll surface is `.workspace-main` (the right pane content). Sidebar's `.explore` rail scrolls internally if it has more entries than fit. Sticky declarations on the header and play-bar are gone.

2. **No more Explore duplication in the right pane** — on empty-history mount, `restoreBrowse` was calling `popAll: true`, landing on Roon's "Explore" root which contains Library/Playlists/My Live Radio/Genres/Settings. The sidebar Explore rail already surfaces those, so the right pane was just duplicating the rail. Changed `restoreBrowse` to early-return when `history.length === 0 && !searchQuery` — no popAll, no rail mirror. The Library page renders a welcome placeholder (`<div class="welcome">`) when `$browseStore.current` is null, with a hint to use the rail or the search box.

3. **Zone selector back in the play bar** — moved out of the sidebar footer (where PR1 put it) and back next to the Queue button in `.pb-right`. Sidebar footer keeps just the status pill / core info.

### Test fallout
The mount-popAll early-return invalidated 28 tests that assumed mount fired one `apiBrowse` call. Two patterns:
- Tests that just needed *some* state to interact with → swapped `apiBrowse.mockResolvedValueOnce(...)` for a direct `setBrowseResult(..., 'browse')` so the page renders the items without going through restore. New pattern is also faster.
- Tests that genuinely tested the restore path (history walk, zone forwarding, search re-seed) → already pushed history, no change needed.

Helper functions updated:
- `setUpRoot(items)` (in both quickPlay and track-list classification describe blocks) → uses `setBrowseResult` directly.
- "with empty history, pops to root via REST" → inverted to "does NOT pop to root and renders the welcome view." Asserts the new behavior with no `apiBrowse` calls and the welcome text in the DOM.

Call-count and index assertions decremented by 1 across the affected tests (mount no longer consumes a call).

### Validation
- `npm --prefix ui test` — 91 passed (no change in count; restructured tests rather than adding new ones).
- `npm --prefix ui run check` — 0 errors / 0 warnings.
- `npm --prefix ui run build` — pass.
- `npm run lint` — clean.

## 2026-05-05 — UX overhaul PR1: sticky header + left-rail Explore

First of three planned PRs from `docs/UX_OVERHAUL_PLAN_2026-05-05.md`. Reclaims the wasted left-rail real estate by replacing the "Browse / Queue" link list with an Explore rail backed by Roon's top-level browse hierarchy. Search input and back/home/forward cluster move into a sticky workspace header that persists across routes.

### Layout structure
- **Sticky header** — back/home/forward (only on /library), search input, theme toggle. `position: sticky; top: 0; z-index: 5`.
- **Sidebar** — brand block top, scrollable Explore rail middle, sidebar footer with status pill + zone selector. Sidebar width 200px (down from 240px).
- **Workspace main** — caps content width at 1440px and centers (Q13 answer); right pane gets the full breathing room.
- **Play bar** — unchanged structurally; lost the zone selector (now in sidebar footer) but still has Queue button.
- **Narrow viewport** (<1020px): sidebar hides, hamburger button in header opens it as an off-canvas overlay with a tap-to-close scrim. Replaces the prior "stack rail above content" rule.

### Explore rail (`exploreRailStore`)
Stable identity is the **labelPath** (e.g. `["Library", "Albums"]`). Resolution algorithm runs at layout mount and on `core-status: paired` reconnect (no periodic polling):

1. Browse root via REST through dedicated `multiSessionKey: 'explore-rail-discover'` so the user's main browse session is never disturbed by the popAll/drill pattern.
2. For each level-0 item with `hint === 'list'` and not in the exclusion list (today: `Settings`), `popAll` and drill once to detect empty-state.
3. For configured expansions (today: `Library`), surface each non-excluded list child as a nested rail entry. (`Search` excluded — top-bar search supersedes it.)
4. Level-2 empty-state for nested entries is left undefined; resolved at first click if needed.

Live capture confirmed the level-0 set: `Library, Playlists, My Live Radio, Genres, Settings`. The rail is fully data-driven — different Cores would yield different entries. No hardcoded label list.

### Rail click handler (label-walk only for PR1)
Always does the full label-walk: popAll, then for each label in labelPath, find by `title === label` in the current items, drill the fresh itemKey, push history with breadcrumb. The `cachedKey` / `cachedAncestorKeys` fields are reserved in the type but not populated; a future PR can add the cached-key fast path documented in the plan without changing the public shape.

If the user is already on /library, `setBrowseResult` updates the right pane directly. If on /queue (or elsewhere), `goto('/library')` triggers Library's mount → `restoreBrowse` walks the freshly-pushed history through Phase A's flow and arrives at the same place.

### Search relocation
Search component grew two new props: `mode` (`'full'` | `'input'` | `'results'`) for layout placement, and `onSubmit?: (query) => void` so callers can intercept the submit. Layout renders `<Search mode="input" onSubmit={searchInLibrary} />` in the header; the interceptor pushes the query into `pendingSearchStore` and `goto('/library')`s if needed. Library page's `$effect` on `pendingSearchStore` then issues the actual `browse:search`. Library page renders `mode="results"` only when a search is loading/errored/landed.

(R7: the first cut of PR1 omitted the interceptor, so `<Search mode="input" />` in the header just emitted `browse:search` directly. Cross-route searches updated `lastSearch` but never navigated to /library, leaving the user staring at /queue with results they couldn't see. Added the `onSubmit` prop and wired the layout to pass `searchInLibrary`. Search test added: when `onSubmit` is provided, the direct socket emit is skipped.)

### Tests
- **7 new** in `exploreRailStore.test.ts`: full-tree resolution exclusions, dedicated multiSessionKey on every call, error state, partial-failure resilience, invalidation, **stale-completion ignored after newer success**, **invalidate bumps token so in-flight resolve can't trample cleared state**.
- **1 new** in `Search.test.ts`: `onSubmit` interceptor short-circuits the direct socket emit.
- **All 83 existing** UI tests pass — 0 regressions. Layout overhaul kept all transport / volume / seek / theme / socket behavior unchanged; tests for those flows are unaffected.
- Total UI tests: 83 → 91.

### Validation
- `npm --prefix ui test` — 91 passed.
- `npm --prefix ui run check` — 0 errors / 0 warnings.
- `npm --prefix ui run build` — pass.
- `npm run lint` — clean.

### R7 follow-ups (post-review fixes)
1. **Header search routing** (P1) — described above; `onSubmit` prop added.
2. **Resolve-token race protection** (P2) — `core-status: paired` can fire repeatedly during reconnect flap. Without protection, a slow-failing earlier `resolveExploreRail` could overwrite a fast-succeeding later one's entries with an error state — entries kept but masked by the stale error in the layout. Added a monotonic token: each call captures `++resolveToken` at start, only commits at the end if `myToken === resolveToken`. `invalidateExploreRail` also bumps the token so an in-flight resolve from before the invalidate can't rehydrate cleared state. Two new tests cover both races.
3. **Layout-integration test gap** flagged by R7 — header search submission, rail click from /queue, and mobile hamburger behavior aren't covered by component-level tests yet. Adding them would require a layout test harness similar to the Library page integration tests; deferring as a follow-up rather than expanding PR1 scope.

### Known follow-ups (not in PR1)
- Cached-key fast path on rail clicks (label-walk works; just slower for nested entries — 2-3 calls instead of 1). Not perceptible on LAN.
- Native-Roon-style "Search results for ..." landing page that takes over the right pane, vs. the current panel-above-browse layout.
- Phase 2 (now-playing overlay) and Phase 3 (zone grouping + standby/wake) are separate PRs from the same plan.

## 2026-05-05 — Album-jump resolver for "X by Y" contextual rows (Phase B)

The action-list quickPlay guard stopped contextual rows like `On Ocean to Ocean by Tori Amos` from auto-playing, but the resulting UX was a play-action menu (`Play Now / Add Next / Queue / Start Radio`), not the album page the user actually wanted. This adds a best-effort album-jump resolver as a third branch in `handleItemClick`.

### Flow
- `handleItemClick` for a non-quickPlay action_list row now calls `parseAlbumByArtist(item.title)`.
- A successful parse triggers `resolveAlbumOrNavigate(item)`:
  1. Re-seed the user's main search session (`SEARCH_SESSION_KEY`) with the parsed album title. (Side effect: the search panel reflects this lookup.)
  2. Scan results for an `itemType === 'album'` match whose title equals the parsed album (case-insensitive) AND whose subtitle contains the parsed artist (case-insensitive substring — handles `"Tori Amos"` matching `"Tori Amos"` or `"Tori Amos / Various"`).
  3. On match: commit the hierarchy switch (`setSearchLoading`, `resetHistory`), `browse()` to the album with the FRESH search itemKey + breadcrumb. Mirrors `navigateSearchResult` semantics.
  4. On miss / search error: fall back to `navigate(item)` (the historical action-menu behavior).
- Unparseable titles skip the resolver entirely — zero added latency for normal browse rows.

### Hierarchy-switch ordering bug caught during test
First implementation called `setBrowseLoading('search')` upfront. When the resolver missed and fell back to `navigate(item)`, the store's hierarchy was already `'search'`, so navigate sent the contextual row's browse-hierarchy itemKey against the search session — wrong session for the key. Fixed by deferring the hierarchy commit until after a confirmed match: `setBrowseLoading()` (no hierarchy arg) shows the spinner without changing context; only the success path calls `setSearchLoading(parsed.album)`.

### Tests
- 4 new Library page tests covering: resolver-miss → action-menu fallback, resolver-match → search-hierarchy navigation with breadcrumb persisted, wrong-artist match rejection, unparseable title skips the resolver.
- The pre-existing `On Ocean to Ocean by Tori Amos` test was rewritten to mock the resolver search; it now explicitly verifies the fallback path rather than implicitly asserting "no resolver exists."

### Trade-offs / known limitations
- The resolver clobbers the user's main search query (the search panel now shows the album title). The cleaner alternative — a dedicated side multi-session — was rejected because the resulting itemKey is only valid in that session, forcing a second re-seed before navigation.
- Title parsing only handles the `<album> by <artist>` pattern. Other contextual formats (`Performed by X`, `From <album>`, etc.) skip the resolver and use the historical action-menu navigation.
- Match strictness: title must equal exactly (case-insensitive); subtitle must contain artist as a substring. Multi-artist subtitles work; missing-subtitle albums won't match (intentional — without an artist anchor, false matches are likely).
- Live verification still required — without a live Roon Core I can't confirm Roon's search-by-album always returns the target album as a top-level result. If it doesn't, the fallback path keeps behavior unchanged from before this resolver shipped.

## 2026-05-05 — Robust deep search restore via breadcrumb metadata (Phase A)

Search-rooted browse history previously dropped all drill-down steps on route remount because the persisted `item_key`s are stale (Roon mints fresh keys on every search re-seed). The user landed at the search root and lost their album/track context. Phase A persists `title/subtitle/imageKey/itemType` per step and uses it to remap stale keys against freshly-loaded results at each level.

### Persisted shape change
- `BrowseHistoryStep = BrowseOptions & { breadcrumb?: BrowseBreadcrumb }` — the step IS-A request, so existing test assertions (`s.itemKey`) keep working.
- `BrowseBreadcrumb = { title?, subtitle?, imageKey?, itemType? }` — content-keyed fields chosen for stability across search re-seeds. itemKey deliberately excluded (it's exactly what we're trying to recover).
- Storage key bumped `v2 → v3`. v2 entries on the old key are ignored on first load (sessionStorage is per-tab, so the orphan is cleaned up automatically).
- New `replaceHistory(steps)` primitive — used by `restoreBrowse` to rewrite persisted history with the fresh keys it just walked, so a subsequent Forward (after Back) doesn't send Roon stale keys minted by a prior session.

### Capture
- `browse(options, opts)` accepts an optional `breadcrumb`. All three `recordHistory: true` callsites (`navigate`, `navigateSearchResult`, `quickPlay` fallback) pass `makeBreadcrumb(item)`.
- `forward()` strips `breadcrumb` before re-issuing — it's a restore-time concern, not part of the Roon browse request payload.

### Restore (search-rooted with breadcrumbs)
1. Re-seed search with the saved query (unchanged).
2. For each saved step, match its breadcrumb against current `last.items`. On match, drill in with the FRESH itemKey. On miss / no breadcrumb, stop and surface a feedback toast (`"Restore stopped: <title> no longer in results"` or `"breadcrumb metadata missing"`).
3. `replaceHistory(rebuilt)` writes the successfully-walked path (with fresh itemKeys) back to sessionStorage.

Browse-rooted restore is unchanged. Mismatched/missing breadcrumb is treated as a graceful stop, not a failure — the user lands at whatever level we got to and can continue manually.

### Tests
- 5 new Library page tests covering: one-step replay via breadcrumb (asserts FRESH key used, not the stale persisted one), two-step sequential replay, breadcrumb mismatch stops + toasts, partial-success truncation (deepest matched step kept), legacy step without breadcrumb stops with the breadcrumb-missing toast.
- Existing browse history store tests already use `s.itemKey` which still works on the step shape — only the storage key constant needed updating to `v3`.

### Validation
- `npm --prefix ui test` — 75 → 83 UI tests passing.
- `npm --prefix ui run check` — 0 errors / 0 warnings.
- `npm --prefix ui run build` — pass.
- `npm run lint` — clean.

## 2026-05-04 — Track-list classification by itemType (C-5)

The `/^\d/` title-regex used to partition tracks vs page actions on action_list pages was the last classification heuristic still working from title shape alone. The action-list quickPlay incident gave us live evidence the regex was wrong: a "Work" page (`Play Work` + `On Ocean to Ocean by Tori Amos`) triggered the track-list path because every item was `action_list` — even though neither item was a track. Conversely, classical movements with no leading digit would have rendered as page actions instead of tracks under the old regex.

`BrowseService.toBrowseItem()` already exposes `itemType` (Roon's `item_type` / `item_subtype`), and the existing test fixtures use `itemType: 'track'`. C-5 was logged "defer until live evidence rendering is wrong"; we now have that evidence.

### Fix
- `+page.svelte` now classifies each row through `isTrackItem(item)`: prefer `item.itemType === 'track'` when present, fall back to `/^\d/` only when `itemType` is absent.
- `isTrackList` requires both `every(hint === 'action_list')` AND `some(isTrackItem)`. Pure action_list pages with no real tracks (Work pages, work-with-action-only pages) no longer flip into the track layout.
- `pageActions` / `trackItems` partitioning rewritten on top of `isTrackItem`.
- `shouldQuickPlayActionList`: track itemType is the only positive shortcut. For any other (or no) itemType, the title heuristics decide — `/^play\b/i` is itemType-agnostic so explicit play actions like `Play Work` quick-play regardless of the type Roon supplies; the numeric-prefix `/^\d/` fallback is still gated on absent itemType so a non-track itemType can't accidentally promote a numbered title into a track row.
- `normalizeItemType()` lowercases `itemType` for comparison and `isTrackType()` accepts `track` / `tracks`, matching the defensive style already used by `BrowseService.inferSearchType`.

### Behavior matrix
- Real track list with `itemType=track`: rendered as track list (no change visually for numbered tracks; classical/un-numbered tracks now render correctly instead of as a wall of pill buttons).
- Real track list without `itemType` (legacy Roon payloads): unchanged — fallback regex preserves prior behavior.
- "Work" page (action_list-only, no track items): no longer mis-classified as track list; both rows render as page-action pills (same visual result as before in this specific case, but no longer mis-categorized).
- Numbered title with non-track `itemType` (e.g. `1 Hour Continuous Mix` flagged as `action`): the `itemType` wins — treated as a page action, not promoted into the track list.

### Tests
- 6 new Library page tests (25 → 31; UI total 69 → 75):
  - Tracks with `itemType=track` and no leading digit render as a track list.
  - Legacy fallback: `/^\d/` titles without `itemType` still partition correctly.
  - Work-page case: both action_list rows render as page actions, no `<ol class="track-list">` rendered.
  - `itemType` precedence: numbered title with `itemType=action` is a page action, not a track row.
  - Case-insensitive itemType: `Track` / `TRACKS` still classify as tracks.
  - `Play Work` with `itemType=work` still triggers the action-lookup → Play Now flow (regression coverage for the Codex follow-up below).

### Validation
- `npm --prefix ui test -- page.test.ts` — 31 Library page tests passed.
- `npm --prefix ui test` — 75 UI tests passed.
- `npm --prefix ui run check` — 0 errors / 0 warnings.
- `npm --prefix ui run build` — pass.
- `npm run lint` — clean.

### Codex review iterations
1. **Non-track itemType blocked explicit play actions.** First version of `shouldQuickPlayActionList` returned `false` for any non-track itemType *before* checking `/^play\b/i`, so `Play Work` rows tagged `itemType: 'work'` or `'action'` would have fallen through to `navigate()`. Reworked: track itemType is now the only positive itemType shortcut; everything else falls back to title heuristics, and `/^play\b/i` is itemType-agnostic. Added the `Play Work` + `itemType=work` regression test listed above.
2. **itemType comparisons were case-sensitive.** `BrowseService.toBrowseItem()` passes `item_type` through raw, while `inferSearchType` already lowercases for comparison. Added `normalizeItemType()` + `isTrackType()` so `Track` / `TRACKS` payloads classify correctly. Added a case-normalization test in the track-list classification block.

## 2026-05-04 — Action-list quickPlay guard

Live composer/work browse showed a dangerous routing bug. Roon returned the work page for `29 Years` with two `action_list` buttons:

```text
Play Work
On Ocean to Ocean by Tori Amos
```

Clicking `On Ocean to Ocean by Tori Amos` should not immediately start playback, but the UI treated every `hint: "action_list"` item as quickPlay. It browsed into the item's action menu, picked the first `Play Now`, and executed it. That made contextual buttons cycle through play actions.

### Fix
- `handleItemClick()` now quick-plays only action-list items that are explicit play actions (`/^Play\b/i`) or numbered track rows.
- Other action-list items now use normal browse navigation, so `On Ocean to Ocean by Tori Amos` opens its Roon action menu instead of executing `Play Now`.
- This is still not a true album-page jump; the live Roon browse payload for `On Ocean to Ocean by Tori Amos` exposes a playback action menu (`Play Now`, `Add Next`, `Queue`, `Start Radio`), not a direct album browse result.

### Tests
- Added Library page coverage using the exact `On Ocean to Ocean by Tori Amos` label. The test leaves the zone unselected and verifies the click emits `browse:browse`; if it regressed to quickPlay it would bail with "Select a zone" and emit nothing.

### Validation
- `npm --prefix ui test -- page.test.ts` — 25 Library page tests passed.
- `npm --prefix ui run check` — 0 errors / 0 warnings.
- `npm --prefix ui test` — 69 UI tests passed.
- `npm --prefix ui run build` — pass.
- `git diff --check` — clean.

## 2026-05-03 — Search restore stale-itemKey guard

Live navigation produced a "Restore stopped..." browse error. The journal showed restore re-seeding search for query `tori`, receiving fresh keys like `32:2`, then replaying a persisted stale search drill key `29:2`; Roon returned `InvalidItemKey`.

### Fix
- `restoreBrowse()` no longer replays persisted search drill steps after re-seeding search.
- Search restore now lands at the fresh search root for the saved query and clears the stale search history.
- Browse-rooted history restore is unchanged and still walks saved steps, because browse keys remain valid within the restored browse stack.

### Rationale
Roon mints fresh search `item_key`s on every search re-seed. The current persisted history stores only `itemKey`, not stable per-step metadata, so there is no safe way to remap arbitrary deep search drill paths during route remount. Clearing stale search drill history avoids false browse errors while preserving the active query/search root.

### Tests
- Updated Library page restore coverage to assert search restore re-seeds once, does not use the stale saved key, renders the fresh search root, and clears history.
- Updated quickPlay search-context coverage so it no longer depends on unsafe search-history replay.

### Validation
- `npm --prefix ui test -- page.test.ts` — 24 Library page tests passed.
- `npm --prefix ui run check` — 0 errors / 0 warnings.
- `npm --prefix ui test` — 68 UI tests passed.
- `npm --prefix ui run build` — pass.
- `bash -n scripts/install.sh` — clean.
- `git diff --check` — clean.

## 2026-05-03 — Linux installer URL host fallback

Live reinstall completed, but the final summary failed to render a host:

```text
./scripts/install.sh: line 287: hostname: command not found
URL        : http://:5173
```

### Fix
- Replaced the inline `hostname -I | awk ...` summary expression with `detect_url_host()`.
- The Linux installer now tries:
  1. `ip -4 route get 1.1.1.1` and extracts the `src` address.
  2. `hostname -I` if `hostname` exists.
  3. `localhost` as a final safe fallback.
- The `PORT=5173` part was accurate for this VM: `/opt/roon-controller/.env` currently contains `PORT=5173`, and the installer now intentionally preserves existing `.env` values when `--port` is not passed.

### Validation
- `bash -n scripts/install.sh` — clean.
- Standalone smoke of `detect_url_host()` under `set -euo pipefail` with no `hostname` available returned `localhost` and did not abort.

## 2026-05-03 — Search result stale-itemKey hotfix

Live redeploy exposed a real search regression: clicking a search result immediately returned a browse error. The service journal showed the sequence:

1. Search query re-seeded `hierarchy: "search"` with `pop_all: true`.
2. The UI then browsed the `item_key` from the pre-reset search result row.
3. Roon returned `InvalidItemKey` because the re-seeded search session minted fresh result keys.

### Fix
- Search-result navigation still starts a clean thread, but now remaps the clicked row against the freshly re-seeded search result list before emitting `browse:browse`.
- Search quickPlay uses the same remap before action-list lookup, so track results no longer look up stale keys.
- Search result quickPlay is limited to `resultType === "track" && hint === "action_list"`; album/artist search rows with structural `action_list` hints now navigate instead of trying to play.

### Tests
- Added Library page integration coverage for:
  - Search album click → re-seed search → browse with fresh `itemKey` (not stale rendered key).
  - Search track quickPlay → re-seed search → action lookup with fresh `itemKey`.
  - Non-track `action_list` search result → navigate, not quickPlay.

### Validation
- `npm --prefix ui test -- page.test.ts` — 24 Library page tests passed.
- `npm --prefix ui run check` — 0 errors / 0 warnings.
- `npm --prefix ui test` — 68 UI tests passed.
- `npm run lint` — clean.
- `npm --prefix ui run build` — pass.
- `npm run build` — pass.
- `git diff --check` — clean.

## 2026-05-03 — PORT lookup safety + append-on-missing

Codex caught two real bugs in the previous PORT-honesty fix:

1. The `grep -E '^PORT=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '[:space:]'` pipeline runs under `set -euo pipefail`. If grep finds no match (e.g. an existing `.env` that has only `LOG_LEVEL=info` and `# PORT=4444` commented out), grep exits 1 → pipefail propagates → `set -e` aborts the installer before the summary even prints.
2. If `--port 4444` was passed and the existing `.env` had no PORT= line at all, the `sed -i "s/^PORT=.*/PORT=${PORT}/"` matched nothing and silently did nothing — so the user's explicit intent was dropped and the service stayed on the app default (3333).

### Fix
- Guard the parse pipeline with `if grep -qE '^PORT=' ...; then ...` so the failing-grep case never enters the pipeline. `EXISTING_PORT` defaults to empty.
- When `--port` is explicit and `EXISTING_PORT` is empty, append `PORT=${PORT}` to the .env (with a leading newline added if the file doesn't already end in one).

### Smoke tests (clean shell, `set -euo pipefail`)
- `.env` with only commented `# PORT=...` → empty result, no abort.
- `.env` with active `PORT=3333` → returns `3333`.
- Empty `.env` → empty result, no abort.
- Append to file with no trailing newline → final file ends `LOG_LEVEL=info\nPORT=5555\n` (no merged line).

(All four cases verified via a temp-dir fixture script.)

### Validation
- `bash -n scripts/install.sh` clean.
- Backend build / 51 tests / lint / 65 UI tests all still pass.

## 2026-05-03 — Linux installer PORT honesty fix

Codex caught that `sudo ./scripts/install.sh --reinstall --port 4444` on a host with an existing `.env` would: preserve the `.env` (so systemd's `EnvironmentFile` keeps the old PORT), then print "Port: 4444" and the URL on port 4444 in the summary — the script lying about a port the service wouldn't actually serve on.

### Fix
- Track whether `--port` was explicitly passed (`PORT_EXPLICIT=true`) inside the arg loop.
- Before the summary, resolve the effective PORT against any existing `.env`:
  - If `--port` was explicit and differs from the stored value → `sed -i "s/^PORT=.*/PORT=${PORT}/"` updates just that line. Other lines (including user-tuned `CLIENT_ORIGIN`, `LOG_LEVEL`, etc.) are untouched.
  - If `--port` was not passed → read the stored PORT into `$PORT` so the summary and final URL print what the service will actually listen on.
- The env-file write block (further down) collapses to "write fresh if no .env" — no more conditional PORT logic embedded there.

### Why only Linux
macOS plist `EnvironmentVariables` and Windows NSSM `AppEnvironmentExtra` are fully rewritten by the installer on every run, so the `${PORT}` template substitution always wins. The Linux installer is the only one that defers to a preserved file (`.env` via systemd's `EnvironmentFile=`), which is why the divergence could happen.

### Validation
- `bash -n scripts/install.sh` clean.
- Logic walk-through: explicit-port + no-existing-.env → fresh write with correct PORT; explicit-port + existing-.env-with-different-port → sed update + summary matches; no-explicit-port + existing-.env → summary uses stored PORT; no-existing-.env at all → falls through to the original write block.

## 2026-05-03 — Installer scripts brought up to date

Four fixes across all three installers (`scripts/install.sh`, `scripts/install-macos.sh`, `scripts/install-windows.ps1`):

### 1. Stale-file cleanup before redeploy
All three installers now `rm -rf` (or `Remove-Item -Recurse`) `dist/` and `ui/build/` inside the install dir before re-copying. Without this, files dropped in a newer build would survive as stale leftovers. `config/` and `data/` are NOT touched — pairing token and image cache are preserved.

### 2. .env template now mirrors `.env.example`
The installer-written `.env` was missing three env vars added in recent batches (`IMAGE_CACHE_MAX_BYTES`, `CLIENT_ORIGIN`, `TRUST_PROXY`). The Linux installer now writes a `.env` that mirrors `.env.example` — including the explanatory comments — so anyone reading it knows what's tunable. The macOS and Windows `.env` templates carry the same set of vars but as bare `KEY=value` lines without the comment text, because on those platforms the `.env` is documentation only — the live config is in the launchd plist `EnvironmentVariables` block / NSSM `AppEnvironmentExtra` string, neither of which supports comments. Optional vars (`CLIENT_ORIGIN`, `TRUST_PROXY`) are written commented-out everywhere they're written so they're documented as tunables without changing default behaviour.

### 3. .env preservation hardened
**Behaviour change worth flagging**: previously, `--reinstall` would *overwrite* `.env`, clobbering any user-tuned values (custom port, `CLIENT_ORIGIN` allowlist, etc.). Now `.env` is preserved across reinstalls regardless of the flag. The runtime config on macOS and Windows still updates because those platforms embed env vars in the plist / NSSM `AppEnvironmentExtra` (which DO get rewritten each install). On Linux the `.env` is read by systemd's `EnvironmentFile`, so an old `.env` keeps applying — but since defaults are safe for new vars, nothing breaks. Users wanting the new commented-out tunables on an upgraded Linux install can copy them from `.env.example`.

### 4. Platform-specific env carriers also updated
- macOS plist `EnvironmentVariables` block: added `IMAGE_CACHE_MAX_BYTES`. (Optional vars left out — set explicitly if needed.)
- Windows NSSM `AppEnvironmentExtra` string: same addition with the same rationale.

### Validation
- `bash -n` syntax check on both shell installers — clean.
- PowerShell installer: changes are mechanical (env-var additions only); could not pwsh-verify locally. Worth a smoke test on a Windows host before recommending to anyone.
- Backend build / 51 tests / lint / UI 65 tests all still pass.

### Recap of what the installers do
- Detect existing installs by checking install-dir presence; refuse without `--reinstall` (or `-Reinstall` on Windows).
- With reinstall flag: stop service → wipe build artefacts → rebuild → redeploy → reinstall prod deps → register service → restart.
- Pairing token (`config/roon-token.json`) and image cache (`data/`) survive across reinstalls because they live outside the wiped dirs.
- Single-line upgrade: `sudo ./scripts/install.sh --reinstall` (Linux), `sudo ./scripts/install-macos.sh --reinstall`, `.\scripts\install-windows.ps1 -Reinstall`.

## 2026-05-03 — quickPlay + jump-bar + Load more tests

Added 10 more Library page tests covering the remaining open coverage in the test backlog.

### quickPlay flow (5)
- Happy path: action lookup → Play Now → restore album view via socket pop. Asserts both apiBrowse calls have the right hierarchy/itemKey/zoneId.
- No play action found → fallback to navigate (records history, emits browse:browse).
- No zone selected → feedback toast, no extra apiBrowse calls.
- Search context (hierarchyAtStart === 'search') → does NOT emit browse:pop after execute. The "restore album view" branch only runs in browse hierarchy.
- Action lookup REST failure → feedback toast with the error message.

### Jump bar / Load more (5)
- Jump bar renders one button per unique first letter when items > 20 threshold.
- Jump bar suppressed for short lists (≤ 20).
- Clicking a letter triggers `scrollIntoView` on the corresponding section anchor (jsdom doesn't implement it; stubbed via `Element.prototype` and spied).
- Load more bar renders when `loaded < totalCount` with both "Load more" and "Load all" buttons.
- "Load more" calls apiBrowseLoad with offset = current loaded count and count clamped to ≤ 100; appended items extend the visible list.

### A note worth flagging for future test writers
**Superseded by C-5 (2026-05-04 — Track-list classification by itemType)** — `isTrackList` now also requires `some(isTrackItem)`, so a single non-track action_list item no longer flips the layout into the track-list view. The historical caveat below is preserved for context on tests written before the refactor.

> Single-item action_list payloads cause the page to render as a `track-list` view (because `isTrackList` checks "all items are action_list"). In that view, titles starting with a digit get the leading `\d+\.\s*` stripped via `trackTitle()`, so the rendered text differs from the raw item title. Use action_list items with non-digit titles ("Play Album") so they render as page-action pills with predictable text matching.

Post-C-5 guidance for new tests: a row only enters the track layout when at least one item carries `itemType: 'track'` (or, in the legacy fallback, has a leading digit). Use page-action titles like "Play Album" or attach `itemType: 'track'` deliberately when you want a row in the track list.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 51 backend tests passed
- `npm run lint` — clean
- `npm --prefix ui run check` — 0/0
- `npm --prefix ui test` — **65 UI tests passed** (29 stores + 15 components + 21 page integration)
- `npm --prefix ui run build` — pass

**Total: 116 tests**, all green.

## 2026-05-03 — Library page integration tests

The Library page is the only piece left where I can make progress without owner intervention. Wrote 11 integration tests, all targeting paths where multi-round Codex review effort went.

### Coverage
- **Mount restore matrix**:
  - Empty history → single `popAll: true` browse REST call.
  - Browse-rooted history → popAll then walk each saved step (3 calls for 2 saved steps).
  - Search-rooted history with saved query → re-seed search session via `apiBrowse({hierarchy: 'search', input, popAll: true, multiSessionKey})` then walk drill steps.
  - Search-rooted history without saved query → fall back to browse root, history cleared.
  - Selected zone forwarded into all replay calls.
  - Returned items rendered into the DOM.
- **Navigation**:
  - Click a list item → emits `browse:browse` over the socket with the right itemKey, records into `browseHistoryStore`.
  - `browseNavStore.home()` → emits browse with `popAll: true`, resets history + forward.
  - `browseNavStore.back()` → emits `browse:pop`, moves the popped step to forward.
  - Loading state → "Loading library data..." copy renders.
- **Robustness**:
  - A failing replay step doesn't crash the page; the deepest successful result is what shows.

### Mocks
- `$lib/api/client` → `apiBrowse` and `apiBrowseLoad` stubbed via `vi.fn()` so each test can queue specific responses or rejections.
- `$lib/socket/client` → fake socket with `emit`/`on`/`off` and an `io` shim for the manager events.
- `$app/navigation` → no-op `goto`.

The real stores (browseStore, browseHistoryStore, selectedZoneStore) run unmodified — the tests verify their integration with the page rather than mocking around them.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 51 backend tests passed
- `npm run lint` — clean
- `npm --prefix ui run check` — 0/0
- `npm --prefix ui test` — **55 UI tests passed** (29 stores + 15 components + 11 page integration)
- `npm --prefix ui run build` — pass

**Total: 106 tests**, all green.

## 2026-05-03 — Component-level tests via Svelte Testing Library

Added `@testing-library/svelte` + `@testing-library/jest-dom` + `@testing-library/user-event` on top of yesterday's Vitest setup. 15 new component tests; total UI tests now 44.

### Wiring
- `vitest.config.ts` now loads the Svelte plugin (`@sveltejs/vite-plugin-svelte`) so `.svelte` files compile under tests, and uses `conditions: ['browser']` so Svelte resolves to its browser entry points.
- `setup.ts` imports `@testing-library/jest-dom/vitest` for DOM matchers and runs `cleanup()` from `@testing-library/svelte` after each test.

### Tests written
- **`Search.svelte`** (10): result grouping by type in documented order (Artists / Albums / Tracks / …), per-group "Show more" pagination at PAGE_SIZE=12, query label in the count line, click callback fires with the right result, disabled state for missing itemKey, socket emit on submit, whitespace queries don't emit, page-size resets when query changes, loading/empty states.
- **`ErrorToast.svelte`** (5): renders nothing when feedback is empty, distinct labels for transport/queue/browse sources, dismiss button clears, auto-clear after 5 seconds (via `vi.useFakeTimers` + `advanceTimersByTimeAsync`).

### Notable gotcha (worth flagging for future test writers)
Svelte 5 batches reactivity. Updating a store after `render()` and reading the DOM synchronously sees the pre-flush state. Tests that change a store in-place need `await tick()` (from `svelte`) or `findBy*` queries that retry until the element appears. The Search tests use `await tick()` after every `setSearchResults` / `setSearchLoading`.

### Decision: reconnectionAttempts stays at 20
~1.5 minutes of retry with socket.io's 1s→5s backoff. Long enough to ride out laptop sleep, mobile handoff, and Roon Core restarts (~60s). Short enough that genuinely lost servers (machine off, cable yanked) get a "Disconnected — refresh" prompt while the user is still around. Single line in `ui/src/lib/socket/client.ts` if it ever needs adjustment.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 51 passed (backend)
- `npm run lint` — clean
- `npm --prefix ui run check` — 0/0
- `npm --prefix ui test` — **44 passed**
- `npm --prefix ui run build` — pass

**Total tests across both halves: 95**, all green.

## 2026-05-02 — UI test infrastructure + first batch of tests

The browse-history surface and socket-status state machine are invariant-heavy after the recent batches. Added Vitest with jsdom and 29 tests covering the highest-risk pieces.

### Infrastructure
- `ui/vitest.config.ts` — separate from `vite.config.ts` so the SvelteKit dev server doesn't load the test setup.
- `ui/src/test/setup.ts` — clears sessionStorage / localStorage before each test (with a fallback for jsdom builds that lack `.clear()`).
- `ui/src/test/app-stubs/environment.ts` — stubs SvelteKit's `$app/environment` (`browser = true`) so stores that depend on it work under node + jsdom.
- New scripts: `npm --prefix ui test` (one-shot), `npm --prefix ui run test:watch`.
- New deps: `vitest@^4`, `jsdom@^29`.

### Tests written
- **`browseHistoryStore`** (20 tests): pushHistory append within hierarchy, hierarchy-switch reset (browse↔search), searchQuery preserve/drop, forward stack cleared on push, popHistory/popForward, resetHistory, sessionStorage round-trip, malformed JSON, schema versioning (v1 entries ignored). Plus the full sanitization matrix: mixed-history trimming, forward kept when matching sanitized history's hierarchy, forward dropped when not, forward dropped when history empty, searchQuery cleared when sanitized tail isn't search.
- **`socketStatusStore`** (2 tests): state cycle through all values.
- **`register.ts` connectivity transitions** (9 tests): initial state from `socket.connected`, connect/disconnect events, disconnect-reason branching (server/client → disconnected; transport/ping → connecting), `reconnect_failed` from the manager → disconnected, `connect_error` keeps connecting, listener cleanup on unmount.

The fake socket is a closure over two Maps (regular + manager handlers) with `fire()` / `fireManager()` methods to drive events synchronously. `vi.mock` of `../client` is hoisted (no `vi.resetModules`) so the test file and `register.ts` share the same `socketStatusStore` module instance.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 51 passed (backend)
- `npm run lint` — clean
- `npm --prefix ui run check` — 0/0
- `npm --prefix ui test` — **29 passed**
- `npm --prefix ui run build` — pass

Total tests across both halves: **80**, all green.

## 2026-05-02 — Finite reconnection budget

Codex caught the third-order issue: the `reconnect_failed` listener I wired up was correct, but socket.io's default `reconnectionAttempts` is `Infinity`, so the trigger condition is unreachable. The "Disconnected — refresh" prompt would never appear; the UI would sit on "Connecting…" forever for a genuinely lost server.

### Fix
Set `reconnectionAttempts: 20` in `io()` options. With socket.io's default ~1s → 5s exponential backoff, that's roughly 1.5 minutes of trying before the manager emits `reconnect_failed` and the status pill flips to "Disconnected" with a refresh prompt. Short blips (laptop wake, mobile handoff) finish well before that threshold.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 51 passed
- `npm run lint` — clean
- `npm --prefix ui run check` — 0/0
- `npm --prefix ui run build` — pass

## 2026-05-02 — C-11 fix corrections

Codex caught two real bugs in the C-11 socket fallback I shipped earlier this turn.

### P2 — `transports: [...]` alone doesn't actually fall back
Engine.IO only attempts the second transport when `tryAllTransports: true` is set. Without it, `transports: ['websocket', 'polling']` is effectively websocket-only — the exact failure mode I was trying to prevent. Added `tryAllTransports: true` so a blocked WebSocket upgrade now falls through to long-polling. Verified the option exists in the installed `engine.io-client@build/esm/socket.js:489`.

### P3 — `'disconnected'` was unreachable
Both `disconnect` and `connect_error` handlers set `'connecting'`, so the status pill could never show `'Disconnected'`. Fixed by:
- `handleDisconnect(reason)` now branches on the reason: `'io server disconnect'` and `'io client disconnect'` are non-reconnecting cases → `'disconnected'`. Everything else (ping timeout, transport error/close) auto-reconnects → `'connecting'`.
- New `handleReconnectFailed` listens on the manager (`socket.io.on('reconnect_failed', ...)`) and flips to `'disconnected'` after socket.io exhausts its retry budget. Toast prompts the user to refresh.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 51 passed
- `npm run lint` — clean
- `npm --prefix ui run check` — 0/0
- `npm --prefix ui run build` — pass

## 2026-05-02 — Socket connectivity polish (C-11 + C-18)

Two small wins that were sitting in the deferred bucket.

### C-11 — Socket transport fallback + connectivity feedback
- `socket.io-client` now uses `transports: ['websocket', 'polling']` instead of websocket-only. Networks/proxies that block websocket upgrades will fall back to long-polling instead of leaving the UI silently disconnected.
- New `socketStatusStore` tracks the WebSocket lifecycle independently of the Roon core pairing state. `register.ts` updates it on `connect` / `disconnect` / `connect_error` and reads `socket.connected` at registration time so the initial state is accurate.
- The play-bar status pill now distinguishes four states:
  - **Connecting…** — socket trying to connect/reconnect
  - **Disconnected** — socket truly down (currently only set explicitly; reconnect attempts stay as "connecting")
  - **Searching for Core…** — socket up, Roon core unpaired
  - **Connected** — socket up, core paired
- `connect_error` still pushes a feedback toast so persistent failures are visible. The status pill stays in "connecting" rather than flipping to a hard "disconnected" — a transient network blip on a phone or laptop lid-close shouldn't be alarming.

### C-18 — `subscribe_zones` Subscribed/Changed asymmetry
The handler called `handleSeekChanged` only on `Changed`. `Subscribed` payloads in practice never carry seek info, but the asymmetry was undocumented and would silently break if Roon ever bundled them. Both branches now call both handlers; `handleSeekChanged` already noops when `zones_seek_changed` is absent.

### Heads-up: deployed service still runs the old build
Your systemd service at `/opt/roon-controller` has been running the **old** code throughout this session (Main PID 452, started before any of these batches). To use any of the fixes — including the queue protocol fix that changes user-visible behaviour — you'll need to redeploy:

```
sudo ./scripts/install.sh --reinstall
```

That rebuilds from the current tree and restarts the service. The pairing token under `/opt/roon-controller/config/` is preserved.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 51 passed
- `npm run lint` — clean
- `npm --prefix ui run check` — 0/0
- `npm --prefix ui run build` — pass

## 2026-05-02 — Browse-history storage key versioned

Codex flagged residual risk: the read-time sanitizer keys on hierarchy alone, so a legacy `history=[searchResultA, searchResultB]` (multiple search-result drills written before `navigateSearchResult` started calling `resetHistory()`) would still survive load and replay both during restore. New writes are protected by the resetHistory guard, but legacy entries from any build that shipped between the BrowseHistoryStore introduction and the within-search-thread guard could persist.

### Fix
Bumped sessionStorage key from `roon-controller-browse-history` to `roon-controller-browse-history-v2`. Stale entries are simply not read; sessionStorage being per-tab means orphaned keys are discarded when the tab closes. Cost: any user with active browse history at upgrade time has a one-time reset to the browse root.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 51 passed
- `npm run lint` — clean
- `npm --prefix ui run check` — 0/0
- `npm --prefix ui run build` — pass

## 2026-05-02 — Forward-stack migration sanitization

Codex caught one more migration edge: the previous sanitizer trimmed the forward stack against its own tail hierarchy independently of history's. Legacy `history=[browseStep], forward=[searchStep]` would survive load with a mixed forward; then a Forward click would call `popForward()`, which appends the entry directly into history without going through `pushHistory`'s hierarchy guard.

### Fix
Forward must match history's tail hierarchy. After sanitizing history, only keep forward if every entry shares that hierarchy; otherwise discard the whole forward stack. With empty history there's no anchor, so forward is always discarded.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 51 passed
- `npm run lint` — clean
- `npm --prefix ui run check` — 0/0
- `npm --prefix ui run build` — pass

## 2026-05-02 — sessionStorage migration sanitization

Codex caught the upgrade edge: the previous fix enforced single-hierarchy stacks at `pushHistory` time, but `readPersisted` loaded prior sessionStorage entries as-is. A mixed `[browseStep, searchStep]` written by an older build would still reach `restoreBrowse` on the first remount before any new push triggered the guard.

### Fix
`readPersisted` now sanitizes via `sanitizeStack(raw)`, which walks from the end and takes only steps with the same hierarchy as the tail. The result is the same shape `restoreBrowse` would see for a stack written under the new invariant.

If history was truncated, the forward stack is dropped entirely (its entries belong to the abandoned context). If the resulting tail hierarchy is `'browse'`, `searchQuery` is dropped too.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 51 passed
- `npm run lint` — clean
- `npm --prefix ui run check` — 0/0
- `npm --prefix ui run build` — pass

## 2026-05-02 — Mixed-hierarchy browse history

Codex caught a follow-on to the search-rooted restore fix. History is one shared stack and steps were appended without partitioning. Repro: browse into Albums → search → click result → leave Library → return. History became `[browseStep, searchStep]`. `restoreBrowse` saw deepest = search, re-seeded the search session, then walked BOTH steps — including the browse-hierarchy step against the now-search session. That fails or lands wrong, and back/forward through a mixed stack is incoherent.

### Fix (two layers)
- **Store level** (`browseHistoryStore.pushHistory`): switching hierarchies starts a new context. Comparing the new step's hierarchy against the existing tail's hierarchy and resetting `history` to just `[opts]` when they differ. searchQuery is dropped when leaving search; carried forward when continuing in the same hierarchy. This catches the browse↔search case automatically regardless of which call site triggers it.
- **Page level** (`navigateSearchResult` and the `quickPlay` fallback when `resetSearch=true`): explicit `resetHistory()` before pushing. Each search-result click is a new navigation thread — even when the prior step was *also* in the search hierarchy (a different result from the same query). The store-level guard would not catch within-search thread switches; this does.

Together they enforce single-hierarchy stacks AND single-thread-within-search stacks. `restoreBrowse` will only ever see contiguous, consistent history.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 51 passed
- `npm run lint` — clean
- `npm --prefix ui run check` — 0/0
- `npm --prefix ui run build` — pass

## 2026-05-02 — Search-rooted browse history restore

Codex caught a follow-on to the previous browse-history fix: history entries created from search drill-downs (`hierarchy: 'search'`, `multiSessionKey: SEARCH_SESSION_KEY`) lived in a separate Roon multi-session, but `restoreBrowse` always reset only the `browse` hierarchy. Replaying a search-derived step against an unprimed search session would still hit stale-stack behaviour. Plus the store's `hierarchy` field was being finalized as `'browse'` (the value used for `setBrowseLoading` at mount), so subsequent `pop()` calls would target the wrong session.

### Fix
- `BrowseHistoryState` gained a `searchQuery: string | null` field, persisted to sessionStorage alongside the stacks. Captured in `pushHistory(opts, searchQuery)` whenever a search-derived step is recorded.
- `restoreBrowse` now picks the target hierarchy from the deepest saved step (`'browse'` for empty history). It calls `setBrowseLoading(targetHierarchy)` up front and finalizes with `setBrowseResult(last, targetHierarchy)` — so the store's hierarchy stays correct even mid-restore.
- For a search-rooted history with no saved query (shouldn't happen in normal flow but is possible after migration), the broken history is discarded and we fall back to the browse root.
- For a search-rooted history with a saved query, we re-seed the Roon search session via `apiBrowse({hierarchy: 'search', input: searchQuery, popAll: true, multiSessionKey: SEARCH_SESSION_KEY})` before walking the saved steps. `setSearchLoading(searchQuery)` repopulates `lastSearchQuery` in the store so subsequent search-result clicks know which query to reset to.
- Browse-rooted history still uses `popAll` on the browse hierarchy.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 51 passed
- `npm run lint` — clean
- `npm --prefix ui run check` — 0/0
- `npm --prefix ui run build` — pass

## 2026-05-02 — Codex follow-up review fixes (first pass)

Codex re-reviewed Batch 2 + the queue protocol fix and surfaced 5 real issues. All addressed in this turn.

### P1 — Browse history restore was unreliable
`onMount` was calling `browse({itemKey: lastEntry})` directly. Roon's browse session is stateful and shared across our REST/socket calls, so applying the saved itemKey to whatever level the session happens to be at after Library → Queue → Library is not guaranteed to land on the same parent. Fix: new `restoreBrowse(history)` calls `popAll: true` first, then walks every step in `browseHistoryStore.history` sequentially via REST. If a step fails (stale itemKey after a Roon Core restart), it stops and surfaces a feedback toast; the user can press Home or Back to recover.

### P2 — Duplicate toast on failed ack-bearing commands
Server was sending the error to the ack AND emitting the topic-specific event. The client pushed feedback from both: once via `emitWithAck` for the ack, once via `register.ts` for the passive event. Fix: `sendError` now sends through the ack OR the event, never both. The contract: clients with an ack inspect the ack; clients without one rely on the passive event.

### P2 — Socket validation lagged REST validation
`transport:settings` accepted any shuffle/auto_radio/loop value; `queue:subscribe` accepted any `max_item_count`. Fix: mirrored the REST validators — boolean checks for shuffle/auto_radio, enum check against `LoopModeRequest` for loop, positive-integer check for `max_item_count`.

### P2 — Malformed queue splice ops could mutate index 0
`applyQueueChange` defaulted missing/invalid `index` to 0 and missing/invalid remove `count` to 1. A bad payload from Roon (or a future change) could silently delete the current track or insert at the wrong row. Fix: refuse the change with a warn log when index is absent/invalid, and similarly for remove count. Index 0 must now be explicit. Two tests added for this.

### P3 — Zone fan-out
Per-zone updates were also broadcasting a full `zones` snapshot, which on a multi-zone Roon Core with frequent seek ticks meant N×N traffic. Fix: dropped the snapshot emit from per-zone update/remove handlers. Initial snapshot still fires on socket `connection`; the per-zone events (`zone-updated` / `zone-removed`) carry enough information for the client's `upsertZone` / `removeZone` to keep state consistent.

### Tests
Added 2 TransportService tests for malformed splice ops (missing index, missing remove count). Backend went 49 → 51, all passing.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 51 passed
- `npm run lint` — clean
- `npm --prefix ui run check` — 0/0
- `npm --prefix ui run build` — pass

## 2026-05-02 — Queue protocol fix (C-3 full + C-20)

Captured raw Roon `subscribe_queue` traffic from the existing systemd service's journal (no need to spin up a new server — the service already logs the underlying Moo protocol at debug). Two findings, both shipped:

### 1. Queue delta wire format
Roon delivers queue mutations as splice-style ops:
```
{ "changes": [
    { "operation": "insert", "index": N, "items": [...] },
    { "operation": "remove", "index": N, "count": K }
] }
```
The fields `items_added` / `items_changed` / `items_removed` referenced in older docs **are not what the JS transport service actually delivers**. Both the prior code and my Batch 1 partial fix were looking for the wrong field names, which means **every queue delta after the initial Subscribed snapshot was being silently dropped**. The reason this looked like it "worked" in production: `Subscribed` events sometimes carry the full current queue in `items: [...]`, so the queue page showed *something* — but mid-playback updates (track consumed → next track shifts to position 0, Play Next from another control point, removals) never reached the UI.

`TransportService.handleQueueUpdate` now applies `data.changes` positionally via `Array.splice`. Multiple ops in a single payload are applied in order. Unknown operations are logged and skipped to keep the queue stable.

### 2. Current-track row indicator
`now_playing` carries no `queue_item_id`. But the capture revealed Roon's invariant: when a track is consumed, Roon sends `{operation: "remove", index: 0, count: 1}` — i.e. **the queue is rooted at the currently-playing track**. So C-20 reduces to "highlight row 0." The fuzzy substring match `likelyCurrent()` is gone; `isCurrentRow(index) => index === 0` replaces it.

### Tests
Five new TransportService tests cover insert, remove-with-count, the consume-and-append pattern (`remove index 0` + `insert index N`), preserved order with non-monotonic IDs, and graceful handling of unknown ops. 44 → 49 passing.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 49 passed
- `npm run lint` — clean
- `npm --prefix ui run check` — 0 errors, 0 warnings
- `npm --prefix ui run build` — pass

### Note for the upgrade path
This is a behaviour-changing fix for any deployed instance that played anything beyond the initial subscribe. After the upgrade, queue updates will start tracking correctly; users may notice the UI suddenly showing accurate post-skip / post-Play-Next state for the first time.

## 2026-05-02 (even later) — Code review batch 2

Owner gave direction on the seven open design questions; this batch implements everything that was unblocked. Validated: backend build, 44 tests, lint clean, UI 0/0, UI build all green.

### Decisions used
1. **Deployment shape**: primarily LAN appliance (`HOST=0.0.0.0` stays default), with localhost+proxy as a documented alternative.
2. **Browse history**: sessionStorage (not URL) because Roon `item_key`s are session-scoped and would silently 404 from a deep link after a Roon Core restart.
3. **Image cache**: max-size LRU at 10 GB, configurable via `IMAGE_CACHE_MAX_BYTES`.
4. **Volume**: minimal slider in the play bar — works for variable-volume outputs, hides automatically for fixed-volume DACs.
5. **Browse paging**: lazy-load batches (default 100), preserve jump bar (auto-loads remaining items when jumping to an unloaded letter).
6. **Search UX**: group by type, paginate per group, persist on zone change.
7. **Roon payload capture**: shipped trace-level logging on both `subscribe_zones` and `subscribe_queue` callbacks. Set `LOG_LEVEL=trace`, exercise queue mutations, share the captured `data` payloads when convenient.

### Backend
- **Helmet** wired with a CSP compatible with Svelte's inline scoped styles and same-origin Socket.IO. `app.set('trust proxy', 1)` when `TRUST_PROXY=true`.
- **Rate limiting** on `/api/*` at 600 req/min per IP via `express-rate-limit`.
- **CORS**: `CLIENT_ORIGIN` now accepts a CSV allowlist as well as `*`.
- **Browse paging (Prior #6)**: `BrowseService.browse()` defaults to one page (100 items) and exposes `pageSize` (with `Infinity` for the load-everything escape hatch). `pop()` forwards `pageSize`. Added 2 paging tests.
- **Volume types (C-8)**: shared `VolumeType` now includes `'db'`. `normalizeVolume` preserves the Roon-reported type (`number`/`db`/`incremental`) instead of collapsing non-`number` to `incremental`. `setVolume` chooses `relative` mode for incremental outputs and `absolute` otherwise.
- **Trace logging (#7)**: raw `subscribe_zones` and `subscribe_queue` callbacks dumped at trace level.
- **Roon graceful shutdown (C-12)**: new `TransportService.shutdown()` (renamed from collision with `stop(zone_id)`). `index.ts` calls it before closing HTTP/socket.
- **Search type inference (C-16)**: prefer `itemType` over `hint` so search results are correctly labelled.
- **BrowseService (C-14)**: `EventEmitter` inheritance and dead `on/emit` declarations removed; service is request/response.
- **Browse log levels (C-17)**: normal browse/load/pop/search dropped from `info` to `debug`.
- **Config**: added `IMAGE_CACHE_MAX_BYTES` (default 10 GB).

### Frontend
- **Browse history (C-10)**: lifted history/forward stacks into a new `browseHistoryStore` persisted to sessionStorage. Library page now restores its deepest navigation step on remount, so Library → Queue → Library no longer resets to root. Stale `item_key`s after a Roon restart degrade gracefully (server returns empty list, user presses Home).
- **Selected zone (C-22)**: `selectedZoneStore` persists to localStorage; layout no longer clears the selection when zones temporarily disappear during reconnect.
- **Theme (C-9)**: inline pre-hydration script in `app.html` reads `roon-controller-theme` (and falls back to `prefers-color-scheme`) before first paint, eliminating the dark-then-light flash. localStorage access wrapped in try/catch.
- **Volume UI (C-8)**: slider in the play bar (variable-volume outputs) or `−/+` step buttons (incremental). Hidden for fixed-volume outputs (most of your DACs).
- **Search UX (Prior #7)**: results grouped by type (Artists / Albums / Tracks / Playlists / etc.) with per-group "Show more" pagination at PAGE_SIZE=12. The submitted query is shown in the result-count line. Results persist across zone changes.
- **Browse paging UI (Prior #6)**: a "Load more / Load all" footer appears under any browse result that hasn't loaded everything. The alphabetic jump bar auto-triggers a "Load all" when the user jumps to a letter that hasn't been loaded yet, then scrolls.
- **Image cache LRU (C-13)**: opportunistic eviction on writes plus a sweep at startup; total bytes counted via `fs.stat`, oldest-by-mtime evicted to 90% of cap.

### New deps
- `helmet ^8`
- `express-rate-limit ^8`

### Tests
- Backend: 42 → 44 (new browse-pagination cases). All 44 passing.
- UI: typecheck 0 errors / 0 warnings, build clean.

### Documentation
- `README.md`: rewrote the Configuration table (added `IMAGE_CACHE_MAX_BYTES`, `CLIENT_ORIGIN`, `TRUST_PROXY`) and added a Security Notes block calling out the no-auth LAN posture.
- `.env.example`: same additions plus brief inline guidance.

### Still deferred / next batch
- **C-3 full + C-20**: queue positional diff + current-track row highlighting. Trace logging is now in place; needs a captured payload from your Core to know what fields Roon actually sends on inserts and where the current `queue_item_id` lives (if anywhere).
- **`db` outputs in the volume slider**: the slider's min/max already use the output's reported range, so a dB output gets a slider in dB units. No work needed unless you want a more polished display (e.g. show "dB" suffix).

## 2026-05-02 (later)

### Completed — Code review batch 1
First fix batch off `docs/CODE_REVIEW_COMPARISON_2026-05-02.md`. Scope kept tight to security and correctness; deferred items called out below.

- **C-1 / image cache path traversal (P1)**: cache filenames are now SHA-256 hashes of the request tuple. Image route validates `scale` against the literal set, rejects non-positive/non-integer/oversized dimensions, and caps `:key` length at 256 chars. Cache directory created with mode 0o700.
- **Prior #2 + C-2 / socket ack contract (P1)**: server now always sends a typed `AckResponse<T> = { success: true; data? } | { success: false; error; code? }` to ack-bearing commands AND emits the topic-specific error event. New client helper `ui/src/lib/socket/emit.ts` (`emitWithAck`) parses the ack, applies a per-call timeout (default 5s), and pushes failures into `commandFeedbackStore`. `+layout.svelte` and `queue/+page.svelte` migrated.
- **Prior #3 / reconnect hydration (P1)**: server emits current `core-status` on every socket `connection`. Client `register.ts` no longer treats socket disconnect as core unpair — it refetches via REST on `connect` (covers initial + reconnect) and surfaces `connect_error`.
- **Prior #4 / runtime validation (P2)**: REST routes now reject non-string `zone_id`, non-finite seconds, negative seek, non-boolean shuffle/auto_radio, non-enum loop, and non-positive `max_item_count`. Socket handlers reject NaN/Infinity for seek, volume, and `queue_item_id`.
- **Prior #5 / `/api` JSON 404 (P2)**: a JSON 404 handler runs before the SPA fallback for any unmatched `/api/*` path. Body limit lowered to 32 KB.
- **Prior #8 / token file mode (P2)**: token written with mode 0o600, parent dir with mode 0o700.
- **C-3 + C-4 / queue ordering (P2)**: removed the numeric sort in `TransportService.handleQueueUpdate`. Roon's snapshot order is now authoritative. `normalizeQueueItem` returns `null` for items missing a valid `queue_item_id` instead of synthesising id `0`. Did NOT implement positional diff handling — comparison doc flagged the Roon delta payload shape as unverified.
- **C-15 / errorMessage helper**: `src/server/util.ts` exports a safe `errorMessage(error: unknown)` and is used in every socket handler.

### New tests
- `src/server/__tests__/util.test.ts` — 5 tests for `errorMessage`.
- `src/server/http/routes/__tests__/image.test.ts` — 7 tests covering scale/dimension validation, key length, encoded path-traversal containment, and SHA-256 filename shape.
- `src/server/http/__tests__/app.test.ts` — 2 tests for `/api/*` JSON 404 and `/api/health`.
- `src/core/roon/__tests__/TransportService.test.ts` — 2 added: snapshot-order preservation and dropping invalid queue IDs.

Backend went from 25 tests → 42, all passing.

### Validation
- `npm run build` — pass
- `npm test -- --runInBand` — 42 passed
- `npm run lint` — clean
- `npm --prefix ui run check` — 0 errors, 0 warnings
- `npm --prefix ui run build` — pass

### Deferred (need owner input or larger scope)
- **Network exposure default (Prior #1, C-6)**: changing `HOST` default from `0.0.0.0` to `127.0.0.1` is a deployment-shape decision. Helmet/rate-limit comes with that. Open question in both reviews.
- **Browse history persistence (C-10)**: lift stacks to a store, decide URL-vs-localStorage.
- **Queue positional diff handling (C-3 full)**: needs live-core capture before implementation.
- **`current queue_item_id` source for highlighting (C-20)**: same — claimed source unverified.
- **Volume UI + type normalization (C-8)**: pure backend type fix is small; UI is feature scope.
- **Image cache eviction (C-13)**: needs policy decision.
- **Browse paging (Prior #6)**: needs UX decision on jump-list compatibility.

## 2026-05-02

### Completed
- Compared Claude's independent review against the repository and saved validation notes in `docs/CODE_REVIEW_COMPARISON_2026-05-02.md`.
- Added comprehensive code review findings in `docs/CODE_REVIEW_2026-05-02.md`.
- Fixed search-result drill-down corrupting browse state after a search.
- Kept search loading/error state separate from the main browse hierarchy.
- Added a dedicated search browse session key in `ui/src/lib/browseSessions.ts`.
- Re-run the search session before opening a selected search result so repeated clicks on search results do not operate on a stale Roon search stack.
- Kept nested navigation and pop/back inside search results on the same `library-search` multi-session.
- Preserved `zone_or_output_id` and `multi_session_key` across backend `browse()` -> `load()` calls.
- Added BrowseService regression coverage for zone-scoped and multi-session loads.

### Validation
- Code review validation passed: backend build, backend tests, backend lint, frontend check, frontend build.
- Backend build passed: `npm run build`
- Backend tests passed: `npm test -- --runInBand` (25 tests)
- Frontend typecheck passed: `npm --prefix ui run check`
- Frontend build passed: `npm --prefix ui run build`

### Notes
- Confirmed the image cache path traversal risk with a local Express route probe: encoded slashes in `/api/image/:key` are decoded into `req.params.key`.
- Confirmed additional backlog items around queue ordering, invalid queue IDs, browse history persistence, selected-zone persistence, and volume type handling.
- Queue delta positional metadata and current queue item id availability still need live Roon payload capture.
- The likely root cause was split between UI and backend context handling:
  - UI search results were changing the global browse hierarchy to `search`.
  - Backend follow-up `load()` calls dropped `multi_session_key` and `zone_or_output_id`.
- Search result navigation now uses the `library-search` multi-session key.
