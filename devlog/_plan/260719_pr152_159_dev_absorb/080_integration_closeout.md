# 080 — Integration closeout: full gates over the absorbed stack

## 1. Scope

After phases 010–070 have landed on `dev`, run the unit-wide gates and own any
cross-PR breakage repair. No new features; only integration repairs discovered
by the gates below. No push. This phase exists so no per-PR phase carries an
unrelated global gate (A-gate amendment 2026-07-19).

## 2. Gates

```bash
bun run typecheck          # root tsc (src/)
bun run test               # canonical isolated full suite (bun test --isolate ./tests/)
bun run privacy:scan       # secret/privacy scan (PR #153 fixtures in scope)
cd gui && bun run build    # GUI compilation owner
```

All four must exit 0 **in one contiguous all-green run on the same final HEAD**:
after ANY repair commit, all four gates re-run from the top — a pass assembled
from gate results at different commits does not count. Repairs are
maintainer-authored (Co-authored-by only if the repair reworks contributor
hunks).

## 3. Close-out contract

- Record fresh command outputs (exit codes, counts) in this doc at D.
- Update goalplan criteria cr1–cr7 `capturedEvidence` with per-PR commit SHAs +
  gate evidence; mark met.
- D summary states the terminal outcome per PR (DONE/NOOP) and archives the
  unit per repo convention (move to `devlog/_fin/` only when the whole unit is
  closed and the user approves the housekeeping).
