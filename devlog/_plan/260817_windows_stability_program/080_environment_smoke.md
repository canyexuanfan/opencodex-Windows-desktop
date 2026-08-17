# 080 — Windows-specific smoke coverage that does not exist at all (F3)

**Depends on:** 060 stage 3. Add these once the basic gate is trustworthy.

## Change

The unit suite tests logic. These test the environment, and no amount of unit
coverage substitutes for them. Each is a small job, added one at a time:

1. **Non-ASCII username.** A profile path like `C:\Users\김병준` exercises
   encoding through every path join, config write, and PowerShell invocation.
   This machine's own user is ASCII, so nothing currently covers it.
2. **Long paths.** A working directory deep enough to cross MAX_PATH (260),
   with and without `LongPathsEnabled`.
3. **Non-admin user.** File symlink creation throws EPERM unelevated. The suite
   already skips those cases via a `canSymlink` probe; CI should prove the
   *product* degrades correctly, not just that tests skip.
4. **OneDrive-redirected profile.** Known Folder redirection puts Documents and
   Desktop under a synced path with a filter driver holding handles. This is the
   most common real-world source of the sharing violations 030 and 031 address.
5. **Korean locale / code page 949.** Console encoding for a non-UTF-8 default
   code page, which is this maintainer's own environment.
6. **Service across a reboot.** Install, reboot the runner, assert the proxy is
   healthy. The single highest-value job on this list and the hardest to
   arrange on hosted runners.
7. **Self-update end to end.** Install the previous published version, update to
   the candidate, assert the CLI and service both survive.

## Verify

Each job passes on a branch before it is added to the required set. Add them
individually — a batch of seven new Windows jobs landing together makes the
first failure impossible to attribute.

## Risk

Medium and mostly about time. Several of these are slow, and 6 may not be
achievable on hosted runners at all; if not, record that limitation here rather
than quietly dropping it.
