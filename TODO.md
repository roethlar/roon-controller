# TODO

## Active Priorities
- [x] Fix search result drill-down after browse/search interaction
- [x] Preserve Roon browse multi-session context through backend load calls
- [x] Keep search UI state separate from main browse hierarchy

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

## Next Iteration (open)
- [ ] Track-list detection: replace title-regex `/^\d/` with hint/itemType-based partitioning (C-5). Defer until live evidence rendering is wrong.
- [ ] Manually verify on live Roon Core after redeploy: search → click album/artist/track → nested browse/back → click another search result.
- [ ] Manually verify queue protocol fix after redeploy: skip a track, Play Next from Roon iOS app, confirm rows update positionally.
- [ ] **Redeploy required**: `sudo ./scripts/install.sh --reinstall` — current systemd service is still running the pre-batch code.

## Documentation / Collaboration
- [x] Maintain `DEVLOG.md`
- [x] Maintain `TODO.md`
- [x] Save comprehensive code review in `docs/CODE_REVIEW_2026-05-02.md`
- [x] Compare and validate Claude's review in `docs/CODE_REVIEW_COMPARISON_2026-05-02.md`
- [ ] Keep `docs/PLAN.md` progress log current after each meaningful change
