# Handoff for Claude — 2026-05-04

> **Status (post-handoff):** Historical. This document captures the state at handoff time. Track-list detection (C-5) listed under "Known Open Issues" was implemented after handoff — see `DEVLOG.md` (2026-05-04 — Track-list classification by itemType (C-5)) and `docs/PLAN.md`. Treat the "Known Open Issues" section below as a snapshot, not a current work list.

## Operating Mode

Codex is switching back to review-only after creating this handoff. Claude can resume implementation work. Do not assume the current working tree is clean.

## Current Git State

Last committed baseline:

```text
955b984 Stabilize Roon controller UI and installers
```

Uncommitted files at handoff time:

```text
M DEVLOG.md
M README.md
M TODO.md
M docs/PLAN.md
M scripts/install.sh
M ui/src/routes/library/+page.svelte
M ui/src/routes/library/__tests__/page.test.ts
```

Diff size at handoff time: 7 files, about 468 insertions / 61 deletions before this handoff file was added.

Do not overwrite these changes. Review them before adding anything.

## What Changed Since Commit 955b984

### 1. Search click stale itemKey fix

Live issue: after redeploy, search result clicks returned browse errors.

Journal signature:

```text
browse search input "tori amos" pop_all true
load search -> result keys like 3:0 / 3:1
browse search item_key old key
InvalidItemKey
```

Root cause: the UI re-seeded Roon search with `popAll: true`, then browsed the stale `itemKey` from the pre-reset rendered search row. Roon mints new search keys on every re-seed.

Implemented in `ui/src/routes/library/+page.svelte`:

- `resetSearchSession()` now returns the fresh `BrowseResult`.
- `freshenSearchItem()` re-seeds search and matches the clicked row against fresh results by title/subtitle/hint/image/type metadata.
- `navigateSearchResult()` browses the fresh key, not the stale rendered key.
- Search-result quickPlay uses the same fresh-key remap before action lookup.
- Search-result quickPlay is restricted to `resultType === 'track' && hint === 'action_list'`; non-track search action lists navigate.

Tests added in `ui/src/routes/library/__tests__/page.test.ts`:

- Search album click re-seeds and browses fresh `itemKey`.
- Search track quickPlay re-seeds before action lookup.
- Non-track `action_list` search result navigates instead of quick-playing.

### 2. Search restore stale itemKey guard

Live issue: navigation/remount produced a `Restore stopped...` browse error.

Journal signature:

```text
search restore re-seeded query "tori"
load returned fresh keys like 32:2
restore replayed old persisted key 29:2
InvalidItemKey
```

Root cause: persisted search history only stores `itemKey`; after search re-seed those keys are invalid. There is not enough stable per-step metadata to remap arbitrary deep search drill paths safely.

Implemented in `ui/src/routes/library/+page.svelte`:

- Search-rooted restore now re-seeds the saved query and lands at the fresh search root.
- It clears stale search drill history with `resetHistory()`.
- It does not replay search drill steps after re-seed.
- Browse-rooted restore still replays saved browse steps.

Tradeoff: route remount after deep search no longer returns to the exact deep search page. It restores to the search root for the saved query to avoid false browse errors.

Tests updated:

- Search-rooted history test now asserts re-seed once, stale saved key not used, fresh search root renders, history clears.
- Search-context quickPlay test no longer depends on unsafe search-history replay.

### 3. Action-list quickPlay guard

Live issue: from search/composers, the user clicked:

```text
Composers -> Tori Amos -> 29 Years
```

Roon returned a work page with two buttons:

```text
Play Work
On Ocean to Ocean by Tori Amos
```

Clicking `On Ocean to Ocean by Tori Amos` started playback, as if `Play Work` was clicked. Repeated clicks appeared to cycle through versions/play actions.

Live payload evidence:

```text
items: [
  { title: "Play Work", item_key: "48:0", hint: "action_list" },
  { title: "On Ocean to Ocean by Tori Amos", item_key: "48:1", hint: "action_list" }
]
```

Browsing `48:1` produced an action menu, not an album page:

```text
On Ocean to Ocean by Tori Amos
items: Play Now, Add Next, Queue, Start Radio
```

Root cause: `handleItemClick()` quick-played every `hint === 'action_list'` item. QuickPlay browses into the item, picks first playable/action row, and executes it. That is valid for explicit play rows, but wrong for contextual action-list rows.

Implemented in `ui/src/routes/library/+page.svelte`:

- Added `shouldQuickPlayActionList()`.
- QuickPlay only for explicit `Play ...` labels or numbered track rows.
- Other `action_list` rows use normal `navigate()`.

Important limitation: this does not make `On Ocean to Ocean by Tori Amos` jump directly to the album page. The live Roon browse payload exposes it as a playback action menu, not a direct album browse result. A true album jump needs a separate resolver/fallback strategy.

Test added:

- Exact `On Ocean to Ocean by Tori Amos` label; zone intentionally unselected. The test asserts click emits `browse:browse`. If it regresses to quickPlay, it would bail with "Select a zone" and emit nothing.

### 4. Linux installer final URL fallback

Live reinstall completed but printed:

```text
./scripts/install.sh: line 287: hostname: command not found
URL        : http://:5173
```

Implemented in `scripts/install.sh`:

- Added `detect_url_host()`.
- URL host detection now tries:
  1. `ip -4 route get 1.1.1.1`, extracting `src`.
  2. `hostname -I` if `hostname` exists.
  3. `localhost` fallback.

Also verified `/opt/roon-controller/.env` contains `PORT=5173`, so the port printed by the installer was matching preserved live config. If the intended port is `3333`, reinstall with `--port 3333`.

## Documentation Updated

Updated:

- `DEVLOG.md`
- `TODO.md`
- `docs/PLAN.md`
- `README.md`

New handoff file:

- `docs/HANDOFF_2026-05-04_CLAUDE.md`

## Validation Already Run

Latest validations after the action-list guard:

```bash
npm --prefix ui test -- page.test.ts     # 25 Library page tests passed
npm --prefix ui run check                # 0 errors / 0 warnings
npm --prefix ui test                     # 69 UI tests passed
npm --prefix ui run build                # passed
git diff --check                         # clean
bash -n scripts/install.sh               # clean
```

Earlier during this uncommitted batch, backend build/lint also passed for the search stale-key work:

```bash
npm run build
npm run lint
```

No backend source files were changed after those backend validations.

## Deployment State

The latest uncommitted fixes are not deployed unless the user redeployed after this handoff was written.

Install command when the user explicitly wants deployment:

```bash
sudo ./scripts/install.sh --reinstall
```

If the user wants port 3333 instead of preserved live port 5173:

```bash
sudo ./scripts/install.sh --reinstall --port 3333
```

Do not run installers unless the user explicitly asks.

## Manual Verification Checklist

After redeploy, verify live against Roon Core:

1. Search `tori`; click Artists / Albums / Tracks search results. No browse error.
2. Click into a search result, then Library -> Queue -> Library. It should restore to the search root for the query, not show `Restore stopped...`.
3. Search `tori` -> Composers -> Tori Amos -> `29 Years`.
4. Click `Play Work`; it may play a work/version. Confirm expected.
5. Click `On Ocean to Ocean by Tori Amos`; it should not immediately start playback. Current expected behavior after this fix is normal browse into Roon's action menu for that row, because Roon exposes it as `Play Now / Add Next / Queue / Start Radio`, not as an album browse page.
6. Verify queue positional updates: skip a track, Play Next from another Roon client, confirm queue rows update correctly.
7. Verify installer final URL no longer prints an empty host on this VM.

## Known Open Issues / Follow-Up Candidates

- True album jump from contextual rows like `On Ocean to Ocean by Tori Amos` is not implemented. Need a resolver, likely matching title/artist against current search/browse album lists or using richer Roon metadata if available.
- Track-list detection still uses title regexes (`/^\d/`) in `+page.svelte`; earlier reviews flagged this as fragile. Defer until live rendering evidence or implement with better `hint` / `itemType` / row metadata.
- Search restore deliberately drops deep search drill history after remount. A future robust version would persist stable breadcrumb metadata per search step and remap every level after re-seed.
- The app is still relying on title heuristics for quickPlay (`/^Play\b/i`, numbered track rows). Better long-term fix is semantic action classification from Roon payloads if available.

## Review Notes For Claude

Before implementing anything else:

1. Read `DEVLOG.md` latest sections.
2. Review current diff in `ui/src/routes/library/+page.svelte` and `ui/src/routes/library/__tests__/page.test.ts`.
3. Confirm whether the user wants these changes committed or deployed.
4. If adding code, keep docs current and preserve the existing dirty worktree.
