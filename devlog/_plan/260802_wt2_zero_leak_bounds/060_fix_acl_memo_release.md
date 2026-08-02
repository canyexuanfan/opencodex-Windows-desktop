# 060 — Fix #840: Windows ACL timeout-memo release + sync destination keying

Depends on: 001 root-cause delta. Success-memo cleanup already landed; this closes timeout-memo leakage and aligns the sync writer with the async one. P-phase of this work-phase must first check whether wt4's #869 realpath fix landed on dev (it touches the same functions) — rebase if so.

## File map

- MODIFY `src/lib/windows-secret-acl.ts`
  - Extend/replace `forgetHardenedSecretPath` (:171) with an ephemeral release clearing `hardenedPaths.delete(temp)` AND `timedOutPaths` in both namespaces (`required:<temp>`, `optional:<temp>`). Export a test-only count for both memo sets (PR shape).
  - NEVER clear the stable DESTINATION timeout memo via this helper (destination memoization is intentional anti-restall state).
- MODIFY `src/config.ts`
  - Sync `atomicWriteFile` (:107-109): pass `timeoutMemoKey: path` (the destination) when hardening the temp — a failed temp harden must not mint a new unique timeout key per write (matches async at :187).
  - Invoke the ephemeral release at the proven-absence points: :125, :152 (sync writer), :211, :238 (async writer) — after successful rename, successful unlink, ENOENT, or explicit `existsSync(temp) === false`.
- AUDIT + MODIFY manual ephemeral writers: management-token temps and Windows tray replacements (`rg` for harden calls at P; `tests/windows-tray.test.ts:50` shows the tray path).
- MODIFY `tests/config.test.ts`, `tests/windows-secret-acl.test.ts`: new regressions (below).

Scope OUT: registering the memo sets with the app-owned framework (self-releasing makes it unnecessary), parent-directory timeout keys (invalid — directory ACLs do not prove file ACLs), any change to required-vs-optional timeout behavior on live paths.

## Acceptance + activation scenarios

1. Timed-out unique temp subsequently removed: timeout-memo counts return to baseline. Activation: inject ACL timeout on a temp write, then complete cleanup, assert both memo-set counts at baseline (red on pre-fix tree — `required:<unique-temp>` leaks). NOTE: current `required:true` behavior THROWS on timeout — adapt PR #840's test which assumed `{ok:false}`.
2. Repeated timed-out writes to the SAME destination (sync path): ONE shared destination-keyed timeout memo, not N unique-temp memos. Activation: two timeouts on one destination, count assertion (red on pre-fix tree).
3. Residual temp remains on disk (unlink fails): memos RETAINED (fail-closed). Activation: existing `config.test.ts:1536` stays green + timeout-namespace variant.
4. Destination timeout memo survives ephemeral release (anti-restall intact). Activation: explicit assertion after release call.
5. required/optional namespace isolation preserved. Activation: namespace-mixed fixture.
6. Red-green: #1 and #2 red on the pre-fix tree.

## Regression risks (watch in C)

- Clearing a memo while a residual file exists → redundant icacls work + weakened residual fast path (covered by #3).
- Cleanup must handle rename / unlink / ENOENT / retry / hard-link publication consistently — enumerate the publication paths at P before writing the release calls.
