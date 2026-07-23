# 040 — WP4: ocx doctor memory/runtime section

Depends: WP3 (/api/system/memory exists). Consumes 001 §5.

## MODIFY src/cli/doctor.ts

NEW exported helper (testable, IO-injected):

```ts
export type ServiceMemoryReport = {
  reachable: boolean;
  data?: { pid: number; bunVersion: string; platform: string; rss: number;
           heapUsed: number; jscHeap?: { heapSize: number };
           streamMode: string; eagerRelay?: { useEagerRelay: boolean; reason: string };
           watchdog?: { warnThresholdBytes: number; lastWarnAt: number | null } };
  error?: string;
};

export async function fetchServiceMemory(
  port: number, token: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceMemoryReport>;
```

runDoctor() (doctor.ts:322) gains a "Memory / runtime" section:

- Doctor-process identity line: `doctor Bun: <Bun.version> (this is NOT the
  service process)` — F8/A5: never present doctor's own runtime as the
  service's.
- Service identity via fetchServiceMemory (reuses the same port/token
  resolution the CLI already performs — cli/index.ts:133 loads the service
  token): prints service pid, Bun version, platform, RSS (MB), heapUsed (MB),
  jscHeap size, streamMode + eagerRelay decision/reason, watchdog threshold +
  last warn.
- Interpretation lines (from 001 §6 discriminator table):
  * rss high + heapUsed flat → "native-side growth (Bun runtime buffers/handles)
    — see docs: windows-memory troubleshooting"
  * rss high + heapUsed high → "JS-side growth — report an opencodex bug"
- OPENCODEX_BUN_PATH guidance: if service bunVersion === bundled 1.3.14 AND
  platform === win32 → print the override instructions + honest label ("leak
  is upstream; override runs an unvalidated runtime at your own risk").
- Unreachable service → "proxy not reachable (not running, or auth failed)" —
  no fake data.

## Activation scenarios

- Injected fetchImpl returning fixture JSON → section renders all fields.
- fetchImpl rejecting → unreachable line, exit code unchanged (doctor stays
  observe-only, never fails the command on memory section errors).
- win32+1.3.14 fixture → override guidance printed; darwin fixture → not printed.

## TESTS

- EXTEND tests/doctor.test.ts: fetchServiceMemory happy/unreachable/malformed
  JSON; guidance gating (win32+bundled vs not); doctor-vs-service identity
  labels present.

## Verification (C)

- bun x tsc --noEmit; bun test tests/doctor.test.ts; bun run test;
  bun run privacy:scan (no tokens/account ids printed — RSS numbers only).
