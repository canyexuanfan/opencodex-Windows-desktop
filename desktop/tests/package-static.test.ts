import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const packageJson = JSON.parse(readFileSync(path.resolve(import.meta.dir, "..", "package.json"), "utf8")) as {
  build?: {
    files?: string[];
    extraResources?: Array<{ from?: string; to?: string }>;
    win?: { target?: Array<{ target?: string; arch?: string[] }>; requestedExecutionLevel?: string };
    nsis?: { oneClick?: boolean; perMachine?: boolean; allowElevation?: boolean; createStartMenuShortcut?: boolean; deleteAppDataOnUninstall?: boolean };
    portable?: { artifactName?: string };
  };
};

describe("desktop package contract", () => {
  test("ships source, GUI, production resources and tray assets outside asar", () => {
    expect(packageJson.build?.extraResources).toEqual(expect.arrayContaining([
      { from: "resources/staging/opencodex", to: "opencodex" },
      { from: "../src/tray/assets", to: "tray" },
    ]));
    expect(packageJson.build?.files).toContain("!resources/**/*");
  });

  test("builds x64 NSIS and portable artifacts without elevation defaults", () => {
    expect(packageJson.build?.win?.target).toEqual(expect.arrayContaining([
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] },
    ]));
    expect(packageJson.build?.win?.requestedExecutionLevel).toBe("asInvoker");
    expect(packageJson.build?.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      createStartMenuShortcut: true,
      deleteAppDataOnUninstall: false,
    });
    expect(packageJson.build?.portable?.artifactName).toBe("OpenCodex-Portable-x64.${ext}");
  });
});
