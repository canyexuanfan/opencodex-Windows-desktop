# 010 — wp2: transport honesty (#2697, #2698, #2696)

Closes: #2697, #2698, #2696. Branch: `codex/ocx-transport-honesty` off
`codex/ocx-agentic-control-roadmap`.

Every later phase is verified through CLI output. A phase that lands while `ocx`
exits 0 on failure and hides the server's `reason` cannot be proven, so this is
first.

## Scope

IN: `src/cli/dispatch.ts`, `src/cli/runtime-api.ts`, `src/cli/account-api.ts`,
`src/service.ts`, `src/server/management-auth.ts` (read-side only), tests.
OUT: new verbs, help generation, DTO rendering, usage attribution.

---

## 010.1 — `dispatch.ts`: stop discarding exit codes

MODIFY `src/cli/dispatch.ts` around line 419 and 428.

Before:

```ts
  provider: async deps => {
    const { handleProviderCommand } = await import("./provider.ts");
    await handleProviderCommand(deps.args.slice(1), deps);
    return 0;
  },
```

After:

```ts
  provider: async deps => {
    const { handleProviderCommand } = await import("./provider.ts");
    await handleProviderCommand(deps.args.slice(1), deps);
    // handleProviderCommand reports failure through process.exitCode
    // (provider.ts sets it from handleProviderRuntimeCommand). Returning a
    // literal 0 here made index.ts call process.exit(0) and erase it (#2697).
    return Number(process.exitCode ?? 0);
  },
```

Identical change for the `models` runner. Do not change `handleModels` /
`handleProviderCommand` signatures — that is a wider refactor with no extra benefit
while `process.exitCode` is already the contract eight other runners use.

**Guard against recurrence.** A second one-line fix invites a third. Add to
`tests/cli-dispatch.test.ts` a source scan in the same spirit as
`core-lab-boundary`, rejecting a runner that awaits a handler and then returns a
literal 0.

**The pattern must tolerate nested parentheses.** The obvious
`/await\s+handle\w+\([^)]*\);\s*\n\s*return 0;/` does **not** work: `[^)]*`
cannot span `deps.args.slice(1)` because of the inner `)`. Run against the real
pre-fix `dispatch.ts` it matches exactly one site — `handleLogin` at :195 — and
misses both :419 and :428, the two this phase fixes. A guard that greens against a
pattern which never covered the regression is worse than no guard.

Use a `;`-terminated form instead, and **drive it red first**:

```ts
const SWALLOW_RE = /await\s+handle\w+\([^;]*\);\s*\n\s*return 0;/g;
```

The test asserts two things, and the first is what keeps it honest:

1. Against a fixture holding the pre-fix bodies of the `provider` and `models`
   runners, `SWALLOW_RE` **matches** — proof the pattern sees the defect.
2. Against current `dispatch.ts` source, every match's command name is in an
   explicit allowlist of runners that genuinely cannot fail. Adding a name is then a
   deliberate, reviewable act rather than a silent widening.

The permissive `[\s\S]*?` variant matches 6 sites and is too loose; `[^;]*` is the
narrowest form that spans an argument list without crossing a statement boundary.

---

## 010.2 — `runtime-api.ts`: render `reason` and `hint`

MODIFY `src/cli/runtime-api.ts` `responseMessage` (line 50).

**Parameter order is `(body, status)`, not `(status, body)`** — the call site at :86
is `responseMessage(body, response.status)`. Keep it; an earlier draft of this doc
inverted it, which typechecks only if the call site is flipped too and otherwise
binds `status` to the body object.

Before (verbatim):

```ts
function responseMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
      if (typeof record[key] === "string" && record[key]) return record[key];
    }
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 400);
  return \`Management request failed (${status})\`;
}
```

After:

```ts
const PRIMARY_MESSAGE_KEYS = ["error", "message", "detail"] as const;

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function responseMessage(body: unknown, status: number): string {
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 400);
  if (!body || typeof body !== "object") {
    return \`Management request failed (${status})\`;
  }
  const obj = body as Record<string, unknown>;
  let primary: string | undefined;
  for (const key of PRIMARY_MESSAGE_KEYS) {
    primary = stringField(obj, key);
    if (primary) break;
  }
  // The server states WHY under 'reason' and WHAT TO DO under 'hint'
  // (management-auth.ts:455). Both were dropped, so a fenced management plane
  // read as a generic failure (#2698).
  const reason = stringField(obj, "reason");
  const hint = stringField(obj, "hint");
  const parts: string[] = [];
  parts.push(primary ?? \`Management request failed (${status})\`);
  if (reason && reason !== primary) parts.push(\`reason: ${reason}\`);
  if (hint) parts.push(\`hint: ${hint}\`);
  return parts.join("\n").slice(0, 1200);
}
```

The 400-char cap stays for opaque string bodies; the structured path gets a wider
1200 cap because it now carries up to three labeled lines.

## 010.3 — `account-api.ts`: same treatment, and stop erasing network errors

MODIFY `src/cli/account-api.ts`.

`apiJson` (line ~88) currently collapses any thrown fetch into `{status: 0}` inside
a catch block with an empty body, discarding the message. Change the sentinel to carry it:

```ts
export type ApiResult = { status: number; json: unknown; transportError?: string };

// ...
  } catch (err) {
    // status 0 is the transport sentinel; the message was previously discarded,
    // which is why an unreachable proxy and a 500 were indistinguishable (#2698).
    return { status: 0, json: null, transportError: err instanceof Error ? err.message : String(err) };
  }
```

`apiError` (line ~123) reads only `json.error`. Extend it to the same
primary/reason/hint composition, and to print `transportError` when `status === 0`.
Keep the `cleanupRequired` special case.

Exit-code mapping: `apiError` currently always yields 1. Map 404 to 4 and 409 to 5
to match client 1's vocabulary (runtime-api.ts:311), so the two clients stop
disagreeing. That is a behavior change for scripts that only checked `!== 0`;
those keep working. Record it in the PR description.

## 010.4 — `service.ts`: refuse the admin/data-plane token collision

MODIFY `src/service.ts`.

`writeServiceApiTokenFile` (line ~383) is the chokepoint. Add before the write:

```ts
  // A management (admin) token must never become the data-plane secret: the
  // server fences the ENTIRE management plane closed when the two match
  // (management-auth.ts:200 -> isDataPlaneAdmissionSecret), so every /api/*
  // returns 503 and the CLI cannot even ask why (#2696).
  assertNotAdminToken(token);
```

NEW helper in the same file:

```ts
const ADMIN_TOKEN_PREFIX = "ocx_admin_";

export function assertNotAdminToken(token: string): void {
  if (!token.startsWith(ADMIN_TOKEN_PREFIX)) return;
  throw new Error(
    "OPENCODEX_API_AUTH_TOKEN holds a management (admin) token. " +
      "The service exports it as the data-plane secret, which fences the whole " +
      "management API closed. Unset OPENCODEX_API_AUTH_TOKEN, or set it to a " +
      "distinct data-plane key, then re-run the install.",
  );
}
```

Call it from `assertServiceAuthEnvironment` (line ~369) too, so `install` and
`repair` fail loudly instead of producing a broken service.

Deliberately NOT in this phase: the startup repair that deletes a colliding
`service-api-token` on a loopback bind. It changes credential state on disk at boot
and needs the `MAINTAINERS.md` security review plus a loopback-only proof. The
write-time refusal fixes new installs and is safe on its own; existing broken
installs get a diagnosable 503 (via 010.2) plus the actionable message. Repair is
recorded in `081` as a follow-up decision, not silently dropped.

## 010.5 — `ocx doctor`: surface the collision

MODIFY `src/cli/doctor.ts`: add a check that reads the service token file and the
admin token and reports a hard failure when they match, naming the fix. This is the
one place an operator with an already-broken install will look.

`doctor` currently always exits 0 (002). Leave that alone in this phase — changing
it is a contract change for anything that runs `ocx doctor` in a pipeline; wp3 owns
it as part of the exit-code contract work.

## Tests

| File | Assertion |
|---|---|
| `tests/cli-dispatch.test.ts` | `provider`/`models` runners propagate a handler-set `process.exitCode`; source scan rejects new `return 0` swallowing |
| `tests/cli-management-auth.test.ts` | a 503 body `{error, reason, hint}` renders all three; a `{reason}`-only body does not degrade to the generic message |
| `tests/cli-account.test.ts` | `apiJson` transport failure carries `transportError`; 404 -> 4, 409 -> 5 |
| `tests/service.test.ts` | `writeServiceApiTokenFile` and `assertServiceAuthEnvironment` throw on an `ocx_admin_` value |
| `tests/doctor.test.ts` | the collision check reports and names the remedy |

## Accept criteria

1. `ocx models live` and `ocx provider quota` against a stopped proxy exit non-zero.
2. A 503 with `reason`+`hint` prints all three parts.
3. `ocx service install` with an admin token in `OPENCODEX_API_AUTH_TOKEN` fails
   with the actionable message instead of producing a fenced install.
4. `ocx doctor` names an existing collision.
5. No new `return 0` swallowing can be added without editing the allowlist.
