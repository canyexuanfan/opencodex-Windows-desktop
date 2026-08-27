import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareReleaseTags } from "../scripts/release-notes";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * The in-tree version must never sit BEHIND a version this repository has already
 * released.
 *
 * This is not hypothetical. dev accumulated 254 commits without ever touching
 * package.json, so its version string (2.32.1-preview.20260825) fell behind the
 * published latest dist-tag (2.33.0) once v2.33.0 was cut from main. One stale line,
 * two distinct failure modes:
 *
 *  - assertChannelVersionMovesForward in scripts/release.ts refuses the string as a
 *    channel regression, so a release cut from that tree cannot publish at all.
 *  - merging dev into main resolves package.json to main's side, producing a tree that
 *    claims to be the ALREADY-PUBLISHED 2.33.0 - a silent duplicate instead of a loud
 *    failure.
 *
 * Commit 32529c2b2 repaired precisely this by hand once, and nothing has enforced it
 * since. The assertion reads the local tag set rather than the npm registry, so it needs
 * no network and no edit at each release.
 *
 * compareReleaseTags comes from scripts/release-notes and not from scripts/release: the
 * latter parses process.argv and calls process.exit at module scope, so importing it from
 * a test kills the runner. release-notes guards its CLI behind import.meta.main.
 */

/** Release tags shaped vX.Y.Z[-pre]. Non-release tags are ignored, not an error. */
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function localReleaseTags(): string[] {
  const result = Bun.spawnSync(["git", "tag", "--list", "v*"], { cwd: repoRoot });
  // A tarball install, a shallow CI checkout, or a missing git binary all land here.
  // Absent tags cannot prove a regression, so the check reports nothing rather than
  // inventing a failure.
  if (result.exitCode !== 0) return [];
  return new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => RELEASE_TAG.test(line));
}

function inTreeVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error("package.json has no string version");
  return version;
}

/** Newest tag by SemVer precedence, or null when the set is empty. */
function highestReleaseTag(tags: string[]): string | null {
  if (tags.length === 0) return null;
  const sorted = [...tags].sort(compareReleaseTags);
  return sorted[sorted.length - 1] ?? null;
}

describe("release version line", () => {
  test("package.json carries a parseable SemVer version", () => {
    expect(inTreeVersion()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  test("the in-tree version is strictly ahead of every tagged release", () => {
    const tags = localReleaseTags();
    if (tags.length === 0) {
      // Shallow checkout: actions/checkout fetches no tags by default. Reporting nothing
      // keeps this honest instead of asserting against an empty set that always passes.
      expect(tags).toEqual([]);
      return;
    }

    const version = inTreeVersion();
    const highest = highestReleaseTag(tags);
    expect(highest).not.toBeNull();

    const ordering = compareReleaseTags("v" + version, highest!);
    expect(
      ordering,
      "package.json version " + version + " is not ahead of the highest release tag " +
        highest +
        ". A release cut from this tree is either rejected as a channel regression or " +
        "silently republishes an already-published version. Bump package.json.",
    ).toBeGreaterThan(0);
  });

  test("a version behind the tag set is detected rather than tolerated", () => {
    // Proves the comparison above is not vacuous: the same helper, given the exact string
    // dev actually carried, must order it BEHIND the release that stranded it.
    expect(compareReleaseTags("v2.32.1-preview.20260825", "v2.33.0")).toBeLessThan(0);
    expect(compareReleaseTags("v2.33.0", "v2.33.0")).toBe(0);
    expect(compareReleaseTags("v2.34.0", "v2.33.0")).toBeGreaterThan(0);
  });
});
