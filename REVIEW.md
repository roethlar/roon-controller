# Review status

See `.review/README.md` for the workflow contract.
See `.review/findings/<id>.md` for per-finding details.
See `SETUP.md` for the generic two-agent workflow rationale.

## Legend
- `[ ]` Open — coder hasn't started
- `[~]` In progress — branch exists, sentinel pending review
- `[x]` Verified — accepted and merged into `main`

## Findings

| ID    | Severity | Title                                  | Status | Branch |
|-------|----------|----------------------------------------|--------|--------|
| M-1 | MEDIUM | Rail navigation loses current state on REST failure | [ ] | `fix/m-1-rail-rest-failure` |
| M-2 | MEDIUM | Play-bar navigation commits history before final browse succeeds | [~] | `fix/m-2-playbar-history-commit` |
| M-3 | MEDIUM | Recently Played inserts are broadcast before durable persistence | [ ] | |
| M-4 | MEDIUM | Queue subscriptions accept unbounded item counts | [ ] | |
| L-1 | LOW | Missing Recently Played readiness/health diagnostics | [ ] | |

## Conventions

- Severity: `CRITICAL` / `HIGH` / `MEDIUM` / `LOW`.
- ID format: `<C\|H\|M\|L>-<n>` (e.g. `C-1`, `H-3`, `M-12`).
- Branch links: when present, the reviewer or coder fills the cell
  with `` `fix/<id>-<slug>` ``.
- One row per finding. Rows are append-only; reopening flips status
  back to `[ ]` rather than deleting the row.
