import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const packageJson = JSON.parse(readFileSync(path.resolve(import.meta.dir, "..", "package.json"), "utf8")) as {
  version?: string;
  build?: {
    files?: string[];
    extraResources?: Array<{ from?: string; to?: string; filter?: string[] }>;
    win?: { icon?: string; target?: Array<{ target?: string; arch?: string[] }>; requestedExecutionLevel?: string };
    nsis?: { oneClick?: boolean; perMachine?: boolean; allowElevation?: boolean; selectPerMachineByDefault?: boolean; allowToChangeInstallationDirectory?: boolean; include?: string; installerIcon?: string; uninstallerIcon?: string; unicode?: boolean; createDesktopShortcut?: boolean | "always"; createStartMenuShortcut?: boolean; deleteAppDataOnUninstall?: boolean; artifactName?: string };
  };
};
const rootPackageJson = JSON.parse(readFileSync(path.resolve(import.meta.dir, "..", "..", "package.json"), "utf8")) as {
  version?: string;
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
  test("keeps the desktop host version aligned with the bundled opencodex runtime", () => {
    expect(packageJson.version).toBe(rootPackageJson.version);
  });

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

  test("builds only the x64 NSIS installer with a normal Windows default", () => {
    expect(packageJson.build?.win?.target).toEqual([
      { target: "nsis", arch: ["x64"] },
    ]);
    expect(packageJson.build?.win?.requestedExecutionLevel).toBe("asInvoker");
    expect(packageJson.build?.win?.icon).toBe("build/icon.ico");
    expect(packageJson.build?.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      selectPerMachineByDefault: true,
      allowToChangeInstallationDirectory: false,
      installerIcon: "build/icon.ico",
      uninstallerIcon: "build/icon.ico",
      unicode: true,
      createDesktopShortcut: "always",
      createStartMenuShortcut: true,
      deleteAppDataOnUninstall: false,
      artifactName: "OpenCodex-Setup-${version}-x64.${ext}",
    });
    expect(packageJson.build?.nsis?.artifactName).toContain("${version}");
    expect(existsSync(path.resolve(import.meta.dir, "..", "build", "icon.ico"))).toBe(true);
  });

  test("keeps the application-name subfolder when the install directory is changed", () => {
    expect(packageJson.build?.nsis?.allowToChangeInstallationDirectory).toBe(false);
    expect(packageJson.build?.nsis?.unicode).toBe(true);
    expect(assistedInstaller).toContain("!ifdef allowToChangeInstallationDirectory");
    expect(assistedInstaller).toContain('StrCpy $INSTDIR "$INSTDIR\\${APP_FILENAME}"');
    expect(packageJson.build?.nsis?.include).toBe("build/installer.nsh");
    expect(customInstaller).toContain("!macro customPageAfterChangeDir");
    expect(customInstaller).toContain("Page custom ocxDirectoryPageCreate ocxDirectoryPageLeave");
    expect(customInstaller).toContain("${NSD_CreateDirRequest}");
    expect(customInstaller).toContain("${NSD_CreateBrowseButton}");
    expect(customInstaller).toContain("nsDialogs::SelectFolderDialog");
    expect(customInstaller).toContain("${NSD_SetText} $ocxInstallDirInput \"$INSTDIR\"");
    expect(customInstaller).toContain("!include FileFunc.nsh");
    expect(customInstaller).toContain('${GetFileName} "$INSTDIR" $0');
    expect(customInstaller).toContain('StrCpy $INSTDIR "$INSTDIR\\${APP_FILENAME}"');
    expect(customInstaller).toContain("Call ocxEnsureInstallDir");
  });

  test("rewrites Windows shortcuts with the bundled OpenCodex icon", () => {
    expect(customInstaller).toContain("!macro customInstall");
    expect(customInstaller).toContain('StrCpy $0 "$INSTDIR\\resources\\tray\\opencodex-tray-online.ico"');
    expect(customInstaller).toContain('Delete "$newStartMenuLink"');
    expect(customInstaller).toContain('CreateShortCut "$newStartMenuLink" "$appExe" "" "$0"');
    expect(customInstaller).toContain('Delete "$newDesktopLink"');
    expect(customInstaller).toContain('CreateShortCut "$newDesktopLink" "$appExe" "" "$0"');
    expect(customInstaller).not.toContain("${isNoDesktopShortcut}");
    expect(customInstaller).toContain("Shell32::SHChangeNotify");
  });

  test("copies production dependencies without reinstalling the bundled Bun package", () => {
    expect(resourcePreparation).toContain("copyProductionDependencies");
    expect(resourcePreparation).toContain("delete metadata.dependencies.bun");
  });
});
