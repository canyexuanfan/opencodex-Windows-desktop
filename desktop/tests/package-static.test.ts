import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const packageJson = JSON.parse(readFileSync(path.resolve(import.meta.dir, "..", "package.json"), "utf8")) as {
  build?: {
    files?: string[];
    extraResources?: Array<{ from?: string; to?: string; filter?: string[] }>;
    win?: { target?: Array<{ target?: string; arch?: string[] }>; requestedExecutionLevel?: string };
    nsis?: { oneClick?: boolean; perMachine?: boolean; allowElevation?: boolean; allowToChangeInstallationDirectory?: boolean; include?: string; unicode?: boolean; createStartMenuShortcut?: boolean; deleteAppDataOnUninstall?: boolean };
    portable?: { artifactName?: string };
  };
};
const assistedInstaller = readFileSync(
  path.resolve(import.meta.dir, "..", "node_modules", "app-builder-lib", "templates", "nsis", "assistedInstaller.nsh"),
  "utf8",
);
const resourcePreparation = readFileSync(
  path.resolve(import.meta.dir, "..", "..", "scripts", "prepare-desktop-resources.ts"),
  "utf8",
);
const customInstaller = readFileSync(path.resolve(import.meta.dir, "..", "build", "installer.nsh"), "utf8");

describe("desktop package contract", () => {
  test("ships source, GUI, production resources and tray assets outside asar", () => {
    expect(packageJson.build?.extraResources).toEqual(expect.arrayContaining([
      { from: "resources/staging/opencodex", to: "opencodex" },
      { from: "../src/tray/assets", to: "tray" },
    ]));
    expect(packageJson.build?.extraResources).toEqual(expect.arrayContaining([
      {
        from: "resources/staging/opencodex/node_modules",
        to: "opencodex/node_modules",
        filter: ["**/*", "!bun{,/**/*}", "!@oven{,/**/*}"],
      },
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
      allowToChangeInstallationDirectory: true,
      unicode: true,
      createStartMenuShortcut: true,
      deleteAppDataOnUninstall: false,
    });
    expect(packageJson.build?.portable?.artifactName).toBe("OpenCodex-Portable-x64.${ext}");
  });

  test("keeps the application-name subfolder when the install directory is changed", () => {
    expect(packageJson.build?.nsis?.allowToChangeInstallationDirectory).toBe(true);
    expect(packageJson.build?.nsis?.unicode).toBe(true);
    expect(assistedInstaller).toContain("!ifdef allowToChangeInstallationDirectory");
    expect(assistedInstaller).toContain('StrCpy $INSTDIR "$INSTDIR\\${APP_FILENAME}"');
    expect(packageJson.build?.nsis?.include).toBe("build/installer.nsh");
    expect(customInstaller).toContain("${StdUtils.GetFileNamePart} $0 \"$INSTDIR\"");
    expect(customInstaller).toContain('StrCpy $INSTDIR "$INSTDIR\\${APP_FILENAME}"');
    expect(customInstaller).toContain("!define MUI_PAGE_CUSTOMFUNCTION_SHOW ocxDirectoryPageShow");
    expect(customInstaller).toContain("!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ocxDirectoryPageLeave");
    expect(customInstaller).toContain("!define MUI_PAGE_CUSTOMFUNCTION_PRE ocxDirectoryPagePre");
    expect(customInstaller).toContain("Function ocxDirectoryPagePre");
    expect(customInstaller).toContain("GetDlgItem $1 $0 1019");
    expect(customInstaller).toContain("${NSD_SetText} $1 $2");
    expect(customInstaller).toContain('${GetFileName} "$2" $3');
  });

  test("copies production dependencies instead of preserving development cache hardlinks", () => {
    expect(resourcePreparation).toContain('"--backend=copyfile"');
  });
});
