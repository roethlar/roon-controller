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
| _(none yet — reviewer populates as findings are identified)_ |

## Conventions

- Severity: `CRITICAL` / `HIGH` / `MEDIUM` / `LOW`.
- ID format: `<C\|H\|M\|L>-<n>` (e.g. `C-1`, `H-3`, `M-12`).
- Branch links: when present, the reviewer or coder fills the cell
  with `` `fix/<id>-<slug>` ``.
- One row per finding. Rows are append-only; reopening flips status
  back to `[ ]` rather than deleting the row.
