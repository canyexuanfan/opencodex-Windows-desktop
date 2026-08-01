# Native main profile design-spike validation

Date: 2026-08-01

Branch: `experiment/656-native-profile-design`

## Validated artifact

The executable part of this spike is intentionally limited to the pure crash-recovery decision model in:

- `src/codex/native-profile-recovery.ts`
- `tests/native-profile-recovery.test.ts`

The model has no filesystem, credential, network, encryption, process-control, or runtime-state side effects.

## Runtime matrix

| Runtime | Exact revision | Focused tests | Typecheck |
| --- | --- | --- | --- |
| OpenCodex packaged Bun | `1.3.14+0d9b296af` | 18 passed, 0 failed | Passed |
| User-selected Bun 1.4 canary | `1.4.0-canary.1+5f65d3785` | 18 passed, 0 failed | Passed |

The canary executable reports the display version `1.4.0`; `bun --revision` confirms the exact canary build above.

## Commands

```powershell
& $packagedBun test tests/native-profile-recovery.test.ts
& bun test tests/native-profile-recovery.test.ts

& $packagedBun install --frozen-lockfile
& $packagedBun run typecheck
& bun run typecheck
```

The frozen install resolved 101 packages and did not require a lockfile update.

## Covered recovery decisions

Each journal phase was checked against exact and changed source/target observations:

- `prepared`
- `auth-replaced`
- `vault-committed`

The tests prove these pure decisions:

- A confirmed source identity converges to source ownership.
- A confirmed target identity before vault commit completes target ownership.
- A confirmed target identity after vault commit finalizes runtime reconciliation.
- An unreadable or otherwise unconfirmed auth state requires manual recovery and publishes no runtime transition.
- A third identity requires manual recovery and publishes no runtime transition.
- A changed digest with the expected identity follows the identity-safe recovery branch rather than overwriting an external refresh blindly.

## Explicitly not validated yet

This spike does not claim that production native-profile switching is ready. The following work remains behind the design gates in `000_design.md`:

- Cross-platform OS-protected key provider selection and security review.
- Full-fidelity encrypted envelope implementation.
- Effective Codex credential-store mode resolution.
- Staged official Codex login.
- Home-scoped interprocess locking.
- Atomic auth replacement and exact-byte restoration.
- Encrypted crash-journal persistence and idempotent I/O recovery.
- Native Codex process quiescence and restart behavior.
- OpenCodex `__main__` request drain and confirmed runtime-state transition.
- Failure injection for ACL, rename, read-back, vault commit, and restoration failures.
- Verification that task/history and unrelated credential stores remain byte-identical.

No production code in this spike reads or writes a user's `auth.json`, vault, task, history, Pool, OAuth, provider, or API-key data.

## PR readiness

The design and pure state model are suitable for maintainer discussion. A behavior-changing upstream PR is not suitable until maintainers choose the OS key-provider approach and confirm the file-only v1 boundary.

