import { existsSync, writeFileSync } from "node:fs";

import { NativeProfileManager } from "../../src/codex/native-profile-manager";

const codexHome = process.env.NATIVE_PROFILE_TEST_CODEX_HOME;
const configDir = process.env.NATIVE_PROFILE_TEST_CONFIG_DIR;
const readyPath = process.env.NATIVE_PROFILE_TEST_READY;
const releasePath = process.env.NATIVE_PROFILE_TEST_RELEASE;

if (!codexHome || !configDir || !readyPath || !releasePath) {
  throw new Error("native-profile lock child is missing required test paths");
}

const manager = new NativeProfileManager({
  codexHome,
  configDir,
  hardenPath: async () => {},
  lockWaitMs: 5_000,
  onLockAcquired: async () => {
    writeFileSync(readyPath, "ready");
    if (process.env.NATIVE_PROFILE_TEST_CRASH === "1") process.exit(0);
    while (!existsSync(releasePath)) await Bun.sleep(10);
  },
});

await manager.recover(false);
