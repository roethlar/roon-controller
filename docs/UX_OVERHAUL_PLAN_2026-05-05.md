# UX overhaul plan — 2026-05-05

Author: Claude. Reviewer: GPT (round 1 review folded in below).
Status: revised through five GPT review rounds (R1-R5). Q1-Q16
answered; rail-population strategy rewritten after pushback;
live-Core investigation complete (artifact:
`docs/roon-browse-tree-2026-05-05.{md,json}`). Plan is
implementation-ready for the captured Core layout; re-running the
capture against a different Core would surface a different rail set
and the implementation handles that data-driven by design.

## Review log

- **R1 (GPT, 2026-05-05)**: flagged a critical bad assumption — I
  assumed the native left-rail items were all at browse-hierarchy
  level 0. Live journal evidence shows the actual root is closer to
  `Library, Playlists, My Live Radio, Genres, Settings`. Most "My
  Library" entries (Albums, Artists, Tracks, Composers, Compositions,
  Folders) are nested one level under Library. Plan rewritten to
  reflect this; new pre-PR1 task added to capture the live root
  payload before designing the rail. Q1-Q16 answered; sections below
  updated in place.
- **R2 (GPT, 2026-05-05, post-R1 revision)**: four findings, all
  addressed in place:
  1. Rail stale-key recovery was self-referentially stale because
     `parent` was also an ephemeral itemKey. Rail entry shape now
     uses `labelPath: string[]` as canonical identity, with
     `cachedKey`/`cachedAncestorKeys` treated as advisory cache;
     click handler always has a label-walk recovery path mirroring
     Phase A's breadcrumb walk in `restoreBrowse`.
  2. Removed the placeholder bookmark/profile bullet from the
     sticky header section that contradicted the hard "no unwired
     icons" rule.
  3. Pre-PR1 capture promoted from "enable trace logs" to "run
     `scripts/capture-browse-tree.mjs` and commit the sanitized
     markdown artifact"; trace logs kept as a fallback only.
  4. Store name standardized to `exploreRailStore` everywhere; old
     `exploreItemsStore` reference removed.
- **R3 (GPT, 2026-05-05, post-live-capture)**: four findings on the
  capture script and artifact, all addressed:
  1. The first artifact (`docs/roon-browse-tree-2026-05-05.{md,json}`,
     since deleted) included real album, track, artist, composer,
     and playlist data — personal even with item_keys redacted.
     Script default is now structural-only: level 0 + level 1 under
     `Library` only. Personal content samples are gated behind
     `--include-content-samples` and the resulting artifact is
     marked private (header + stderr warning); not for commit.
  2. Level 2 capture removed from default for the same reason —
     content samples aren't needed for rail design.
  3. Base URL replaced with `<configured-base>` placeholder in the
     artifact body so internal LAN IPs don't get committed.
  4. Same-day filenames now refuse to overwrite without `--force`.
     Content-samples artifacts get a `-with-content` suffix to
     distinguish them visually from the safe-to-commit default.
- **R4 (GPT, 2026-05-05, post-R3 fixes)**: five findings, all
  addressed:
  1. **P2** — capture script's browse calls had no
     `multiSessionKey`, so a `popAll: true` would clobber the live
     UI's main browse stack. Script now uses a dedicated
     `CAPTURE_SESSION_KEY = 'capture-browse-tree'` on every browse
     call.
  2. **P2** — rail-click cached-key path direct-browsed the leaf
     itemKey with `popAll: true`, which doesn't traverse Roon's
     stack-based hierarchy. Pseudocode rewritten to walk
     `cachedAncestorKeys` step-by-step before drilling the leaf;
     on `InvalidItemKey` at any step, falls through to the
     label-walk recovery path (which also refreshes the cache on
     success).
  3. **P3** — `--include-content-samples` artifacts now ignored
     via `.gitignore`: `docs/roon-browse-tree-*-with-content.{md,
     json}`. The naming suffix (added in R3) plus the gitignore
     pattern make the private variant unstageable by mistake.
  4. **P3** — stale PR2 wording removed: "new route or overlay
     (open question)" replaced with the resolved overlay/sheet
     description; PR2's "Files touched" updated to reference an
     overlay component, not a route.
  5. **P3** — capture script header example URL changed from a
     real LAN address to `<host>:<port>`.
- **R5 (GPT, 2026-05-05, post-R4 fixes)**: four P3 findings, all
  addressed:
  1. `cachedAncestorKeys` interface comment said "same length as
     labelPath" but the corrected pseudocode requires
     `labelPath.length - 1`. Comment updated to match — prevents
     PR1 from reintroducing the R4 bug.
  2. Plan status line said "live-Core investigation required
     before PR1 starts." Investigation is complete (artifact
     committed); status now reflects implementation-ready.
  3. The "Concrete rail layout" section pre-asserted that
     `Tags` and `My Live Radio` are muted-empty. The committed
     artifact only proves level 0 + level 1 under Library;
     level-2-or-deeper empty-state on those entries was only
     observed in the deleted `--include-content-samples` capture.
     Rephrased: rail treats every entry as live until proven
     empty at runtime via the empty-container handling rule.
  4. Capture script's `--include-content-samples` mode re-drilled
     Library (and siblings during the level-1 loop) without
     `popAll`, which is fragile against Roon's stack-based
     browse hierarchy. Added `popAll` resets before each
     potentially-stack-aware drill (level-1 loop in content
     mode, level-2 Library re-entry, level-2 sibling drills).
- **R6 (GPT, 2026-05-05, post-R5 fixes)**: no blocking findings;
  one cosmetic note (R4/R5 ordering in the review log) addressed
  by this entry. Reviewer recommendation: commit + start PR1.
- **Live capture findings (2026-05-05, structural)**: previous capture
  read against the live Core surfaced this structure (since deleted;
  re-running with the new structural-only default produces a
  commit-safe equivalent):
  - Level 0 root is titled "Explore" — matches the rail's section
    label naturally.
  - Level 0 entries: `Library`, `Playlists`, `My Live Radio`,
    `Genres`, `Settings`. (Settings excluded by filter as planned.)
  - Level 1 under `Library`: `Search`, `Artists`, `Albums`,
    `Tracks`, `Composers`, `Tags`. (`Search` excluded from the rail
    — the layout already has a top-bar search input. So the rail
    surfaces `Artists`, `Albums`, `Tracks`, `Composers`, `Tags`.)
  - **No `History`, `Listen Later`, or `Home` exist** in this
    Core's hierarchy. The plan no longer assumes those items
    are reachable. If the user wants them surfaced later, that's a
    Roon Core configuration question, not an extension capability.
  - All entries at levels 0-1 carry `hint: 'list'` and
    `itemType: null`. Rail filter uses `hint === 'list'` (not
    `itemType`).
  - `My Live Radio` returned "No Results" (zero items) on this
    Core. `Tags` likely empty too — but level 2 captures are no
    longer in the default artifact (R3), so empty-state for level-2
    sub-nodes (like `Library / Tags`) is detected at runtime, not
    encoded in the committed artifact. The rail's empty-state
    rendering rule is unchanged: drill at first display, render
    muted if zero `hint: 'list'` children come back.
  - `Playlists` contains user-defined entries (3 in this Core).
    Pre-expanding Playlists in the rail would clutter it; rail
    surfaces `Playlists` as a single click-to-list entry. Drilling
    in shows the user's playlists in the right pane.
  - `Genres` has 100+ subgenres. Same treatment as Playlists —
    single rail entry, drill in to see the full list.

## Goals

Close the gap between this controller and the native Roon app along the
dimensions that the user flagged in conversation today:

1. Reclaim screen space — the current left rail (~20% of the viewport)
   carries only the brand, status pill, and 2 nav buttons.
2. Top-of-page locked nav + Search so they stay visible across routes
   and through scroll.
3. Surface the audio-device controls Roon's public API actually
   exposes (zone grouping, standby/wake) — and clearly mark the ones
   that aren't reachable so we don't pretend.
4. Decide what's worth building toward parity vs. what's a UI flourish
   we can't actually back with data.

## API surface — what we have, what we don't

Verified against the four installed `node-roon-api*` packages.

### Available (and worth wiring)

- `transport`:
  - `group_outputs(outputs)` / `ungroup_outputs(outputs)` — zone grouping
    (matches native screenshot 2).
  - `standby(output, opts)` / `toggle_standby(output, opts)` /
    `convenience_switch(output, opts)` — wake / sleep devices.
  - `transfer_zone(fromZ, toZ)` — move playback between zones.
  - `change_settings(z, settings)` — already wired (shuffle / loop /
    auto_radio).
  - `change_volume(output, how, value)` — already wired; `how`
    supports `relative` for incremental outputs.
  - `mute(output, how)` / `mute_all(how)` — partly wired; `mute_all`
    isn't surfaced in the UI.
- `browse`:
  - The full top-level hierarchy is a browse call away
    (`browse({ hierarchy: 'browse', popAll: true })`). **Per live
    journal evidence, level 0 contains a smaller set than native's
    rail — closer to `Library, Playlists, My Live Radio, Genres,
    Settings`.** Most "My Library" entries (Albums, Artists, Tracks,
    Composers, Compositions, Folders) are nested one level under
    `Library`. History / Listen Later / Tags / Home likewise need
    verification — they may be at level 0, or they may be sub-items
    of `Library` or of `Home`. **The exact tree must be captured live
    before PR1 design is finalized — see "Pre-PR1 investigation"
    below.**
- `image`:
  - Already used.

### NOT available via the public extension API

Confirmed by enumerating registered services
(`com.roonlabs.{transport:2, browse:1, image:1, pairing:1, ping:1,
registry:1}`). Anything outside these services is private and only
reachable by Roon Labs' first-party clients.

- **Soundprint / waveform / peaks**. Roon Labs absolutely runs audio
  analysis at import time and stores per-track peak data — but the
  data is gated to first-party clients. No third-party extension can
  fetch it. Best a controller like ours can offer is a deterministic
  pseudo-waveform seeded by the track ID; visually similar, will not
  correlate with the actual audio.
- **MUSE / DSP / Parametric EQ / Headphone EQ / Crossfeed / Sample-rate
  conversion / Headroom management**. All in screenshots 5-6. Not in
  the API.
- **Device setup** (DSD strategy, MQA capabilities, volume control mode,
  resync delay, private-zone toggle). Screenshot 7. Not in the API.
- **Audio-device discovery / enable / disable**. The "Settings → Audio"
  page (screenshot 8) is built on private services.
- **Zone settings**: zone name, zone icon, crossfade time, volume
  leveling. Screenshot 4. Not in the API.
- **Playlist creation / mutation / deletion**. Browseable but not
  mutable from extensions.
- **Queue mutation** beyond enqueue: no `remove_from_queue`, no
  reorder. We can `play_from_here(zone, queue_item_id)` and that's it.
- **Lyrics**. No service exposes them.

We will display nothing that pretends to be one of the unreachable
features. If it has an icon, the icon does something.

## Pre-PR1 investigation (must complete first)

We don't actually know the live shape of the browse root. Before PR1
design is locked, we need a structured capture from the live Core.

**R2 update**: trace logs are noisy and prone to missing fields. The
primary capture mechanism is a small scripted REST run; trace logs
remain a fallback for debugging the script itself.

**Primary capture — scripted via `/api/browse`**:

`scripts/capture-browse-tree.mjs` hits the running service's REST
endpoint, walks the configured nodes, and writes a sanitized
markdown + JSON pair under `docs/roon-browse-tree-<YYYY-MM-DD>.{md,
json}`.

**Default mode is structural-only (R3)**: level 0 + level 1 under
`Library` only. This is the layer the rail design needs and nothing
more. The artifact is safe to commit:

- `itemKey` values redacted to stable shape tokens (`<key:N>`).
- `base` URL replaced with the placeholder `<configured-base>`.
- No level 2 content (no album/track/artist/composer samples).
- No level 1 under non-Library containers (no user playlist names,
  no genre lists).

The structural-only default surfaces:
- Level 0 entries (titles, hints, itemTypes).
- Level 1 entries under `Library` (Artists/Albums/Tracks/Composers/
  Tags etc.).

It does NOT surface, by design:
- Whether a level-1-or-deeper container is empty. That's detected
  at runtime by the rail population code (empty-container handling
  rule in the Rail population strategy section).

Sanitized record per item:

```json
{
  "level": 0,
  "path": ["root"],
  "title": "Library",
  "itemKey": "<key:1>",
  "hint": "list",
  "itemType": null
}
```

Procedure:

1. With the service running and a Roon Core paired, run
   `node scripts/capture-browse-tree.mjs --base
   http://<service-host>:<port>`.
2. The script writes `docs/roon-browse-tree-<YYYY-MM-DD>.{md,json}`.
3. Verify the artifact contains no personal content (album titles,
   playlist names, etc.) — by default it shouldn't, but eyeball it.
4. Commit.

**Re-running**: same-day artifacts refuse to overwrite without
`--force`, so iterating is safe.

**`--include-content-samples` (DO NOT commit)**: drills further to
include level-2 content under Library and level-1 under non-Library
containers. Useful for one-off investigations of how Roon labels
content. The resulting artifact is suffixed `-with-content` and
carries an explicit "Private artifact. Do not commit." header. The
script also stderrs a warning at the end of a content-samples run.

A leaky first-run artifact was deleted before commit on 2026-05-05;
do not re-create one without the `--include-content-samples` flag.

**Fallback — trace logs**: if the scripted capture is blocked
(service down, REST flaky), fall back to `LOG_LEVEL=trace` + manual
`browse:browse` calls and grep for the payload in journalctl. Treat
this as a debugging aid only; the markdown artifact is the
authoritative reference.

Skipping this step means PR1 would ship a rail with hardcoded label
assumptions ("Albums" lives at level 0, "History" lives at level 0)
that will silently break for any user whose Core layout differs.

## PR1 — Layout overhaul (sticky top + left-rail Explore)

The biggest change. Rewrites `+layout.svelte` and trims down
`/library/+page.svelte`.

### What ships

1. **Sticky header bar** at the top of the workspace, full-viewport
   width above the right pane. Contains:
   - Back / Home / Forward nav cluster (currently in workspace-header,
     stays put visually but commits to `position: sticky; top: 0`).
   - Search input (relocated from the Library page).
   - Theme toggle.
   - No bookmark / profile / three-dot affordances — see "Things I
     deliberately ruled out" below.

2. **Left rail rebuild**. Replace the current 3-section rail (brand,
   status, nav) with native-Roon-like structure:
   - **Top**: brand block (small).
   - **Middle**: Explore section. Populated from a hand-resolved set
     of browse-hierarchy entries — see "Rail population strategy"
     below. Click → drill into that node in the right pane (right pane
     stays on `/library`, browse store updates). This replaces the
     current "Browse" link.
   - **Bottom (sticky footer of the rail)**: status pill, zone
     selector (relocated from the play bar). Theme toggle stays in the
     sticky header only (Q2 answer); not duplicated in the footer.

3. **Search relocation**. The Search component currently lives inside
   `/library/+page.svelte`. Moving it into the layout means it must:
   - Emit search submissions through `pendingSearchStore` (already the
     mechanism the Layout uses for play-bar artist/album links).
   - When invoked from a non-Library route, navigate to `/library` and
     trigger the search. Already supported by the existing
     `pendingSearchStore` + Library mount logic.
   - Not double-render: we delete the `<section class="search-panel">`
     block from the Library page.

4. **Queue's home (Q3 answer: option A)**. `/queue` route stays.
   Sidebar's Queue entry is removed. The play bar's "Queue" pill is
   the only entry point in PR1. PR2 will explore inline-queue inside
   now-playing (Q8); the `/queue` route remains until that overlay is
   feature-complete.

### Rail population strategy (revised after R1, R2)

Per the live journal evidence, we cannot assume every native
left-rail item is at browse level 0. The rail must be assembled from
multiple browse calls.

**R2 correction — identity is the label path, not the itemKey.**
The first revision stored `{ label, itemKey, parent? }` where
`parent` was also an ephemeral item_key. That made the cache
self-referentially stale: after a Core restart the parent key is
gone and the retry path has nothing stable to walk back to. The
correct identity (mirroring the Phase A search-restore breadcrumb
pattern in `+page.svelte`'s `restoreBrowse`) is the **labelPath** —
the chain of titles drilled through to reach the entry. Item_keys
are an ephemeral cache, treated as advisory and refreshed by
walking the labelPath.

**Concrete rail layout (against the 2026-05-05 captured Core)**:

```
Library         (section header, not clickable)
  Artists       — drills 2 levels, labelPath ["Library", "Artists"]
  Albums        — drills 2 levels, labelPath ["Library", "Albums"]
  Tracks        — drills 2 levels, labelPath ["Library", "Tracks"]
  Composers     — drills 2 levels, labelPath ["Library", "Composers"]
  Tags          — drills 2 levels, labelPath ["Library", "Tags"]

Playlists       — drills 1 level, labelPath ["Playlists"]
Genres          — drills 1 level, labelPath ["Genres"]
My Live Radio   — drills 1 level, labelPath ["My Live Radio"]
```

`Settings` excluded by filter. `Search` under Library excluded —
top-bar search supersedes it.

The committed structural artifact only proves level 0 and level 1
under `Library`; whether `Tags` (level 2) or `My Live Radio` (level
1 under a non-Library container) are empty isn't encoded there. The
rail therefore treats every entry as live until proven empty: on
first display (or on `core-status: paired`), the rail population
code drills each entry's first page and applies the muted style if
zero `hint: 'list'` children come back. The earlier
`--include-content-samples` capture (deleted; see R3) showed both
were empty on this Core at that moment, but treating that as a
fixed fact would couple the rail to a transient Core state.

**Cached entry shape**:

```ts
interface ExploreRailEntry {
  // Stable identity — preserved across Core restarts.
  label: string;             // The title displayed in the rail.
  labelPath: string[];       // ["Library", "Albums"] for nested entries;
                             // ["Genres"] for top-level entries.

  // Ephemeral cache — refreshed by walking labelPath when stale.
  cachedKey?: string;        // Resolved item_key for the leaf.
  cachedAncestorKeys?: string[]; // Length = labelPath.length - 1 —
                                 // one key per parent level we drilled
                                 // through, in labelPath order. Empty
                                 // for top-level entries (labelPath
                                 // length 1). Optional; a click
                                 // without these falls through to the
                                 // label-walk recovery path.
}
```

The store name is `exploreRailStore` everywhere (not
`exploreItemsStore`).

**Resolution algorithm** (runs at layout mount and on `core-status:
paired`/reconnect — Q1 answer; no periodic polling):

1. `browse({ hierarchy: 'browse', popAll: true })` → capture level-0
   items. Live evidence (2026-05-05) shows: `Library`, `Playlists`,
   `My Live Radio`, `Genres`, `Settings`. Other Cores may differ —
   the resolution is data-driven, not hardcoded.
2. For each level-0 item with `hint === 'list'` that isn't in the
   exclusion list (today: `Settings`), record
   `{ label, labelPath: [label], cachedKey: itemKey }`.
3. For configured rail expansions, drill one level. Today's
   configured expansion is `Library` — drill into it and record
   each child with `hint === 'list'` (excluding `Search` —
   redundant with the top-bar search input) as a nested rail entry
   with `labelPath: ['Library', child.title]` and
   `cachedAncestorKeys: [<library-key>]`. Top-level entries with
   many children that don't make sense pre-expanded (`Genres` —
   100+ subgenres; `Playlists` — user list; `My Live Radio` —
   provider list) are intentionally NOT in the configured-expansion
   set; user clicks the rail entry to drill in via the right pane.
4. **Empty-container handling**: during step 2/3 drills, if a
   container's first-page result has zero `hint === 'list'`
   children (e.g. live capture showed `My Live Radio` returned
   `No Results`, `Tags` returned `_(empty)_`), render the rail
   entry in muted style and skip its expansion. Do not omit it —
   surfacing the empty state matches native Roon and confirms to
   the user that their Core has no live radio configured (vs. our
   UI being broken).
5. Apply the filter list: `Settings` excluded by name. Anything
   with `hint !== 'list'` at this level is logged + excluded
   rather than guessed at.
6. Persist the resulting `ExploreRailEntry[]` in `exploreRailStore`.

**Click handling** (always works regardless of cache freshness):

Roon's browse hierarchy is stack-based per multi-session — drilling
into a deeply-nested itemKey directly does not synthesize the
intermediate levels. To land on `["Library", "Albums"]` we have to
`popAll`, then drill `Library`, then drill `Albums`. The cached-key
path therefore walks the full ancestor chain step by step, not a
single direct browse to the leaf.

```text
on rail-click(entry):
  resetHistory()                 // fresh nav thread

  // Cached-key fast path — only if we have keys for every step.
  // labelPath = [..., leaf]; cachedAncestorKeys are the keys for
  // labelPath[0 .. len-2]; cachedKey is the leaf key.
  let canFastPath =
    entry.cachedKey &&
    (entry.cachedAncestorKeys?.length ?? 0) === entry.labelPath.length - 1

  if (canFastPath) {
    try {
      // Reset session, then drill ancestor → ... → leaf.
      let cur = await apiBrowse({ popAll: true })
      for (let i = 0; i < entry.cachedAncestorKeys.length; i++) {
        cur = await apiBrowse({ itemKey: entry.cachedAncestorKeys[i] })
        pushHistory(<step>, breadcrumb { title: entry.labelPath[i] })
      }
      cur = await apiBrowse({ itemKey: entry.cachedKey })
      pushHistory(<step>, breadcrumb { title: entry.labelPath[last] })
      return cur
    } catch (err if InvalidItemKey at any drill) {
      resetHistory()           // clear partial pushes
      // Fall through to label-walk recovery.
    }
  }

  // Recovery / cold start — walk labelPath by title match,
  // exactly like restoreBrowse's breadcrumb walk.
  let cur = await apiBrowse({ popAll: true })       // browse root
  let freshAncestorKeys = []
  let freshLeafKey = undefined
  for (let i = 0; i < entry.labelPath.length; i++) {
    let label = entry.labelPath[i]
    let match = cur.items.find(it => it.title === label)
    if (!match?.itemKey) {
      pushFeedbackToast(`Rail entry "${label}" no longer in results`)
      return
    }
    cur = await apiBrowse({ itemKey: match.itemKey })
    pushHistory(<step>, breadcrumb { title: label, ... })
    if (i < entry.labelPath.length - 1) freshAncestorKeys.push(match.itemKey)
    else freshLeafKey = match.itemKey
  }

  // Refresh the cache so subsequent clicks take the fast path.
  exploreRailStore.updateEntry(entry, {
    cachedKey: freshLeafKey,
    cachedAncestorKeys: freshAncestorKeys
  })
```

The label-walk path is the authoritative one. The cached-key path
is a fast skip when nothing's changed. The two-mode design means
PR1 ships the recovery path on day one, not as a follow-up.

**Stale-key invalidation triggers**:

- `core-status: paired/reconnect` → drop all `cachedKey` /
  `cachedAncestorKeys` (preserve `labelPath`), then re-resolve via
  the resolution algorithm. The rail UI shows skeletons during the
  re-resolve; existing labels are kept visible (paths are stable)
  so layout doesn't shift.
- `InvalidItemKey` from Roon during a click → silently fall
  through to the label-walk path; on success, refresh the entry's
  cached keys. No user-facing toast for this case (the user just
  wanted to see Albums; they shouldn't see plumbing).
- Total resolution failure (label not found at any level) → the
  feedback toast above. This is rare and represents a genuine Core
  configuration change.

### Files touched

- `ui/src/routes/+layout.svelte` — header restructure, sidebar
  rebuild, sticky positioning, Search relocation.
- `ui/src/routes/library/+page.svelte` — drop the Search panel block;
  keep everything else (the Library mount/restore logic stays as-is
  since it just operates on whatever browse target is set).
- `ui/src/lib/components/Search.svelte` — minor: ensure it renders
  acceptably in a constrained header slot (currently styled as a
  card-sized panel).
- New stores or extensions to existing ones:
  - `exploreRailStore` — holds the `ExploreRailEntry[]` described in
    the Rail population strategy section. Stable label-paths are
    the canonical identity; `cachedKey` / `cachedAncestorKeys` are
    ephemeral and may be cleared/refreshed at any time without
    affecting the rail's visible labels.
- `ui/src/lib/stores/index.ts` — export the new store + entry type.

### Implementation notes

- See "Rail population strategy" above for the multi-level resolution
  and stale-key invalidation details.
- The breadcrumb metadata work from Phase A applies here unchanged:
  rail clicks push breadcrumbs so a route remount can replay them.
  Nested rail entries push two breadcrumbs (the parent drill + the
  target).
- Narrow viewports (Q4 answer): the rail collapses to a hamburger /
  off-canvas panel below ~1020px. Don't stack the full rail above
  content — that defeats the purpose of the overhaul. The current
  layout's stack-on-narrow rule is replaced.
- Status pill / zone selector cohesion (Q6 answer): light pass —
  match border radius, spacing, label style across the three
  controls in the sidebar footer. Don't redesign individual controls
  in PR1.
- Right-pane width (Q13 answer): cap content width at 1280-1440px on
  ultrawide; allow grids to breathe but avoid edge-to-edge. Existing
  pages currently consume full width; this becomes a `.workspace-main`
  rule rather than per-page changes.
- Loading state for the rail (Q14 answer): skeleton items while the
  resolution runs (3-4 placeholder rows with shimmer). Status pill
  shows the connection state separately, so the rail being skeletal
  doesn't conflate with "we're disconnected."
- Direct-to-level navigation (Q5 answer) is the right model — but
  only after the live investigation resolves where each label
  actually lives. If `Albums` is nested under `Library`, the rail
  click is a two-hop drill (handled in the strategy section above).

### Acceptance criteria

- Right pane occupies the full viewport width minus a narrow left rail
  (target ~180px, down from 240px).
- Search is visible and usable on every route.
- Clicking an Explore item drills into the right pane without a route
  navigation away from `/library`. (We still go to `/library` if we
  arrived from `/queue`.)
- Status pill / zone selector reachable in sidebar footer; theme
  toggle reachable in sticky header.
- Narrow viewports (<1020px): rail collapses to a hamburger /
  off-canvas panel.
- Stale rail key invalidation (R1 follow-up, must be tested):
  - Simulate a `core-status: paired` reconnect after rail items
    were resolved → rail refetches, resolved item_keys are
    different from the prior cache, click still works.
  - Simulate a click whose cached itemKey returns InvalidItemKey →
    rail auto-refetches and retries the click silently. No
    user-facing toast for this case.
- No bookmark / profile / three-dot icons added unless a follow-up
  PR is wired to back them. The "icons that don't do anything" rule
  is enforced in code review (R1 follow-up).

### Open questions — resolved (R1)

- Q1 (refetch cadence): on `core-status: paired/reconnect` and on
  layout mount. No periodic polling. → folded into Rail population
  strategy.
- Q2 (theme toggle placement): sticky header only. → folded above.
- Q3 (Queue home): option A (route stays, sidebar entry removed,
  reach via play bar). → folded above.
- Q4 (narrow viewport): hamburger / off-canvas, not stacked. →
  folded into Implementation notes.
- Q5 (direct-to-level navigation): yes, but only after live
  investigation resolves where each label actually lives. → folded
  into Implementation notes + Rail population strategy.
- Q6 (cohesion of footer controls): light cohesion pass (radius,
  spacing, label style); no deep redesign. → folded into
  Implementation notes.

## PR2 — Now-playing screen + album page polish

### Now-playing

- Overlay/sheet on top of the current page (Q7 answer); full-screen
  on mobile breakpoints. Closing returns the user to the underlying
  page in its prior state.
- Triggered from: play bar artwork tap, play bar title tap, optional
  keyboard shortcut.
- Layout: large artwork left, metadata right (`three_line.line1/2/3`
  from `now_playing`), seek bar, transport controls. Below: optional
  inline queue list (depends on Q7).
- Lyrics panel: **explicitly not shipping** — no API path. Don't
  pretend.

### Album page polish

When the user is on an album page (level 2+ in the browse hierarchy
where items are tracks):

- Header chips for year / format / hi-res tag if available in
  `subtitle` or `itemType` payloads. Need to inspect a real album
  payload to see what's there.
- Prominent action buttons at the top: `Play album` / `Shuffle album`
  / `Add to queue`. These are the same `action_list` rows we already
  surface via the `pageActions` derivation; the change is visual
  hierarchy (buttons styled bigger / fixed at the top of the pane,
  rather than as small pills next to the title).
- Track row hover state with quick-play and "more options" affordance.
  (We already have ▶ and ⋮ in the row.)

### Files touched

- New: `ui/src/lib/components/NowPlayingOverlay.svelte` — overlay
  component mounted at the layout level. Driven by an
  `nowPlayingOverlayStore` (`open`/`close` toggles).
- `ui/src/routes/+layout.svelte` — wire play-bar art/title click to
  the now-playing target.
- `ui/src/routes/library/+page.svelte` — header chip rendering, action
  button restyle.

### Open questions — resolved (R1)

- Q7 (now-playing as route or overlay): overlay/sheet, not a route.
  Full-screen overlay on mobile.
- Q8 (inline queue inside now-playing): yes eventually, but keep
  `/queue` route until the overlay queue is feature-complete. PR2
  ships now-playing without the inline queue; a follow-up PR adds
  the inline queue and only then removes `/queue`.
- Q9 (metadata aggressiveness): best-effort only. Hide chips when
  the underlying field isn't present in the live payload. Don't
  parse `now_playing.three_line` line strings into fake codec/format
  chips — wait until live evidence shows stable structured fields.

## PR3 — Zone grouping + standby/wake

### Zone grouping

- New UI: a "Group zones" affordance on the zone selector or on a new
  zones-management view. Click → modal-like panel with a checklist of
  available outputs. Save → `group_outputs([...output_ids])`.
- Ungroup: button on the grouped zone → `ungroup_outputs([...])`.
- Backend: add `transport:group` and `transport:ungroup` socket
  events, validate input, call the transport API, return ack.

### Standby / wake

- Per-output power button visible when the output's source_controls
  expose `supports_standby`. Click → `toggle_standby(output, {
  control_key })`.
- "Wake all" button on a grouped zone → iterate
  `convenience_switch(output)` for each output. (Need to confirm with
  reviewer whether `convenience_switch` is per-output or per-zone in
  practice.)

### Files touched

- `src/server/socket/index.ts` + REST equivalents — new events.
- `src/core/roon/TransportService.ts` — wrappers around
  `group_outputs` / `ungroup_outputs` / `standby` / `toggle_standby` /
  `convenience_switch`.
- New UI: `ui/src/lib/components/ZoneGroupingModal.svelte` (or
  similar).
- `ui/src/routes/+layout.svelte` — wire the affordance into the zone
  selector / sidebar footer.

### Open questions — resolved (R1)

- Q10 (rename grouped zones): no rename UI. Display Roon's auto-name.
- Q11 (standby with multiple source_controls): if exactly one
  standby-capable control → direct power button; if multiple →
  small nested menu listing each control by `display_name`; if none
  → render nothing.
- Q12 (zones management UI): popover from the zone selector. No
  dedicated `/zones` route.

## Things I deliberately ruled out

- DSP / MUSE / EQ — no API.
- Device setup / DSD / MQA / volume control mode — no API.
- Audio device enable / disable — no API.
- Zone icon / crossfade / volume leveling — no API.
- Lyrics — no API.
- Queue reorder / remove — no API beyond `play_from_here`.
- Real waveform / soundprint — no API.
- Playlist mutation — no API.
- Bookmarks / profile / three-dot row menus that don't trigger
  anything — out of scope per user direction ("icons only matter if
  they do something"). R1 reinforced this as a hard rule: no
  unwired placeholders ship in PR1; if a follow-up PR wires the
  back end, the icon can land then.

## Q1-Q16 resolutions (R1 round)

All folded into the relevant sections above. Cross-reference table:

| Q | Resolution | Where it lives now |
|---|---|---|
| Q1 | Refetch on `core-status: paired`/reconnect + layout mount; no polling | PR1 → Rail population strategy |
| Q2 | Theme toggle stays in sticky header only | PR1 → "What ships" #2 |
| Q3 | Keep `/queue` route, drop sidebar entry, access via play bar | PR1 → "What ships" #4 |
| Q4 | Hamburger / off-canvas rail on narrow viewports | PR1 → Implementation notes |
| Q5 | Direct-to-level after live investigation resolves the tree | PR1 → Pre-PR1 investigation + Rail strategy |
| Q6 | Light cohesion pass (radius, spacing, label) on footer controls | PR1 → Implementation notes |
| Q7 | Now-playing as overlay/sheet, not route. Full-screen on mobile | PR2 → Now-playing |
| Q8 | Inline queue eventually; `/queue` stays until overlay is feature-complete | PR2 → Now-playing |
| Q9 | Best-effort metadata only; hide unavailable chips | PR2 → Album page polish |
| Q10 | No rename UI for grouped zones | PR3 → Zone grouping |
| Q11 | One control = direct button; multiple = nested menu; none = render nothing | PR3 → Standby/wake |
| Q12 | Popover from zone selector | PR3 → Zone grouping |
| Q13 | Cap content width 1280-1440px; not edge-to-edge | PR1 → Implementation notes |
| Q14 | Skeleton rail items while loading | PR1 → Implementation notes |
| Q15 | Keyboard shortcuts in a separate later PR (`/` for search, space for play/pause guarded against text inputs) | Not in PR1/2/3 |
| Q16 | Ship PR1 alone, PR2 follows quickly, PR3 independent after PR1 | "Validation plan per PR" |

## Validation plan per PR

- Unit/integration: existing 83 UI tests must still pass (verified
  on `b8fe754`). Each PR adds tests for new behavior:
  - PR1: rail-click → drill, search-from-other-route → navigate to
    /library, sticky header doesn't overlap content, **stale rail
    key invalidation on `core-status: paired` reconnect, and
    auto-refetch+retry on InvalidItemKey rail click**.
  - PR2: now-playing trigger from play bar, header chip rendering
    against representative `subtitle` payloads, action buttons fire
    the right `action_list` keys.
  - PR3: socket events emit the right transport methods, group/ungroup
    flow, standby toggle.
- Live verification each PR (user-driven): listed inline above.
- `npm --prefix ui test`, `npm --prefix ui run check`, `npm --prefix
  ui run build`, `npm run lint` clean before each commit.
