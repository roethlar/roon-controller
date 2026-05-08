# Dev Log

## 2026-05-08 (latest) — Welcome / track-list / play-bar polish round

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
- Dedupes via `title|artist|album|duration|image_key` within a 30s suppression window per zone — collapses Roon's chatty re-emits on seek/pause/metadata-refresh without dropping legitimate consecutive plays.
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
- **15 backend tests** for the service: insert, suppression window (collapse + expire), cross-zone non-dedupe, null payload handling, `inserted` only fires on real inserts, cap enforcement, persisted-file load, atomic write (no leftover `.tmp`), corrupt-JSON recovery, wrong-shape recovery, plausibility filter on load, ENOENT-graceful start, zone-name stamping, `stop()` detaches.
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
