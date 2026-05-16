# Project Plan – Roon Controller (AI-Friendly)

> **Purpose**  
> This document keeps the project understandable across AI sessions with limited
> context. Every task is bite-sized, self-contained, and includes guard‑rails
> against typical AI mistakes (overwriting files, skipping tests, etc.).

---

## 1. Guiding Principles

1. **Small, Composable Modules**  
   - Each feature lives in its own file/folder (`src/core/roon`, `src/server/http`, etc.).  
   - Avoid giant diffs; target ≤150 lines per change where possible.

2. **Incremental Delivery**  
   - Finish and verify one subtask before touching the next.  
   - Record progress at the bottom of this file in the _Progress Log_ table.

3. **Safety Checks**  
   - Never delete or rewrite generated tokens/config (`config/roon-token.json`).  
   - Run `npm run build` (backend) after TypeScript changes; add tests later.  
   - Log important events; do not swallow errors silently.

4. **Documentation First**  
   - Update this plan when scope changes.  
   - Inline TODOs (`// TODO(backend): handle queue updates`) are acceptable.

---

## 2. Architecture Snapshot

- **Backend** (`src/`)
  - `config/` – environment loading, typed config.
  - `core/logger.ts` – Pino logger singleton.
  - `core/roon/` – Roon API gateway (pairing, transport, browse, image).
  - `server/http/` – Express app and REST routes.
  - `server/socket/` – Socket.IO setup + event emitters.
  - `server/server.ts` – composition root tying HTTP, sockets, Roon gateway.
  - `index.ts` – bootstrap, graceful shutdown.

- **Frontend** (`ui/` – to be created)
  - SvelteKit app consuming REST + Socket.IO.
  - Shared TypeScript interfaces for data contracts (will live in `shared/`).

---

## 3. Work Breakdown (Modules & Subtasks)

### Stage A – Roon Gateway Foundation
1. **Token Persistence & Core Status (DONE)**  
   - `RoonClient` saves/loads token and emits `core-status`.
2. **Transport Service Wrapper**  
   - Methods: `playPause`, `next`, `previous`, `setVolume`, `subscribeZones`.  
   - Emit structured events (`zone-state`, `now-playing`) via Socket.IO.
3. **Browse/Search Service Wrapper**  
   - Expose `browse`, `load`, `pop`, `search`.  
   - Normalize outputs into typed interfaces (artists/albums/tracks).  
   - Handle pagination + search drill-down mirroring legacy behaviour.
4. **Image Proxy Helper**  
   - Stream artwork by key; cache headers where sensible.

### Stage B – Backend API Surface
1. **REST Endpoints**  
   - `/api/core` (status), `/api/zones`, `/api/now-playing`, `/api/browse`.  
   - Ensure responses use shared TypeScript interfaces.
2. **Socket Events**  
   - Broadcast updates: `core-status`, `zones`, `now-playing`, `queue`.  
   - Accept minimal commands (`playPause`, `seek`).
3. **Error Handling & Logging**  
   - Central middleware to format errors.  
   - Avoid throwing raw objects; use typed `RoonError`.

### Stage C – Frontend (SvelteKit)
1. **Project Scaffold**  
   - `ui/` directory with SvelteKit template, TypeScript enabled.
2. **State Stores**  
   - `coreStore`, `zonesStore`, `nowPlayingStore`, `browseStore`.
3. **Views**  
   - Dashboard (now playing, zone selector).  
   - Library browser (artists/albums/tracks with breadcrumbs).  
   - Search overlay.  
   - Queue view.
4. **Socket Integration**  
   - Use `socket.io-client` to sync stores.  
   - Implement optimistic UI for transport buttons.

### Stage D – Polish & Ops
1. **Config & Env Validation**  
   - Fail fast when required env vars missing.  
   - Document `.env.example`.
2. **Testing Strategy**  
   - Unit tests for services (Jest).  
   - Integration test harness for Roon (manual script or mock server).
3. **Packaging**  
   - `Dockerfile`, `docker-compose.yml`.  
   - Systemd service sample.
4. **Docs**  
   - Update `README.md` with setup, run, deploy steps.  
   - API reference (`docs/API.md`).  
   - Troubleshooting guide.

---

## 4. Safeguards Against AI Pitfalls

| Pitfall | Safeguard |
| --- | --- |
| Overwriting generated tokens | `.gitignore` already excludes `config/roon-token.json`; never write defaults on startup if file exists. |
| Inconsistent data contracts | Centralize interfaces in `src/shared/types.ts`; import everywhere. |
| Silent promise rejections | ESLint rule `@typescript-eslint/no-misused-promises`; always `await` async calls. |
| Large diffs beyond context window | Keep modules <150 LOC; break features into stages; update plan per change. |
| Forgetting to rebuild | Run `npm run build` post-change; note result in PR/commit message. |
| Missing logs | Use `logger.*` in every catch block; include context (core ID, zone ID). |

---

## 5. Progress Log

| Date (UTC) | Task | Notes |
| --- | --- | --- |
| 2025-10-14 | Initial scaffold | Backend TypeScript project, logger, RoonClient skeleton, Socket.IO wiring |
| 2025-10-13 | A.2 Transport Service | Implemented TransportService with Promise-based playback controls, zone subscription with incremental updates (zones_changed/added/removed), npm run build ✅ |
| 2025-10-13 | A.4 Image Service | Implemented ImageService with streaming, cache headers, optional scaling parameters, npm run build ✅ |
| 2025-10-13 | B.1 REST Endpoints | Created 5 route files (core, zones, transport, browse, image) with typed request/response, service composition in server.ts, npm run build ✅ |
| 2025-10-13 | B.2 Socket Events | Implemented bidirectional Socket.IO (10 command listeners, event broadcasts), acknowledgment pattern with error handling, npm run build ✅ (Codex) |
| 2025-10-13 | B.3 Error Handling | Created typed error hierarchy (RoonError, CoreUnpairedError, etc.), Express error middleware, refactored all TODO markers, npm run build ✅ |
| 2025-10-13 | C.1-C.2 Frontend Foundation | SvelteKit scaffold, 4 stores (core, zones, nowPlaying, browse), REST client, Socket.IO client, npm run build ✅ (Codex) |
| 2025-10-13 | C.3 Views | Created Dashboard, Library browser, Search, Queue, Layout with Svelte 5 runes, npm run build ✅ (a11y warnings acceptable) |
| 2025-10-13 | C.4 Socket Integration | Socket event listeners in stores (Codex), ErrorToast component, optimistic UI for transport controls, hierarchy tracking in browseStore, npm run build ✅ |
| 2025-10-15 | D.1 Config & Env Validation | Added strict env parsing with ConfigError, .env.example, README updates, npm run build ✅ |
| 2025-10-15 | D.3 Packaging | Added Dockerfile, docker-compose, systemd, launchd plist, Windows service script, README instructions, npm run build ✅ |
| 2026-05-02 | Browse/Search Stability | Fixed search result drill-down state corruption; preserved zone and multi-session context through browse load/pop calls; npm run build, npm test -- --runInBand, npm --prefix ui run check, npm --prefix ui run build ✅ |
| 2026-05-02 | Code Review Batch 1 | Image cache hash + validation (path traversal P1), socket ack contract standardization, reconnect hydration via core-status on connect, REST/socket runtime validators, /api JSON 404, token mode 0o600, queue snapshot order preservation + invalid-id drop, errorMessage helper. 25 → 42 tests. All four validations green. See `docs/CODE_REVIEW_COMPARISON_2026-05-02.md` for source findings. |
| 2026-05-02 | Code Review Batch 2 | Helmet + rate-limit + CSV CLIENT_ORIGIN + TRUST_PROXY (LAN-appliance hardening); browse history → sessionStorage store; selectedZone → localStorage; volume type normalization (`db`/incremental→`relative`); volume slider in play bar; image cache LRU at 10 GB; browse paging (100/page + Load more/all + jump-bar auto-load); search UX (group by type, paginate per group, query label, persist on zone change); theme inline pre-hydration script; trace-level Roon payload dump for queue debugging; BrowseService EventEmitter cleanup; Roon graceful shutdown; README + .env.example updated. 42 → 44 tests. New deps: helmet, express-rate-limit. |
| 2026-05-02 | Queue protocol fix (C-3 full + C-20) | Captured raw subscribe_queue traffic from existing service journal. Roon's actual delta format is `{changes: [{operation: "insert"\|"remove", index, items?, count?}]}` — splice semantics, not the items_added/items_changed/items_removed the prior code looked for. Wired positional diff handler; row-0 = current-track invariant replaces fuzzy substring match. 5 new tests. 44 → 49. |
| 2026-05-02 | Codex follow-up fixes | Browse history restore now does popAll + replay full path via REST (P1). Dedup toasts: server sendError uses ack OR event, never both (P2). Socket validators mirror REST (boolean/loop enum/positive int) (P2). Queue splice ops with missing/invalid index or remove count are now refused with a warn log (P2). Zone fan-out: dropped redundant per-zone full-snapshot emits (P3). 49 → 51 tests. |
| 2026-05-02 | Search-rooted browse history restore | `BrowseHistoryState` now persists `searchQuery` alongside the stacks. `restoreBrowse` branches on the deepest saved step's hierarchy: search → re-seed Roon search session via the saved query then walk; browse → popAll then walk. Store hierarchy stays correct throughout restore so subsequent pop/forward target the right Roon multi-session. |
| 2026-05-02 | Mixed-hierarchy browse history | Two-layer fix: `pushHistory` resets the stack when hierarchy switches (browse↔search); `navigateSearchResult` and the search-fallback path in `quickPlay` explicitly `resetHistory()` so each search-result click starts a clean thread. Prevents `restoreBrowse` from replaying a browse step against a freshly-seeded search session, and prevents back/forward incoherence with mixed entries. |
| 2026-05-02 | sessionStorage migration sanitization | `readPersisted` sanitizes stored history to the contiguous tail matching the deepest step's hierarchy, so mixed entries written by older builds don't reach `restoreBrowse` on first remount after upgrade. Forward stack discarded if history was truncated; `searchQuery` cleared if the sanitized tail isn't search. |
| 2026-05-02 | Forward-stack migration sanitization | Forward stack must match history's tail hierarchy, not its own. Otherwise `popForward` would splice a foreign-hierarchy step directly into history, bypassing `pushHistory`'s guard. Now: forward kept only if every entry's hierarchy matches history's; discarded entirely when history is empty. |
| 2026-05-02 | Browse-history storage key versioned | Bumped sessionStorage key to `-v2` to drop any legacy multi-search-result history written before the resetHistory-on-search-click guard. One-time reset to browse root for users with active session history; sessionStorage's per-tab scope cleans the orphaned key when the tab closes. |
| 2026-05-02 | Socket connectivity polish (C-11 + C-18) | socket.io-client now tries websocket then polling so blocked upgrades fall back instead of leaving the UI silent. New `socketStatusStore` separates socket state from Roon core state; status pill shows Connecting / Disconnected / Searching for Core / Connected. `subscribe_zones` handler symmetry: both Subscribed and Changed now process seek changes (no-op when absent). |
| 2026-05-02 | C-11 fix corrections | Two bugs in the C-11 ship: (1) `transports` array alone doesn't fall back without `tryAllTransports: true` — added it. (2) `'disconnected'` status was defined but never set; now branches on disconnect reason (`'io server disconnect'`/`'io client disconnect'` → disconnected; everything else → connecting). New `reconnect_failed` listener on the manager flips to disconnected when retries are exhausted. |
| 2026-05-02 | Finite reconnection budget | Socket.IO defaults `reconnectionAttempts` to Infinity, so `reconnect_failed` is unreachable — the prior listener never fired. Set `reconnectionAttempts: 20`; with default backoff that's ~1.5 minutes before the UI flips to Disconnected and prompts refresh. |
| 2026-05-02 | UI test infrastructure | Vitest + jsdom set up in `ui/`. New scripts `npm --prefix ui test` and `test:watch`. 29 tests added covering `browseHistoryStore` (20: push/pop/forward/reset, sessionStorage round-trip, sanitization matrix, schema versioning), `socketStatusStore` (2), and `register.ts` connectivity transitions (9: connect/disconnect-reason branching, manager `reconnect_failed`, listener cleanup). New deps: vitest, jsdom. |
| 2026-05-03 | Svelte component tests | Added @testing-library/svelte + jest-dom + user-event. Vitest now loads the Svelte plugin so .svelte files compile in tests. 15 component tests: Search (10 — grouping, pagination, query label, callbacks, emit) and ErrorToast (5 — render, source labels, dismiss, auto-clear). Note: Svelte 5 batches reactivity, so post-render store updates need `await tick()` before DOM assertions. Total UI tests: 44; 95 across both halves. |
| 2026-05-03 | Library page integration tests | 11 tests covering the mount-restore matrix (empty / browse-rooted / search-rooted with and without query), zone forwarding, item-click emits + history recording, Home/Back via browseNavStore, loading state, failing-replay-step graceful degradation. Mocks `$lib/api/client` and `$lib/socket/client`; uses real stores. Total UI tests: 55; 106 across both halves. |
| 2026-05-03 | quickPlay + jump-bar + Load more tests | 10 more Library page tests: quickPlay happy path with album-view pop restore, no-play-action fallback to navigate, zone-unselected feedback, search-context skips pop, REST error feedback. Jump bar renders/threshold/scrollIntoView (stubbed). Load more bar shows correct counts and apiBrowseLoad offset/count. Total UI tests: 65; 116 across both halves. |
| 2026-05-03 | Installers up to date | All three installers (Linux/macOS/Windows): wipe `dist`+`ui/build` before redeploy to avoid stale files; `.env` template now mirrors `.env.example` (incl. `IMAGE_CACHE_MAX_BYTES` set, `CLIENT_ORIGIN`/`TRUST_PROXY` commented); `.env` is now preserved across `--reinstall` (was being clobbered, losing user customizations); macOS plist `EnvironmentVariables` and Windows NSSM `AppEnvironmentExtra` add `IMAGE_CACHE_MAX_BYTES`. |
| 2026-05-03 | Search stale-itemKey hotfix | Live redeploy showed search result clicks failing with Roon `InvalidItemKey`: UI re-seeded the search session, then browsed the stale key from the rendered row. Search result clicks and search-track quickPlay now remap against the freshly re-seeded search result list before browse/action lookup. Non-track `action_list` search results navigate instead of quick-playing. Added 3 Library page tests; `npm --prefix ui test` now passes 68 UI tests. Also validated Svelte check, lint, UI build, backend build, and `git diff --check`. |
| 2026-05-03 | Linux installer URL fallback | Live reinstall on the VM completed but printed `hostname: command not found` and `http://:5173`. Replaced the summary's hard dependency on `hostname -I` with `detect_url_host()` (`ip route` src address, then `hostname -I`, then `localhost`). Verified deployed `.env` has `PORT=5173`, so the port was accurate preserved config. `bash -n scripts/install.sh` passed. |
| 2026-05-03 | Search restore stale-itemKey guard | Live navigation hit `Restore stopped...` after route remount: search restore re-seeded query `tori`, got fresh keys, then replayed stale persisted key `29:2`. Search restore now lands at the fresh search root and clears stale drill history instead of replaying unsafe search keys. Browse-rooted restore still replays. Updated Library page tests; targeted `npm --prefix ui test -- page.test.ts` passed (24 tests). |
| 2026-05-04 | Action-list quickPlay guard | Live composer/work flow showed `On Ocean to Ocean by Tori Amos` had `hint: "action_list"` and the UI quick-played its first action (`Play Now`), causing contextual buttons to start playback. `handleItemClick` now quick-plays only explicit `Play ...` action-list buttons and numbered track rows; other action-list items browse normally. Added regression coverage with the exact label; targeted `npm --prefix ui test -- page.test.ts` passed (25 tests). |
| 2026-05-04 | Track-list classification by itemType (C-5) | Replaced title-regex `/^\d/` partitioning with `isTrackItem()` that prefers `item.itemType === 'track'` and falls back to the regex when itemType is absent. `isTrackList` now requires `every(action_list)` AND `some(isTrackItem)`, so pure action_list "Work" pages no longer flip into the track layout. `shouldQuickPlayActionList`: track itemType always quick-plays, otherwise title heuristics decide — `/^play\b/i` is itemType-agnostic so `Play Work` with `itemType: 'work'` still quick-plays; the numeric-prefix fallback is gated on absent itemType. `normalizeItemType()`/`isTrackType()` lowercase + plural-tolerant comparisons match `BrowseService.inferSearchType` style. 6 new Library page tests (itemType-driven tracks incl. classical/un-numbered, legacy regex fallback, Work-page non-classification, itemType precedence over numbered titles, case-insensitive itemType, and `Play Work + itemType=work` quickPlay regression). Validations: 75 UI tests passing, svelte-check 0/0, ui build, backend lint clean. |
| 2026-05-05 | Robust deep search restore (Phase A) | Persisted history step now extends `BrowseOptions` with optional `BrowseBreadcrumb { title, subtitle, imageKey, itemType }`. Storage key bumped to v3. `pushHistory` accepts breadcrumb; all three `recordHistory: true` callsites pass it via `makeBreadcrumb(item)`. New `replaceHistory(steps)` primitive lets restore rewrite the stack with fresh itemKeys. Search-rooted `restoreBrowse` re-seeds the search session, then walks each step matching breadcrumb against fresh results: drills with the new itemKey, stops with a toast on mismatch / missing breadcrumb, partial-success keeps the deepest matched prefix. `forward()` strips breadcrumb before re-issuing the Roon request. 5 new Library page tests covering one-step replay, two-step sequential, mismatch toast, partial-success truncation, and legacy no-breadcrumb stop. |
| 2026-05-05 | Album-jump resolver (Phase B) | Contextual rows like `On Ocean to Ocean by Tori Amos` now attempt an album-page jump instead of opening Roon's play-action menu. `parseAlbumByArtist` parses `<album> by <artist>` titles; `resolveAlbumOrNavigate` re-seeds main search with the album title, scans for an `itemType=album` row whose title matches and whose subtitle contains the artist, and navigates to that fresh search itemKey on hit. On miss, search error, or unparseable title, falls back to `navigate(item)` (the historical action-menu behavior). Bug caught during test: the hierarchy switch must be deferred until a confirmed match — otherwise `setBrowseLoading('search')` upfront made the fallback `navigate` send the contextual row's browse-hierarchy itemKey against the search session. 4 new Library page tests + rewrite of the pre-existing `On Ocean to Ocean` test for the resolver flow. **Live verification required**: without a live Roon Core, can't confirm Roon's search-by-album returns the target album as a top-level result; on miss the resolver fails closed and behavior matches pre-Phase-B. Total UI tests: 83. |
| 2026-05-06 | UX overhaul PR1 + follow-ups | Sticky header workspace, off-canvas hamburger sidebar at <1020px, content cap at 1440px, left-rail Explore with sectioned rendering (top-level + Library children, Settings deferred), `exploreRailStore` with stable `labelPath` identity + multi-session key `'explore-rail-discover'`, refetch on `core-status: paired`, skeleton rail items during resolution, rail-click label-walk via REST. Header `<Search>` routes through `onSubmit` → `pendingSearchStore` + `goto('/library')` so cross-route submissions land where results render. Monotonic resolve token in `exploreRailStore` so stale rail-resolve completions can't overwrite newer ones. Follow-ups: viewport grid with single scroll surface (`.workspace-main`), welcome view in right pane when no browse target, zone selector relocated to play bar, Home → welcome view, Settings on sidebar rail, Library children indented. 91 UI tests passing through all rounds. |
| 2026-05-08 | Disconnected-click readiness-first (R6–R10) | Five rounds of hardening for the disconnected-socket edge. R6: `browse()` and `pop()` check `socket.connected` BEFORE any state mutation; `pop()` calls `popForward()` on emit failure; new `clearBrowseLoading()` undoes optimistic loading state. R7: `forward()` mirrors the pattern; `resolveAlbumOrNavigate` clears loading on each `navigate(item)` fallback. R8: `quickPlay()` search-fallback gates `resetHistory()` on `socket.connected`. R9: removed spurious `setSearchLoading(entry.title)` from Recently Played that was mislabeling the user's visible search results. R10: added `playOnly` option to `quickPlay`; Recently Played opts in so a no-play-action match toasts instead of recording history under the user's prior `lastSearchQuery`. +9 UI tests (120 → 125 across rounds). |
| 2026-05-08 | Recently Played, locally tracked | Confirmed via full hierarchy probe + RoonApiBrowse docs that recent-activity isn't in the public API. New `RecentlyPlayedService` subscribes to `now-playing-updated`, persists to `data/recently-played.json` atomically (mkdir + tmp + rename), caps at 50. `shouldSuppress` noise window (`max(30s, track_duration + 5s grace)`) drops mid-play re-emits, group-play, multi-zone interleaving. `GET /api/recently-played` + `recently-played-inserted` socket broadcast. UI store + welcome-view section, honest "on this controller" labelling. |
| 2026-05-10 | Recently Played: bubble-to-front + clear-all | Move-to-front model — `handleNowPlaying` filters any prior same-key entry before unshift; list holds at most one entry per track. Shared `recentlyPlayedDedupeKey` + `dedupeRecentlyPlayed` in `src/shared/recentlyPlayed.ts` (JSON-tuple key, collision-proof) so backend service + frontend store agree on duplicate identity. Frontend `appendRecentlyPlayedFromSocket` mirrors the bubble client-side. `loadFromDisk` dedupes legacy persisted files. Clear-all: `RecentlyPlayedService.clear()` + `cleared` event, `DELETE /api/recently-played`, `recently-played-cleared` socket broadcast, "Clear" button in the welcome view. Tests across the round trip: backend 80→92, UI 131→137. |
| 2026-05-12 | RP epoch + degraded mode (review rounds 6–9) | Monotonic revision counter on every state change so socket events and REST snapshots can be ordered by clients. Persisted `generation` (epoch) bumped on each `start()`, written alongside entries — survives restarts and never repeats, so a same-ms restart can't reuse an epoch and have clients reject new events as stale. Corrupt JSON / unreadable file → degraded mode: listener not attached, `clear()` rejects, routes 503, broadcasts suppressed; the file is left untouched for inspection. `loadFromDisk` is pure (no mutation, no persist) so a stop+start during the read can't burn a generation. Strict integer validation on persisted generation (non-negative safe integer; floats / negative / NaN-shaped all degrade). `stop()` cancels in-flight `start()` via token. Recoverable from degraded mode via `stop()` + `start()` after admin fixes the file. |
| 2026-05-14 | Component extraction + layout test harness | Extracted `ItemGrid` and `TrackList` from `library/+page.svelte` as reusable components. Browse album track listings (where every row is an `action_list` of track plays) render via `TrackList` for the row-styled layout. `Search.svelte` renders all result groups through `ItemGrid` (track results included) — search rows are visually cards regardless of type because the user is comparing types side-by-side. Pulled `trackTitle` / `trackNum` to `$lib/trackTitle.ts`; both consumers share it. Keyed `{#each}` in both prevents re-mount on list churn. UX shift on tracks (browse path): row-body click no longer plays; the ▶ button (aria-labelled per track) is the canonical play target. Layout-integration test harness (first pass): stubs for `$app/navigation` + `$app/stores` in `ui/src/test/app-stubs/` so vite's resolver doesn't fail on direct `+layout.svelte` imports; 5 tests covering header search submit, mobile hamburger, Explore rail click (on /library and from /queue), play-bar artist click (R7 `searchQuery` regression guard). |
| 2026-05-16 | Two-agent review cycle: M-1 → M-4 + L-1 | First production run of the SETUP.md two-agent workflow (coder + reviewer signalling via `.review/ready/*.json` sentinels and `.review/results/*.{verified.json, reopened.md}` verdicts). Five findings, all verified after multiple reopens on the harder ones. M-1 (rail-nav loses state on REST failure): three reopens shaped the fix from "snapshot current + hierarchy only" → "+error" → "+searchLoading" → final slice-aware `restoreBrowseStateIfUnchanged(prior, afterMutation)` that restores a browse-pane or search-pane slice only if every field in it still equals the post-mutation snapshot — preserves live writes from independent setters (e.g. a `setSearchResults` socket landing during the rail await). M-2 (play-bar nav commits history before drill): one reopen for test-coverage gap; final fix defers `setSearchLoading + resetHistory + pushHistory` until the drill `apiBrowse` resolves. M-3 (RP inserts broadcast before durable persist): one reopen for clear/insert race; final fix serializes `clear()` through the same `insertChain` as inserts so the snapshot/mutate/persist/rollback sequence is atomic across both ops; GET awaits `flush()` so the response is durable. M-4 (queue subscriptions accept unbounded counts): cap at `MAX_QUEUE_SUBSCRIPTION_ITEMS = 50_000` at REST + socket + service. L-1 (no readiness diagnostics): `/api/health` now returns `ready`, per-subsystem `recently_played` block with `degraded`/`epoch`/`revision`/`entry_count`/`last_persist_error`, 503 when degraded. Validations all green across cycle (Jest 110→120, Vitest UI 130→156, tsc/lint/svelte-check/vite build clean). |
| 2026-05-16 | Test infrastructure cleanup (post-review batch) | Three close-out commits after the review cycle: (1) `chore-1` close-out batch (REVIEW.md status flips, reviewer audit trail, brand assets) — initially merged direct-to-main bypassing workflow, caught and redone through chore branch + sentinel. (2) `chore-2` shared test fixtures: factored duplicated `listResult` / `makeItem` / `makeSearchResult` and `createFakeSocket()` into `ui/src/test/fixtures/` so the three callers (Search.test, layout.test, library/page.test) stop drifting. (3) `feat-1` secondary layout-surface tests: 13 new tests for transport controls (play/pause/next/prev/disabled-state), volume (+/- incremental, slider rAF coalescing, fixed-volume absence), theme toggle, seek bar (proportional position, no-emit-when-forbidden), and `openAlbumOfNowPlaying`. Vitest UI 156 → 169. |
| 2026-05-16 | UX overhaul PR2: now-playing overlay + album-page polish | `feat-2` `NowPlayingOverlay` — full-screen-on-mobile overlay rooted in `nowPlayingOverlayStore` (open/close/toggle). Focus management: `$effect` tracks open state, focuses close button on open via `tick().then`, restores `previouslyFocused` on close; window-keydown listener traps Tab/Shift+Tab inside the dialog. Volume slider rAF-coalesced so drag emits at most one socket event per frame. Reopen #1 added the focus trap + rAF coalescing after reviewer flagged keyboard-only users and slider flooding. `feat-3` `albumChips` — derives `{album, artist, year}` chips from now-playing for the album-page header. Two reopens shaped `findYearSpan` (requires a real metadata separator `·` / `/` / `,` / `\|` on at least one side — plain space rejects "The 1975" matching 1975 as a year) and `extractArtistFromSubtitle` (splices only the matched chip span plus ONE adjacent separator, outer trim only, so internal artist punctuation survives: AC/DC, Jay-Z, GZA/Genius). `isAlbumPage` gates rendering on `level≥2 && isTrackList && non-empty subtitle && !inferredAllTracks`. Boundary regex avoids "Wavves"→WAV false-positive. |
| 2026-05-16 | UX overhaul PR3: zone grouping (verified) + standby/wake (in flight) | `feat-4` backend — `TransportService.{groupOutputs, ungroupOutputs, standby, toggleStandby, convenienceSwitch, normalizeSourceControls}` + `ZoneSourceControl` type (`control_key`, `display_name`, `status: selected\|deselected\|standby\|indeterminate`, `supports_standby`). Socket handlers `transport:group`, `transport:ungroup`, `transport:standby` (idempotent — won't wake), `transport:toggle-standby` (separate event for toggle semantics), `transport:wake` (convenience_switch). Reopen #2 split idempotent standby from toggle-standby and surfaced source_controls in the zones broadcast. `feat-5` `ZoneGroupingModal` — flattens all zones to deduped output rows, pre-checks active zone outputs, Group/Cancel via `transport:group`. Reopen shaped two state-handling fixes: (P1) re-seed selection ONLY on closed→open transition (tracked via `wasOpen`) so socket-driven zone refreshes don't clobber the user's checkboxes; (P2) `save()` inspects `emitWithAck` `response.success` and keeps the modal open on failure so the user can retry without losing their selection. `feat-6` standby/wake button — per-output ⏻ in each modal row. Reopen-P1 fix: honor types.ts ZoneOutput contract precisely — render button only when the output has exactly one `supports_standby` source_control; multi-control outputs need a per-control nested menu (deferred). Click emits `transport:standby` / `transport:wake` with the control's `control_key` so the backend targets exactly that control rather than fanning out. State update is server-driven (next zones broadcast); no optimistic flip since Roon may reject. Layout adds Group / Ungroup buttons next to zone selector; `ungroupCurrent()` calls `transport:ungroup` for all outputs except the first. |
| 2026-05-16 | Cached-key fast path on Explore rail clicks (perf-1) | `exploreRailStore` resolver now populates `cachedKey` (leaf itemKey) and `cachedAncestorKeys` (path from level-0 down to but not including the leaf). Layout rail-click handler walks the chain — `popAll`, then drills each `cachedAncestorKeys[i]`, then drills `cachedKey` — and pushes history for each successful drill. Roon browse is stack-based, so every level must be drilled to keep the session stack aligned with UI history; REST call count matches the slow path but each drill skips the per-level title-match scan. Stale keys (post-Core-restart) make any drill fail and the handler falls through to the label-walk fallback; resolver re-runs on the next `core-status: paired` and repopulates the cache. Three reopens: P1 originally skipped ancestor drills entirely (Roon stack diverged from UI history — Back would pop too far); P3 fixed stale top-level docstring claiming the keys were unpopulated. |

Add a row after each significant change. Include tests run & manual verification steps.
