# 081 — follow-up decisions deliberately deferred

Not omissions. Each is recorded so a later reader sees a decision instead of a gap.

## 081.1 — loopback repair for the token collision (#2696)

`010` ships the write-time refusal only. The startup repair — delete a colliding
`service-api-token` when the bind is loopback — changes credential state on disk at
boot and needs the security review `MAINTAINERS.md` requires plus a proof that it
cannot run for a non-loopback bind.

Consequence of deferring: an install already broken by the collision stays broken
until the operator re-installs. It is now *diagnosable* (`010.2` prints the reason,
`010.5` names it in `doctor`), which was the actual complaint in the issue. Ship the
repair as its own reviewed PR.

## 081.2 — per-account quota for non-Anthropic providers

`supportsPerAccountQuota` (`src/providers/quota.ts:1454`) is `provider === "anthropic"`.
`050` deliberately scopes to log *attribution*, not quota fetching. Extending quota
means per-provider quota endpoints and rate-limit budget, which is a different unit.

## 081.3 — remote transport for `ocx lab` and `ocx config`

Both reach their data locally (SQLite, file I/O) rather than over `/api/*`. `060`
records these as `local-transport` exemptions and adds no `--remote` path: a second
transport for the same data doubles the agent-facing surface, and an agent operating
a proxy on another host is not a supported topology today. Revisit if that changes.

## 081.4 — the GUI's 78 inlined endpoint call sites

`003` found no central GUI API client; endpoints are inlined across ~78 files. That
makes the GUI unable to participate in the parity gate — wp3's registry is declared
server-side instead. A GUI-side endpoint manifest would let the test verify all three
surfaces agree, but touching 78 files is its own unit and outside this scope.

