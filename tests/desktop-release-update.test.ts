import { describe, expect, test } from "bun:test";
import {
  DESKTOP_RELEASES_API_URL,
  DESKTOP_SETUP_ASSET_NAME,
  desktopVersionFromReleaseTag,
  fetchDesktopInstallerRelease,
} from "../src/update/desktop-release";

describe("desktop installer release update check", () => {
  test("extracts a semver from desktop release tags", () => {
    expect(desktopVersionFromReleaseTag("v0.1.1")).toBe("0.1.1");
    expect(desktopVersionFromReleaseTag("desktop-v0.1.2-preview.3")).toBe("0.1.2-preview.3");
    expect(desktopVersionFromReleaseTag("no-version")).toBeNull();
  });

  test("latest channel reads the fork release and selects the Windows setup asset", async () => {
    const calls: string[] = [];
    const release = await fetchDesktopInstallerRelease("latest", async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            tag_name: "v0.1.1",
            html_url: "https://github.com/canyexuanfan/opencodex-Windows-desktop/releases/tag/v0.1.1",
            assets: [
              { name: "OpenCodex-Portable-x64.exe", browser_download_url: "https://example.invalid/portable.exe" },
              { name: DESKTOP_SETUP_ASSET_NAME, browser_download_url: "https://example.invalid/OpenCodex-Setup-x64.exe" },
            ],
          };
        },
      };
    });

    expect(calls).toEqual([`${DESKTOP_RELEASES_API_URL}/latest`]);
    expect(release).toEqual({
      latestVersion: "0.1.1",
      releaseNotesUrl: "https://github.com/canyexuanfan/opencodex-Windows-desktop/releases/tag/v0.1.1",
      downloadUrl: "https://example.invalid/OpenCodex-Setup-x64.exe",
      assetName: DESKTOP_SETUP_ASSET_NAME,
    });
  });

  test("preview channel scans prereleases and reports missing setup assets", async () => {
    const release = await fetchDesktopInstallerRelease("preview", async () => ({
      ok: true,
      status: 200,
      async json() {
        return [
          { tag_name: "v0.1.1", prerelease: false, assets: [{ name: DESKTOP_SETUP_ASSET_NAME, browser_download_url: "https://example.invalid/stable.exe" }] },
          { tag_name: "v0.1.2-preview.1", prerelease: true, html_url: "https://example.invalid/preview", assets: [] },
        ];
      },
    }));

    expect(release).toEqual({
      latestVersion: "0.1.2-preview.1",
      releaseNotesUrl: "https://example.invalid/preview",
      downloadUrl: null,
      assetName: null,
    });
  });
});
