import { describe, expect, test } from "bun:test";
import {
  DESKTOP_RELEASES_API_URL,
  desktopBuildRevisionFromReleaseTag,
  desktopReleaseIdentityFromTag,
  desktopSetupAssetName,
  desktopVersionFromReleaseTag,
  fetchDesktopInstallerRelease,
} from "../src/update/desktop-release";

describe("desktop installer release update check", () => {
  test("extracts a semver from desktop release tags", () => {
    expect(desktopVersionFromReleaseTag("v0.1.1")).toBe("0.1.1");
    expect(desktopVersionFromReleaseTag("desktop-v0.1.2-preview.3")).toBe("0.1.2-preview.3");
    expect(desktopVersionFromReleaseTag("v2.8.1-build.2")).toBe("2.8.1");
    expect(desktopBuildRevisionFromReleaseTag("v2.8.1-build.2")).toBe(2);
    expect(desktopReleaseIdentityFromTag("v2.8.1-build.2")).toEqual({ version: "2.8.1", buildRevision: 2 });
    expect(desktopReleaseIdentityFromTag("v2.8.1.2")).toBeNull();
    expect(desktopVersionFromReleaseTag("no-version")).toBeNull();
  });

  test("derives the versioned installer asset name from the release version", () => {
    expect(desktopSetupAssetName("2.8.1")).toBe("OpenCodex-Setup-2.8.1-x64.exe");
    expect(desktopSetupAssetName("2.8.2-preview.1")).toBe("OpenCodex-Setup-2.8.2-preview.1-x64.exe");
  });

  test("latest channel reads the fork release and selects only the installer asset", async () => {
    const calls: string[] = [];
    const release = await fetchDesktopInstallerRelease("latest", async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            tag_name: "v2.8.1",
            html_url: "https://github.com/canyexuanfan/opencodex-Windows-desktop/releases/tag/v2.8.1",
            assets: [
              { name: "OpenCodex-Portable-x64.exe", browser_download_url: "https://example.invalid/portable.exe" },
              { name: "OpenCodex-Setup-x64.exe", browser_download_url: "https://example.invalid/unversioned.exe" },
              { name: "OpenCodex-Windows-Setup-2.8.1-x64.exe", browser_download_url: "https://example.invalid/wrong-pattern.exe" },
              { name: desktopSetupAssetName("2.8.1"), browser_download_url: "https://example.invalid/OpenCodex-Setup-2.8.1-x64.exe" },
            ],
          };
        },
      };
    });

    expect(calls).toEqual([`${DESKTOP_RELEASES_API_URL}/latest`]);
    expect(release).toEqual({
      latestVersion: "2.8.1",
      buildRevision: 1,
      releaseTag: "v2.8.1",
      releaseNotesUrl: "https://github.com/canyexuanfan/opencodex-Windows-desktop/releases/tag/v2.8.1",
      downloadUrl: "https://example.invalid/OpenCodex-Setup-2.8.1-x64.exe",
      assetName: desktopSetupAssetName("2.8.1"),
    });
  });

  test("preview channel scans prereleases and reports missing setup assets", async () => {
    const release = await fetchDesktopInstallerRelease("preview", async () => ({
      ok: true,
      status: 200,
      async json() {
        return [
          { tag_name: "v2.8.1", prerelease: false, assets: [{ name: desktopSetupAssetName("2.8.1"), browser_download_url: "https://example.invalid/stable.exe" }] },
          { tag_name: "v2.8.2-preview.1-build.2", prerelease: true, html_url: "https://example.invalid/preview", assets: [] },
        ];
      },
    }));

    expect(release).toEqual({
      latestVersion: "2.8.2-preview.1",
      buildRevision: 2,
      releaseTag: "v2.8.2-preview.1-build.2",
      releaseNotesUrl: "https://example.invalid/preview",
      downloadUrl: null,
      assetName: null,
    });
  });
});

describe("desktop installer release update check — anonymous API rate-limit fallback", () => {
  test("latest channel falls back to the web redirect when the API is rate-limited", async () => {
    const release = await fetchDesktopInstallerRelease("latest", async (url, init) => {
      if (url.includes("api.github.com")) return { ok: false, status: 403 };
      if (init?.method === "HEAD") return { ok: true, status: 302 };
      return {
        ok: false,
        status: 302,
        headers: { get: (name: string) => name.toLowerCase() === "location" ? "https://github.com/canyexuanfan/opencodex-Windows-desktop/releases/tag/v2.31.0-build.3" : null },
      };
    });
    expect(release).not.toBeNull();
    expect(release?.latestVersion).toBe("2.31.0");
    expect(release?.buildRevision).toBe(3);
    expect(release?.releaseTag).toBe("v2.31.0-build.3");
    expect(release?.assetName).toBe("OpenCodex-Setup-2.31.0-x64.exe");
    expect(release?.downloadUrl).toBe("https://github.com/canyexuanfan/opencodex-Windows-desktop/releases/download/v2.31.0-build.3/OpenCodex-Setup-2.31.0-x64.exe");
  });

  test("fallback reports null when the tagged asset is missing", async () => {
    const release = await fetchDesktopInstallerRelease("latest", async (url, init) => {
      if (url.includes("api.github.com")) return { ok: false, status: 403 };
      if (init?.method === "HEAD") return { ok: false, status: 404 };
      return {
        ok: false,
        status: 302,
        headers: { get: () => "https://github.com/canyexuanfan/opencodex-Windows-desktop/releases/tag/v2.31.0-build.3" },
      };
    });
    expect(release).toBeNull();
  });

  test("preview channel does not use the web fallback", async () => {
    const release = await fetchDesktopInstallerRelease("preview", async () => ({ ok: false, status: 403 }));
    expect(release).toBeNull();
  });
});
