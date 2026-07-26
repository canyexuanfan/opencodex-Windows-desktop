#!/usr/bin/env bun
/**
 * Pure helpers for GitHub release note assembly.
 * Used by `.github/workflows/release.yml` so stable (latest) releases can carry
 * the matching preview changelog, plus any delta since that preview.
 *
 * CLI:
 *   bun scripts/release-notes.ts strip-carried <body-file>
 *   bun scripts/release-notes.ts matching-preview-tag <version>
 *   bun scripts/release-notes.ts assemble --npm-metadata ... --out ...
 */

export function matchingPreviewTag(version: string, tags: string[]): string | null {
  if (!version || version.includes("-")) return null;
  const prefix = `v${version}-preview.`;
  const matches = tags
    .map(tag => tag.trim())
    .filter(tag => tag.startsWith(prefix));
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
  return matches[0] ?? null;
}

/** Drop npm blurb, Commits section, and Full Changelog link from a prior release body. */
export function stripCarriedReleaseNotes(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let inCommits = false;

  for (const line of lines) {
    if (/^Published to npm as /.test(line)) continue;
    if (/^\*\*Full Changelog\*\*:/.test(line)) continue;
    if (/^## Commits\s*$/.test(line)) {
      inCommits = true;
      continue;
    }
    if (inCommits) {
      if (/^## /.test(line)) {
        inCommits = false;
      } else {
        continue;
      }
    }
    kept.push(line);
  }

  return kept.join("\n").replace(/^\n+/, "").replace(/\n+$/, "").trim();
}

/** Drop generate-notes trailing compare link (workflow re-appends its own). */
export function stripGenerateNotesCompareLink(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(line => !/^\*\*Full Changelog\*\*:/.test(line))
    .join("\n")
    .replace(/\n+$/, "")
    .trim();
}

/** True when generate-notes returned only the config comment / blank lines. */
export function isEmptyGeneratedNotes(body: string): boolean {
  const withoutComment = stripGenerateNotesCompareLink(body)
    .split("\n")
    .filter(line => !/^<!--.*-->$/.test(line.trim()))
    .join("\n");
  return !hasNonWhitespace(withoutComment);
}

export function hasNonWhitespace(text: string): boolean {
  return text.replace(/\s+/g, "").length > 0;
}

export function assembleReleaseNotes(input: {
  npmMetadata: string;
  carriedPreviewNotes?: string;
  deltaPrNotes?: string;
  commits?: string;
  compareFrom?: string | null;
  compareTo?: string;
  repository?: string;
}): string {
  const parts: string[] = [];
  parts.push(input.npmMetadata.trim());

  const carried = (input.carriedPreviewNotes ?? "").trim();
  if (hasNonWhitespace(carried)) {
    parts.push(carried);
  }

  const deltaRaw = (input.deltaPrNotes ?? "").trim();
  const delta = isEmptyGeneratedNotes(deltaRaw) ? "" : stripGenerateNotesCompareLink(deltaRaw);
  if (hasNonWhitespace(delta)) {
    if (hasNonWhitespace(carried)) {
      parts.push("## Since preview\n\n" + delta);
    } else {
      parts.push(delta);
    }
  }

  const commits = (input.commits ?? "").trim();
  if (commits) {
    parts.push("## Commits\n\n" + commits);
  }

  const from = input.compareFrom?.trim();
  const to = input.compareTo?.trim();
  const repo = input.repository?.trim();
  if (from && to && repo) {
    parts.push(`**Full Changelog**: https://github.com/${repo}/compare/${from}...${to}`);
  }

  return parts.join("\n\n").replace(/\n+$/, "") + "\n";
}

async function readStdinOrFile(path: string | undefined): Promise<string> {
  if (path && path !== "-") {
    return await Bun.file(path).text();
  }
  return await new Response(Bun.stdin).text();
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === "strip-carried") {
    const stripped = stripCarriedReleaseNotes(await readStdinOrFile(rest[0]));
    process.stdout.write(stripped.endsWith("\n") ? stripped : stripped + "\n");
    return;
  }

  if (cmd === "matching-preview-tag") {
    const version = rest[0];
    if (!version) {
      console.error("Usage: bun scripts/release-notes.ts matching-preview-tag <version>");
      process.exit(1);
    }
    const tagsText = await new Response(Bun.stdin).text();
    const tag = matchingPreviewTag(version, tagsText.split(/\r?\n/));
    if (tag) process.stdout.write(tag + "\n");
    return;
  }

  if (cmd === "assemble") {
    const args = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 1) {
      const key = rest[i];
      if (!key?.startsWith("--")) continue;
      const value = rest[i + 1];
      if (!value || value.startsWith("--")) {
        console.error(`Missing value for ${key}`);
        process.exit(1);
      }
      args.set(key.slice(2), value);
      i += 1;
    }

    const npmMetadata = args.get("npm-metadata");
    const out = args.get("out");
    if (!npmMetadata || !out) {
      console.error("Usage: bun scripts/release-notes.ts assemble --npm-metadata <text> --out <file> [--carried <file>] [--delta <file>] [--commits <file>] [--compare-from <tag>] [--compare-to <tag>] [--repository <owner/name>]");
      process.exit(1);
    }

    const readOptional = async (name: string): Promise<string> => {
      const path = args.get(name);
      if (!path) return "";
      return await Bun.file(path).text();
    };

    const notes = assembleReleaseNotes({
      npmMetadata,
      carriedPreviewNotes: await readOptional("carried"),
      deltaPrNotes: await readOptional("delta"),
      commits: await readOptional("commits"),
      compareFrom: args.get("compare-from") ?? null,
      compareTo: args.get("compare-to"),
      repository: args.get("repository"),
    });
    await Bun.write(out, notes);
    return;
  }

  console.error(`Unknown command: ${cmd ?? "(none)"}
Usage:
  bun scripts/release-notes.ts strip-carried [body-file]
  bun scripts/release-notes.ts matching-preview-tag <version>  # tags on stdin
  bun scripts/release-notes.ts assemble --npm-metadata ... --out ...`);
  process.exit(1);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
