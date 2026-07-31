import { describe, expect, test } from "bun:test";
import { proxyStillLiveAfterStop } from "../src/service";

/**
 * #764: `ocx service stop` reported success while the proxy kept running, and native Codex was
 * restored on top of it.
 *
 * The subtlety is which failure mode matters. PR #780 waited only when `schtasks /end` returned
 * an ERROR -- but the reported case is an /end that SUCCEEDS while the wrapper survives and
 * respawns its child a few seconds later. On that path the stop command has nothing to report,
 * so the outcome has to be probed rather than inferred from the command's exit status.
 */

/** Deterministic clock: no wall-clock sleeping, and the deadline is reached by construction. */
function fakeClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (ms: number) => { current += ms; },
  };
}

describe("service stop verification (#764)", () => {
  test("a proxy that respawns inside the restart window is detected", async () => {
    // The reported failure: /end succeeded, the wrapper lived, and the child came back at ~5s.
    // A single probe immediately after the stop command would have seen nothing and passed.
    const clock = fakeClock();
    let probes = 0;
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => {
        probes += 1;
        return probes >= 5 ? { port: 10100 } : null;
      },
      ...clock,
    });
    expect(live).toEqual({ port: 10100 });
    expect(probes).toBeGreaterThan(1);
  });

  test("a genuinely stopped proxy returns null within the bound", async () => {
    // The control. Without it the check could report a survivor every time and block every
    // legitimate stop -- worse than the bug, since it would strand native Codex unrestored.
    const clock = fakeClock();
    let probes = 0;
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => { probes += 1; return null; },
      ...clock,
    });
    expect(live).toBeNull();
    expect(probes).toBeGreaterThan(1);
  });

  test("a probe that throws does not count as proof the proxy is gone", async () => {
    // A failing health probe means "unknown", not "stopped". Treating an exception as absence
    // would restore native Codex on top of a proxy that is merely unreachable for a moment.
    const clock = fakeClock();
    let probes = 0;
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => {
        probes += 1;
        if (probes < 4) throw new Error("connection refused");
        return { port: 10100 };
      },
      ...clock,
    });
    expect(live).toEqual({ port: 10100 });
  });

  test("an immediately live proxy is caught on the first probe", async () => {
    const clock = fakeClock();
    const live = await proxyStillLiveAfterStop({
      findProxy: async () => ({ port: 10100 }),
      ...clock,
    });
    expect(live).toEqual({ port: 10100 });
  });
});
