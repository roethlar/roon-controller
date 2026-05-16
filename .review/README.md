# Review workflow

Two-agent loop: **Coder** is the implementer, **Reviewer** is the gate.
`REVIEW.md` at the repo root is the human-readable status index;
this directory is the structured handoff channel.

See `SETUP.md` at the repo root for the generic workflow rationale.

## Layout

```
.review/
├── README.md                     This file — the project-specific contract
├── findings/<id>.md              Implementation record per finding
├── ready/<id>.json               Coder → reviewer signal (sentinel)
└── results/
    ├── <id>.verified.json        Reviewer → coder: accepted
    └── <id>.reopened.md          Reviewer → coder: needs fix-ups

REVIEW.md                         (root) Human-readable status index
```

## Branch contract

- **One branch per finding**, named `fix/<id-lowercased>-<short-slug>`
  (e.g. `fix/c-1-shutdown-race`).
- **Each branch is the smallest coherent slice** that addresses one
  finding id. No bundling.
- Touch only files declared in `.review/findings/<id>.md` under
  **Files changed**. If overlap is unavoidable, declare it in
  **Known gaps**.
- Use `git worktree add ../roon-controller-<id> fix/<id-…>` for
  parallel work without checkout thrash.

## Finding IDs

Assigned by the reviewer when a finding is added to `REVIEW.md`.
Format: `<SEV>-<n>` where `SEV` is `C` (Critical), `H` (High),
`M` (Medium), `L` (Low) and `n` is a monotonic counter within that
severity. Examples: `C-1`, `H-3`, `M-12`.

## Validation suite

Run from repo root. All must pass before commit.

```bash
# Backend
npm test -- --runInBand               # Jest, in-band so persistence tests serialize
npm run build                         # tsc
npm run lint                          # eslint

# Frontend (SvelteKit)
npm --prefix ui run check             # svelte-check (0 errors, 0 warnings)
npm --prefix ui test -- --run         # Vitest (no watch mode)
npm --prefix ui run build             # vite build (adapter-static)
```

Touching shared types (`src/shared/`) requires the backend build to
re-emit and the UI build to re-typecheck. Run both.

## Coder loop

1. Pick the highest-priority `[ ]` (Open) item in `REVIEW.md`.
2. Create branch + worktree. Implement the fix and write tests.
3. Run the **Validation suite**. Do not commit on failure.
4. Commit with subject `Fix <id>: <one-line summary>` and a body
   mirroring `.review/findings/<id>.md`.
5. Write `.review/findings/<id>.md` with: **What / Approach / Files
   changed / Tests added / Known gaps**.
6. Update `REVIEW.md` row: `[ ]` → `[~]`, link the branch.
7. Atomic sentinel write — use `mktemp` then `mv`:
   ```bash
   tmp=$(mktemp .review/ready/.<id>.json.XXXX)
   cat > "$tmp" <<EOF
   {"id":"<id>","branch":"fix/<id-…>","sha":"$(git rev-parse HEAD)","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
   EOF
   mv "$tmp" .review/ready/<id>.json
   ```
8. Move to the next finding. Do not wait for reviewer verdict to
   start the next branch — but do not stack work on a branch that
   already has a `.review/ready/<id>.json` pending.

### Test verification step

For any non-trivial behavior change, after writing the test:

1. Confirm it passes against the fixed code.
2. Temporarily revert the fix (comment-out the load-bearing line);
   re-run the affected test file; confirm it FAILS as expected.
3. Restore the fix; confirm all tests pass again.

This is part of the implementation, not optional. The coder's
finding doc notes which line was reverted for verification.

## Reviewer loop

Wakes on each new sentinel in `.review/ready/`.

1. Read `.review/ready/<id>.json`, parse `branch` + `sha`.
2. `git fetch && git checkout <branch>` (or use a separate worktree).
   Run validation.
3. Dispatch a specialist subagent on the diff `main..<branch>` with
   the finding scope.
4. Write the verdict:
   - **Accepted** → `.review/results/<id>.verified.json` with
     `{ id, sha, ts, reviewer }`. Fast-forward merge into `main`.
     Update `REVIEW.md` row to `[x]`. Delete `.review/ready/<id>.json`.
   - **Reopened** → `.review/results/<id>.reopened.md` with concrete
     `file:line` comments. Update `REVIEW.md` row to `[ ]`. Delete
     `.review/ready/<id>.json`. The branch stays; coder pushes fix-ups
     and writes a fresh sentinel after addressing comments.

## Finding identification (separate from verdict loop)

When the reviewer audits the codebase (independent of any sentinel)
and finds new issues:

1. Append rows to the `## Findings` table in `REVIEW.md`, with
   newly-assigned IDs.
2. Optionally seed `.review/findings/<id>.md` with **What** + cited
   file:lines — coder fills in **Approach / Files changed / Tests
   added** when picking it up.
3. No sentinel involved at this stage. The coder picks up the new
   row on their next cycle.

## WIP limit

- **Strict mode (default)**: at most one branch may have a pending
  sentinel at a time.
- **Faster mode**: multiple sentinels permitted iff each branch's
  `Files changed` is fully disjoint from every other pending branch.

## No broad sweeps

Multi-finding branches are forbidden unless the human explicitly asks
for a sweep (e.g. emergency rollback or coordinated workflow change).

## Repo-specific notes

- `main` is the default branch (no `master`).
- Backend tests must run with `--runInBand` because
  `RecentlyPlayedService` tests share an in-memory `fs.writeFile` spy
  pattern and would otherwise race.
- The UI test harness aliases `$app/navigation`, `$app/stores`, and
  `$app/environment` via `ui/src/test/app-stubs/` — when touching
  layout/page tests, vi.mock those at module top to inject
  controllable spies.
- `src/shared/` is consumed by both backend (`tsconfig`) and UI
  (`@shared/*` alias in `ui/svelte.config.js`). Type changes there
  must compile cleanly under both.
