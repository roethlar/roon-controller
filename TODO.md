# TODO

## Active Priorities
- [x] Stop contextual `action_list` buttons from auto-playing
- [x] Fix search result drill-down after browse/search interaction
- [x] Fix live search click regression after redeploy: re-seed search then browse fresh result `itemKey`
- [x] Fix search restore browse error from persisted stale search `itemKey`
- [x] Fix Linux installer summary on VMs without `hostname`
- [x] Preserve Roon browse multi-session context through backend load calls
- [x] Keep search UI state separate from main browse hierarchy

## Action-list quickPlay guard (done — see DEVLOG)
- [x] QuickPlay only explicit `Play ...` action-list buttons and numbered track rows
- [x] Contextual action-list buttons like `On Ocean to Ocean by Tori Amos` browse instead of executing first play action
- [x] Add Library page regression test for contextual action-list click

## Search restore stale-itemKey guard (done — see DEVLOG)
- [x] Stop replaying persisted search drill steps after search re-seed
- [x] Restore saved search query to fresh search root and clear stale drill history
- [x] Keep browse-rooted restore replay behavior unchanged
- [x] Update Library page tests for search restore and quickPlay search-context coverage

## Linux installer URL fallback (done — see DEVLOG)
- [x] Replace `hostname -I` summary dependency with `ip route` / `hostname` / `localhost` fallback
- [x] Verify deployed `/opt/roon-controller/.env` has `PORT=5173`; summary port was matching preserved config
- [x] Syntax-check `scripts/install.sh`

## Search result stale-itemKey hotfix (done — see DEVLOG)
- [x] Remap clicked search result against freshly re-seeded search results before socket browse
- [x] Remap search track quickPlay target before REST action-list lookup
- [x] Restrict search-result quickPlay to track `action_list` rows; non-track action lists navigate
- [x] Add Library page tests for album click, track quickPlay, and non-track `action_list` search result

## Code Review Batch 1 (done — see DEVLOG)
- [x] Hash image cache filenames and validate image route params (C-1)
- [x] Standardize socket ack contract; add `emitWithAck`; wire ack errors to feedback toast (Prior #2 + C-2)
- [x] Emit `core-status` on socket connect; refetch on reconnect; stop conflating socket disconnect with core unpair (Prior #3)
- [x] Runtime validation for REST and socket payloads (Prior #4)
- [x] `/api` JSON 404 before SPA fallback; 32 KB body limit (Prior #5)
- [x] Token file mode 0o600 (Prior #8)
- [x] Preserve queue snapshot order; drop invalid queue items (C-3 partial + C-4)
- [x] `errorMessage` helper used in socket handlers (C-15)
- [x] Tests added for image route, app routing, queue ordering, errorMessage (25 → 42)

## Browse-history storage key versioned (done — see DEVLOG)
- [x] Bumped key to `roon-controller-browse-history-v2` so legacy multi-search-result threads can't survive upgrade

## Forward-stack migration sanitization (done — see DEVLOG)
- [x] Forward stack only kept if every entry shares history's tail hierarchy; otherwise discarded
- [x] Forward always discarded when history is empty (no hierarchy anchor)

## sessionStorage migration sanitization (done — see DEVLOG)
- [x] `readPersisted` sanitizes stored history to the contiguous tail of same-hierarchy steps
- [x] Forward stack discarded when history was truncated (its context is gone)
- [x] `searchQuery` cleared when sanitized tail isn't search hierarchy

## Mixed-hierarchy browse history (done — see DEVLOG)
- [x] `pushHistory` resets the stack on hierarchy switch (browse ↔ search)
- [x] `navigateSearchResult` calls `resetHistory()` before recording (each result is a new thread)
- [x] `quickPlay`'s search-fallback path also resets history before pushing
- [x] searchQuery state correctly carried/dropped across context switches

## Search-rooted browse history restore (done — see DEVLOG)
- [x] BrowseHistoryState persists `searchQuery` alongside the stacks
- [x] `restoreBrowse` branches on the target hierarchy: search → re-seed via the saved query, browse → popAll on browse
- [x] Store's `hierarchy` field set from the target hierarchy throughout restore so subsequent pop/forward target the right session

## Codex follow-up review fixes (first pass — done, see DEVLOG)
- [x] Browse history restore: popAll + replay full path via REST instead of re-browsing the last itemKey from a possibly-wrong stack position (P1)
- [x] Dedup toasts: server `sendError` sends to ack OR event, not both (P2)
- [x] Socket validation parity with REST for `transport:settings` (boolean / loop enum) and `queue:subscribe` (positive int) (P2)
- [x] Queue splice safety: refuse known ops with missing/invalid `index` or remove `count` instead of defaulting (P2)
- [x] Zone fan-out: dropped redundant `zones` snapshot from per-zone update/remove handlers (P3)
- [x] Tests: 49 → 51 (+2 splice safety)

## Queue protocol fix (done — see DEVLOG)
- [x] Captured live `subscribe_queue` payloads from existing service journal
- [x] Implemented positional `changes` diff (insert/remove with index, splice semantics) (C-3 full)
- [x] Current-track row = index 0 (C-20)
- [x] 5 new tests for queue diff scenarios (44 → 49)

## Code Review Batch 2 (done — see DEVLOG)
- [x] Helmet defaults + rate-limit on `/api/*` + `CLIENT_ORIGIN` CSV allowlist + `TRUST_PROXY` switch (Prior #1, C-6, partial)
- [x] Browse history → sessionStorage store (C-10)
- [x] `selectedZone` → localStorage (C-22)
- [x] Volume type normalization: `db` added, unknown types preserved, `relative` mode for incremental (C-8 backend)
- [x] Volume slider in play bar (incremental → ± buttons; absent for fixed-volume) (C-8 UI)
- [x] Image cache LRU at 10 GB (C-13)
- [x] Browse paging: 100/page default, "Load more / Load all" UI, jump-bar auto-loads to find unloaded letters (Prior #6)
- [x] Search UX: group by type, paginate per group, persist on zone change, show query (Prior #7)
- [x] Theme inline pre-hydration script + localStorage try/catch (C-9)
- [x] Browse log levels: info → debug (C-17)
- [x] Search type inference: prefer itemType (C-16)
- [x] Remove dead EventEmitter from BrowseService (C-14)
- [x] Roon graceful shutdown: TransportService.shutdown() called from SIGINT/SIGTERM (C-12)
- [x] Trace-level dump of raw Roon `subscribe_zones` and `subscribe_queue` payloads (unblocks #7 / C-3 full / C-20)
- [x] Documentation: README config table + Security Notes; .env.example expanded

## Socket connectivity polish (done — see DEVLOG)
- [x] Polling fallback in addition to websocket (C-11) — needed `tryAllTransports: true` to actually take effect
- [x] `socketStatusStore` distinguishes socket state from Roon core state
- [x] Status pill shows Connecting… / Disconnected / Searching for Core… / Connected
- [x] `'disconnected'` is now actually reachable: branched on disconnect reason; `reconnect_failed` flips to disconnected (with `reconnectionAttempts: 20` so the budget is finite)
- [x] `subscribe_zones` Subscribed/Changed symmetry (C-18)

## Installer scripts brought up to date (done — see DEVLOG)
- [x] All three installers wipe build artefacts before redeploy
- [x] Linux .env template mirrors .env.example (full comments). macOS/Windows .env templates carry the new vars but not the full comment text — the live config on those platforms is in the plist / NSSM env, where comments aren't supported anyway.
- [x] .env is preserved across `--reinstall` (was being clobbered before)
- [x] macOS plist + Windows NSSM env updated with IMAGE_CACHE_MAX_BYTES
- [x] bash syntax check on Linux + macOS installers; Windows untested locally

## quickPlay + jump-bar + Load more tests (done — see DEVLOG)
- [x] quickPlay happy path: action lookup → Play Now → socket pop restore
- [x] quickPlay fallback to navigate when no play action
- [x] quickPlay zone-unselected → feedback toast, no REST
- [x] quickPlay in search context skips the album-view pop
- [x] quickPlay surfaces REST errors via feedback
- [x] Jump bar renders for >20 items, suppressed for ≤20
- [x] Jump bar click → scrollIntoView spied
- [x] Load more / Load all bar renders correctly
- [x] Load more calls apiBrowseLoad with right offset/count

## Library page integration tests (done — see DEVLOG)
- [x] Mount restore matrix: empty history, browse-rooted, search-rooted (with and without query)
- [x] Selected zone forwarded into replay calls
- [x] Item click → emits browse:browse + records history
- [x] Home / Back via browseNavStore
- [x] Loading state renders
- [x] Failing replay step degrades gracefully
- [x] Total UI tests: 55 (29 stores + 15 components + 11 page integration)

## Component tests via Svelte Testing Library (done — see DEVLOG)
- [x] `@testing-library/svelte` + jest-dom + user-event installed
- [x] Vitest config loads Svelte plugin; setup wires DOM matchers and cleanup
- [x] `Search.svelte` tests (10): grouping, pagination, query label, callback, disabled state, emit, page-size reset
- [x] `ErrorToast.svelte` tests (5): rendering, source labels, dismiss, auto-clear after 5s
- [x] Total UI tests: 44 (29 stores + 15 components)

## UI test infrastructure (done — see DEVLOG)
- [x] Vitest + jsdom configured in `ui/vitest.config.ts`
- [x] `$app/environment` stub for tests
- [x] `npm --prefix ui test` script
- [x] `browseHistoryStore` tests (20)
- [x] `socketStatusStore` tests (2)
- [x] `register.ts` connectivity transition tests (9)

## Track-list classification by itemType (done — see DEVLOG)
- [x] `isTrackItem()` prefers `item.itemType === 'track'`, falls back to `/^\d/` when itemType is absent
- [x] `isTrackList` requires every action_list AND some isTrackItem (so pure action_list "Work" pages don't flip layout)
- [x] `shouldQuickPlayActionList()`: track itemType is the only positive shortcut; explicit `/^play\b/i` quick-plays regardless of itemType; numeric-prefix fallback gated on absent itemType
- [x] `normalizeItemType()` + `isTrackType()` lowercase comparisons (matches `BrowseService.inferSearchType` style; handles `track`/`tracks`)
- [x] 6 new Library page tests: 25 → 31 (UI: 69 → 75)

## Robust deep search restore — Phase A (done — see DEVLOG)
- [x] `BrowseHistoryStep = BrowseOptions & { breadcrumb? }`; storage key bumped `v2 → v3`
- [x] `pushHistory` accepts optional breadcrumb; all three `recordHistory: true` callsites pass `makeBreadcrumb(item)`
- [x] `replaceHistory(steps)` primitive added so restore can rewrite persisted history with fresh itemKeys
- [x] `restoreBrowse` for search hierarchy walks each step via breadcrumb match, uses fresh itemKey, stops gracefully + toasts on mismatch or missing breadcrumb
- [x] `forward()` strips breadcrumb before re-issuing the Roon browse request
- [x] 5 new Library page tests for the breadcrumb walk

## Album-jump resolver — Phase B (done — see DEVLOG)
- [x] `parseAlbumByArtist(title)` parses `"<album> by <artist>"`
- [x] `resolveAlbumOrNavigate(item)` re-seeds main search with album title, scans for an `itemType=album` match (title equals + subtitle contains artist), navigates to the fresh search itemKey on hit, falls back to `navigate(item)` on miss / parse fail / search error
- [x] Hierarchy commit deferred until match confirmed (initial impl polluted state on fallback — caught by test)
- [x] 4 new Library page tests: miss → action-menu fallback, hit → search-hierarchy navigation w/ breadcrumb persisted, wrong-artist match rejected, unparseable title skips resolver

## UX overhaul PR1 — sticky header + left-rail Explore (done — see DEVLOG)
- [x] `exploreRailStore` with stable `labelPath` identity, ephemeral `cachedKey`/`cachedAncestorKeys` reserved
- [x] Resolution via `multiSessionKey: 'explore-rail-discover'`, refetches on `core-status: paired`
- [x] Excludes Settings (level 0) and Search (under Library)
- [x] Empty-state detection at resolve for top-level entries
- [x] Sticky workspace header with back/home/forward + Search (input mode) + theme toggle
- [x] Sidebar: brand → Explore → footer (status + zone selector)
- [x] Hamburger / off-canvas at <1020px
- [x] Content width capped at 1440px
- [x] Skeleton rail items during resolution
- [x] Rail click does label-walk; cached-key fast path deferred
- [x] Search component grew `mode` prop; Library renders `mode="results"`
- [x] 7 new tests in `exploreRailStore.test.ts`, 1 in `Search.test.ts`; 83 → 91 UI total
- [x] R7 follow-up: header `<Search>` routes through `onSubmit` (`pendingSearchStore` + `goto('/library')`) so cross-route submissions land on the page that renders results
- [x] R7 follow-up: monotonic resolve token in `exploreRailStore` so stale rail-resolve completions can't overwrite newer ones

## PR1 follow-ups (done — see DEVLOG)
- [x] Locked panes: viewport grid with single scroll surface (`.workspace-main`); body overflow hidden; sticky declarations removed
- [x] Welcome view in right pane when no browse target; `restoreBrowse` early-returns on empty history
- [x] Zone selector relocated from sidebar footer back to play bar
- [x] Home button → welcome view (no popAll, no socket emit)
- [x] Settings surfaced on the sidebar rail
- [x] Library children indented in the rail to make the tree relationship visible
- [x] 91 tests passing through both rounds of polish

## Disconnected-click readiness-first (done — see DEVLOG)
- [x] `browse()` and `pop()` check `socket.connected` BEFORE any state mutation (no more optimistic hierarchy switch / popped-history-stuck-in-forward)
- [x] `navigateSearchResult` + `resolveAlbumOrNavigate` check `socket.connected` after REST freshen, before `resetHistory` / hierarchy commit
- [x] Test fixture: `fakeSocket.connected = true` in `beforeEach` so disconnect-path test failures don't cascade
- [x] +2 tests: cross-hierarchy disconnected click, empty-history disconnected Back with stale forward

## Disconnected browse state (done — see DEVLOG)
- [x] `emitBrowse` returns `boolean`; `browse()` clears loading + skips `pushHistory` on false
- [x] `pop()` undoes the history pop via `popForward()` on emit failure
- [x] New `clearBrowseLoading()` store helper
- [x] 1 new Library-page test for disconnected click

## Code review round 2 — Docker git, pageSize, image keys, browse emits (done — see DEVLOG)
- [x] Dockerfile installs `git` in backend-build + runtime stages (git+https URLs still need the git binary)
- [x] `BrowseService.loadItemsForList` clamps computed pageSize to `MAX_COUNT` so a single browse can't chain unbounded sequential load() calls
- [x] Search.svelte switched to `imageUrl()` helper (was missed in chunk B)
- [x] `emitIfConnected()` helper for fire-and-forget emits; browse/search call sites no longer buffer+replay while disconnected
- [x] 5 new tests (1 pageSize clamp, 4 emitIfConnected)

## Volume slider rAF throttle (done — see DEVLOG)
- [x] Slider coalesces emits to one per animation frame; final drag-release value still sent

## Code review chunk B — defensive cleanup (done — see DEVLOG)
- [x] API client reads body once as text, parses JSON from that string (was losing non-JSON error responses)
- [x] `ALLOWED_BROWSE_HIERARCHIES` allowlist enforced at REST + socket entry points
- [x] `BrowseService.clamp()` for offset/count/pop_levels
- [x] Centralized `imageUrl()` helper with `encodeURIComponent`; all 5 call sites switched
- [x] `RECENTLY_PLAYED_PATH` and `RECENTLY_PLAYED_CAP` documented in README, `.env.example`, and all three installer templates

## Code review chunk A — token persistence, lockfile, socket buffering (done — see DEVLOG)
- [x] `RoonClient` wires `get_persisted_state` / `set_persisted_state` to `tokenPath` (was using a dead `save_config` callback; node-roon-api's default wrote `config.json` in cwd)
- [x] One-time migration of legacy `config.json` from cwd → `tokenPath`
- [x] Atomic write (tmp + rename), 0o600
- [x] `package.json` and `package-lock.json` use `git+https://github.com/roonlabs/...git` instead of `git+ssh://` so Docker `npm ci` works without git/ssh
- [x] `emitWithAck` fails fast when `socket.connected === false` instead of letting socket.io buffer + replay transport commands on reconnect
- [x] 9 new RoonClient tests (load / save / migration / corrupt JSON / no clobber); 3 new emit tests (disconnected reject, feedback toast, connected happy path)

## Browse-rooted restore via breadcrumbs (done — see DEVLOG)
- [x] `restoreBrowse` now walks browse-hierarchy steps via breadcrumb (mirrors Phase A's search-rooted walk); falls back to raw itemKey only for legacy no-breadcrumb steps
- [x] `replaceHistory(rebuilt)` rewrites the persisted stack with fresh keys
- [x] Fully-failed restore clears history and renders the welcome view (no rail-mirror, no persistent error toast)
- [x] Breadcrumb path preserves `step.multiSessionKey` for parity
- [x] 2 new tests in restore-robustness; 108 → 110 UI total

## Welcome / track-list / play-bar polish round (done — see DEVLOG)
- [x] quickPlay restore depth — popInternal uses levels: 2
- [x] Now-playing indicator on album track list (♫ + accent styling)
- [x] Track-list classifier handles large untyped action_list pages (Library/Tracks, playlist contents); inferred-all-tracks mode keeps the rendering correct
- [x] Play-bar track title → opens album; artist label → opens artist (search-resolve via dedicated hierarchies)
- [x] Header search + theme toggle right-aligned
- [x] Recently Played as horizontal-scroll row
- [x] R-N follow-ups: searchQuery passed to pushHistory in resolveAndNavigate; itemType normalizer accepts plural/case variants

## Disconnected-click hardening rounds R7–R10 (done — see DEVLOG)
- [x] R7 P1: `forward()` checks `socket.connected` before `popForward()` (ghost-history fix, mirrors R6 `pop()` pattern)
- [x] R7 P2: `resolveAlbumOrNavigate` clears loading on each `navigate(item)` fallback (no more stuck "Loading library data…" on disconnect)
- [x] R8 P1: `quickPlay()` search-fallback gates `resetHistory()` on `socket.connected` (no more wiped history while emit bails)
- [x] R8 P2 → R9 superseded: removed the spurious `setSearchLoading(entry.title)` from Recently Played (it was mislabeling the user's visible search results with the Recently Played title; `clearSearchLoading` helper deleted)
- [x] R10: added `playOnly` option to `quickPlay`; Recently Played opts in so a no-play-action match toasts instead of recording history under the user's prior `lastSearchQuery`
- [x] +9 UI tests covering each path (120 → 125)

## Search-result rendering consistency (done — see DEVLOG)
- [x] Extracted `ItemGrid` and `TrackList` from `library/+page.svelte` as reusable components (3 commits — extract, extract, unify)
- [x] `Search.svelte` dispatches per-type groups: `track` → `TrackList`, everything else → `ItemGrid`
- [x] Pulled `trackTitle` / `trackNum` to `$lib/trackTitle.ts`; both consumers share it
- [x] Keyed `{#each}` in both components prevents re-mount on list churn
- [x] UX shift on tracks: row-body click no longer plays; the ▶ button (aria-labelled per track) is the canonical play target
- [ ] **Live verification pending**: card sizing in the search-results panel (now 320×320 sourced, scaled to fit `minmax(180px, 1fr)`) needs a sanity check on real Roon results — particularly track-heavy queries where the search panel was previously a tighter list.

## Layout integration tests (first pass done — see DEVLOG)
- [x] Stubs for `$app/navigation` + `$app/stores` so vite's resolver doesn't fail on direct `+layout.svelte` imports
- [x] `ui/src/routes/__tests__/layout.test.ts`: header search submit (R7 fix), mobile hamburger, Explore rail click on /library, Explore rail click from /queue, play-bar artist click (R7 `searchQuery` regression guard)
- [x] 5 new tests (125 → 130 UI total)
- [x] Follow-up — shared test fixtures: `listResult` / `makeItem` / `fakeSocket` now live in `ui/src/test/fixtures/{browse,socket}.ts` (chore-2 verified 2026-05-16)
- [x] Follow-up — secondary layout surfaces: transport controls (play/pause/next/prev), volume slider rAF coalescing, hamburger toggle, header search submit all covered in `routes/__tests__/layout.test.ts` (chore-3 secondary tests 2026-05-16)

## Recently Played, locally tracked (done — see DEVLOG)
- [x] Confirmed via full hierarchy probe + RoonApiBrowse docs that recent-activity is not in the public API
- [x] `RecentlyPlayedService` subscribes to now-playing-updated, persists to `data/recently-played.json` atomically, caps at 50
- [x] `shouldSuppress` noise window (`max(30s, track_duration + 5s grace)`) drops mid-play re-emits, group-play, multi-zone interleaving
- [x] `GET /api/recently-played` + `recently-played-inserted` socket broadcast
- [x] UI store + welcome view section, honest "on this controller" labelling

## Recently Played: bubble-to-front + clear-all (done — see DEVLOG)
- [x] Fixed duplicate-on-replay: deployed version logged a second entry when a track was replayed past its noise window
- [x] Move-to-front model — `handleNowPlaying` filters any prior same-key entry before unshift; list holds at most one entry per track
- [x] Shared `recentlyPlayedDedupeKey` + `dedupeRecentlyPlayed` in `src/shared/recentlyPlayed.ts` (JSON-tuple key, collision-proof) so backend service + frontend store agree on duplicate identity
- [x] `appendRecentlyPlayedFromSocket` mirrors the bubble client-side; idempotence guard compares the dedupe key too
- [x] `loadFromDisk` dedupes legacy persisted files on load
- [x] Clear-all: `RecentlyPlayedService.clear()` + `cleared` event, `DELETE /api/recently-played`, `recently-played-cleared` socket broadcast, store `clearRecentlyPlayedEntries`, "Clear" button in the welcome view
- [x] Tests across the round trip (backend 80→92, UI 131→137)

## Recently Added (deferred)
- [ ] Not in the public API. Could approximate by drilling `albums` hierarchy with `set_display_offset` to the end (last albums alphabetically aren't necessarily most-recently-added; not useful). True "Recently Added" requires private API access we don't have.

## Next Iteration (open)
- [ ] Live verification on Roon Core after PR1 redeploy:
  - [ ] Layout: right pane is the only scroll surface; left, top, bottom panes locked
  - [ ] Welcome view appears on first /library load (no Explore duplication)
  - [ ] Zone selector works from play bar
  - [ ] Rail entries render and respond to clicks
  - [ ] Header search from /queue routes to /library and shows results (R7 fix)
  - [ ] Search result click drills without browse errors (Phase A regression check)
  - [ ] Core reconnect/re-pair refreshes the rail without hiding entries (R7 token guard)
  - [ ] Stale-key recovery: kill the Roon Core, click a rail entry, expect silent label-walk recovery
  - [ ] Mobile (<1020px): hamburger opens/closes rail; clicking a rail entry closes the overlay
  - [ ] Theme toggle persists across refresh
  - [ ] Queue button still works from the play bar
- [ ] Live verification carryover from earlier PRs: search drill + remount (Phase A); `<album> by <artist>` resolver hits/misses (Phase B); composer/work flow doesn't auto-play; queue positional updates.
- [ ] **Redeploy required**: `sudo ./scripts/install.sh --reinstall` to pick up PR1.
- [x] PR2 from the UX overhaul plan: now-playing overlay (feat-2), album page polish — artist/year chips (feat-3) — both verified 2026-05-16
- [ ] PR3: zone grouping + standby/wake — backend transport methods (feat-4 verified 2026-05-16), modal grouping UI (feat-5 verified 2026-05-16) shipped; standby/wake button (feat-6) is in-flight — currently queued with the reopen-P1 fix that honors the types.ts ZoneOutput contract (single supports_standby control → button, multiple → deferred nested menu)
  - [ ] Follow-up: multi-control per-output standby menu (deferred from feat-6 reopen)
- [x] Cached-key fast path on rail clicks — `cachedKey` + `cachedAncestorKeys` populated by resolver, layout walks chain to keep Roon session stack aligned with UI history (perf-1 verified 2026-05-16)
- [x] Layout-integration tests (R7 residual risk): header search submit + mobile hamburger + rail click from /queue all in `routes/__tests__/layout.test.ts`

## Documentation / Collaboration
- [x] Maintain `DEVLOG.md`
- [x] Maintain `TODO.md`
- [x] Save comprehensive code review in `docs/CODE_REVIEW_2026-05-02.md`
- [x] Compare and validate Claude's review in `docs/CODE_REVIEW_COMPARISON_2026-05-02.md`
- [ ] Keep `docs/PLAN.md` progress log current after each meaningful change
