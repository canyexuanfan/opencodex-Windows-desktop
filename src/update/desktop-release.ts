import type { Channel } from "./index";

export const DESKTOP_RELEASE_REPO = "canyexuanfan/opencodex-Windows-desktop";
export const DESKTOP_RELEASE_NOTES_URL = `https://github.com/${DESKTOP_RELEASE_REPO}/releases/latest`;
export const DESKTOP_RELEASES_API_URL = `https://api.github.com/repos/${DESKTOP_RELEASE_REPO}/releases`;
export function desktopSetupAssetName(version: string): string {
  return `OpenCodex-Setup-${version}-x64.exe`;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface GitHubAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GitHubRelease {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  assets?: unknown;
}

export interface DesktopInstallerRelease {
  latestVersion: string;
  buildRevision: number;
  releaseTag: string;
  releaseNotesUrl: string;
  downloadUrl: string | null;
  assetName: string | null;
}

export interface DesktopReleaseIdentity {
  version: string;
  buildRevision: number;
}

const RELEASE_VERSION_PATTERN = /(?:^|[^0-9.])(\d+\.\d+\.\d+(?:-preview\.\d+)?)(?:-build\.(\d+))?(?![0-9.])/;
const DEFAULT_RELEASE_BUILD_REVISION = 1;

export function desktopReleaseIdentityFromTag(tag: string): DesktopReleaseIdentity | null {
  const match = RELEASE_VERSION_PATTERN.exec(tag);
  if (!match) return null;
  const buildRevision = match[2] === undefined ? DEFAULT_RELEASE_BUILD_REVISION : Number(match[2]);
  if (!Number.isSafeInteger(buildRevision) || buildRevision < 1) return null;
  return { version: match[1]!, buildRevision };
}

export function desktopVersionFromReleaseTag(tag: string): string | null {
  return desktopReleaseIdentityFromTag(tag)?.version ?? null;
}

export function desktopBuildRevisionFromReleaseTag(tag: string): number {
  return desktopReleaseIdentityFromTag(tag)?.buildRevision ?? DEFAULT_RELEASE_BUILD_REVISION;
}

function isReleaseRecord(value: unknown): value is GitHubRelease {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function setupAsset(release: GitHubRelease, version: string): { name: string; downloadUrl: string } | null {
  const expectedName = desktopSetupAssetName(version);
  const assets = Array.isArray(release.assets) ? release.assets as GitHubAsset[] : [];
  for (const asset of assets) {
    if (asset.name === expectedName && typeof asset.browser_download_url === "string") {
      return { name: expectedName, downloadUrl: asset.browser_download_url };
    }
  }
  return null;
}

function releaseIdentity(release: GitHubRelease): DesktopReleaseIdentity | null {
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const fromTag = desktopReleaseIdentityFromTag(tag);
  if (fromTag) return fromTag;
  const name = typeof release.name === "string" ? release.name : "";
  return desktopReleaseIdentityFromTag(name);
}

function releaseUrl(release: GitHubRelease): string {
  return typeof release.html_url === "string" && release.html_url
    ? release.html_url
    : DESKTOP_RELEASE_NOTES_URL;
}

function selectRelease(value: unknown, channel: Channel): GitHubRelease | null {
  if (isReleaseRecord(value)) return value.draft === true ? null : value;
  if (!Array.isArray(value)) return null;
  const releases = value.filter(isReleaseRecord).filter(release => release.draft !== true);
  if (channel === "preview") return releases.find(release => release.prerelease === true) ?? null;
  return releases.find(release => release.prerelease !== true) ?? null;
}

export async function fetchDesktopInstallerRelease(
  channel: Channel,
  fetchFn: FetchLike = fetch,
): Promise<DesktopInstallerRelease | null> {
  const url = channel === "preview"
    ? `${DESKTOP_RELEASES_API_URL}?per_page=20`
    : `${DESKTOP_RELEASES_API_URL}/latest`;
  const response = await fetchFn(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "opencodex-desktop-update-check",
    },
  });
  if (!response.ok) return null;
  const release = selectRelease(await response.json(), channel);
  if (!release) return null;
  const identity = releaseIdentity(release);
  if (!identity) return null;
  const releaseTag = typeof release.tag_name === "string" ? release.tag_name : "";
  const asset = setupAsset(release, identity.version);
  return {
    latestVersion: identity.version,
    buildRevision: identity.buildRevision,
    releaseTag,
    releaseNotesUrl: releaseUrl(release),
    downloadUrl: asset?.downloadUrl ?? null,
    assetName: asset?.name ?? null,
  };
}
