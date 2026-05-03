# Dev Log

## 2026-05-03 (latest) — PORT lookup safety + append-on-missing

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
Single-item action_list payloads cause the page to render as a `track-list` view (because `isTrackList` checks "all items are action_list"). In that view, titles starting with a digit get the leading `\d+\.\s*` stripped via `trackTitle()`, so the rendered text differs from the raw item title. Use action_list items with non-digit titles ("Play Album") so they render as page-action pills with predictable text matching.

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
