import { expect, test } from "bun:test";
import type { OcxConfig } from "../src/types";
import {
  blockCodexSyncsForShutdown,
  syncModelsToCodex,
  unblockCodexSyncsAfterRefusal,
  waitForActiveCodexSyncs,
  type CodexSyncDeps,
} from "../src/codex/sync";

test("shutdown gate waits for an entered sync and refuses every later config write", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let injectCalls = 0;
  const deps = {
    refreshCodexModelCatalog: async () => { throw new Error("external-provider path must not refresh"); },
    injectCodexConfig: async () => {
      injectCalls += 1;
      await held;
      return { success: true, message: "injected" };
    },
    currentExternalCodexModelProvider: () => "user-provider",
  } as unknown as CodexSyncDeps;

  try {
    const entered = syncModelsToCodex(37692, {} as OcxConfig, null, deps);
    await Bun.sleep(0);
    blockCodexSyncsForShutdown();

    expect(await waitForActiveCodexSyncs(10)).toBeFalse();
    release();
    expect(await waitForActiveCodexSyncs(500)).toBeTrue();
    expect((await entered).ok).toBeTrue();

    const refused = await syncModelsToCodex(37692, {} as OcxConfig, null, deps);
    expect(refused.ok).toBeFalse();
    expect(refused.message).toContain("safe shutdown");
    expect(injectCalls).toBe(1);
  } finally {
    release();
    unblockCodexSyncsAfterRefusal();
  }
});
