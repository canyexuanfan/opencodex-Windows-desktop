#!/usr/bin/env bun
/**
 * Pure helpers for GitHub release note assembly.
 * Used by `.github/workflows/release.yml` so stable (latest) releases can carry
 * matching preview changelogs, plus any delta since the last carried preview.
 *
 * CLI:
 *   bun scripts/release-notes.ts strip-carried <body-file>
 *   bun scripts/release-notes.ts matching-preview-tag <version>
 *   bun scripts/release-notes.ts matching-preview-tags <version>
 *   bun scripts/release-notes.ts previous-release-tag <version>
 *   bun scripts/release-notes.ts has-meaningful [body-file]
 *   bun scripts/release-notes.ts credit-takeovers --repo <owner/name> --in <file> --out <file>
 *   bun scripts/release-notes.ts render --npm-metadata ... --out ... [--carried ...] [--delta ...] [--compare-from ...] [--compare-to ...] [--repository ...]
 *   bun scripts/release-notes.ts polish --in <file> --out <file> [--model ...] [--base-url ...] [--api-key ...]
 */

type ParsedReleaseTag = {
  major: number;
  minor: number;
  patch: number;
  /** null = stable release; otherwise the SemVer prerelease identifier string. */
  prerelease: string | null;
};

function parseReleaseTag(tag: string): ParsedReleaseTag | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(tag.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** SemVer identifier compare: numeric parts by number; numeric < non-numeric. */
function comparePrereleaseIds(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i += 1) {
    const ap = aParts[i];
    const bp = bParts[i];
    if (ap === undefined) return -1;
    if (bp === undefined) return 1;
    const aNum = /^\d+$/.test(ap);
    const bNum = /^\d+$/.test(bp);
    if (aNum && bNum) {
      const diff = Number(ap) - Number(bp);
      if (diff !== 0) return diff;
      continue;
    }
    if (aNum !== bNum) return aNum ? -1 : 1;
    const cmp = ap.localeCompare(bp);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * Ascending SemVer-aware tag compare. Stable ranks after prereleases with the
 * same core version (`v2.7.42-preview.*` < `v2.7.42`).
 */
export function compareReleaseTags(a: string, b: string): number {
  const pa = parseReleaseTag(a);
  const pb = parseReleaseTag(b);
  if (!pa || !pb) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease === null && pb.prerelease === null) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return comparePrereleaseIds(pa.prerelease, pb.prerelease);
}

function sortVersionTagsAscending(tags: string[]): string[] {
  return [...tags].sort(compareReleaseTags);
}

/** Newest matching preview tag for a stable version, or null. */
export function matchingPreviewTag(version: string, tags: string[]): string | null {
  const matches = matchingPreviewTags(version, tags);
  return matches.length === 0 ? null : matches[matches.length - 1]!;
}

/**
 * All matching preview tags for a stable version, oldest → newest.
 * Each preview's notes are incremental vs the previous preview, so stable
 * releases must aggregate in this order to avoid dropping earlier preview work.
 */
export function matchingPreviewTags(version: string, tags: string[]): string[] {
  if (!version || version.includes("-")) return [];
  const prefix = `v${version}-preview.`;
  const matches = tags
    .map(tag => tag.trim())
    .filter(tag => tag.startsWith(prefix));
  return sortVersionTagsAscending(matches);
}

/**
 * Previous release tag used as the generate-notes / changelog baseline.
 *
 * - Preview releases: newest prior tag of either channel (stable or preview).
 *   Channel-isolated preview→preview baselines skip a shipped stable and restate
 *   that stable's changelog (e.g. 2.7.41-preview → 2.7.43-preview after 2.7.42).
 * - Stable releases: newest prior stable only. Matching preview carry adjusts the
 *   notes range start separately when assembling latest notes.
 */
export function previousReleaseNotesTag(version: string, tags: string[]): string | null {
  if (!version) return null;
  const releaseTag = version.startsWith("v") ? version : `v${version}`;
  const candidates = tags
    .map(tag => tag.trim())
    .filter(tag => /^v\d/.test(tag) && compareReleaseTags(tag, releaseTag) < 0);
  const filtered = version.includes("-preview.")
    ? candidates
    : candidates.filter(tag => !tag.includes("-preview."));
  const sorted = sortVersionTagsAscending(filtered);
  return sorted.length === 0 ? null : sorted[sorted.length - 1]!;
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

/** True when generate-notes returned only the config comment / blank lines. */
export function isEmptyGeneratedNotes(body: string): boolean {
  const withoutComment = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(line => !/^<!--.*-->$/.test(line.trim()))
    .filter(line => !/^\*\*Full Changelog\*\*:/.test(line))
    .join("\n");
  return !hasNonWhitespace(withoutComment);
}

/**
 * True when stripped carried notes contain a usable changelog (not blank /
 * comment-only). Commits-only preview releases strip down to empty and must not
 * move the stable notes baseline.
 */
export function hasMeaningfulCarriedNotes(stripped: string): boolean {
  return !isEmptyGeneratedNotes(stripped);
}

export function hasNonWhitespace(text: string): boolean {
  return text.replace(/\s+/g, "").length > 0;
}

/** Join multiple stripped preview bodies in chronological order. */
export function joinCarriedPreviewNotes(parts: string[]): string {
  return parts
    .map(part => part.trim())
    .filter(part => hasMeaningfulCarriedNotes(part))
    .join("\n\n")
    .trim();
}

/**
 * Newest preview tag whose GitHub Release body strips to a meaningful changelog.
 * Missing releases (`releaseBody === null`) and empty/commits-only bodies must not
 * advance the baseline — otherwise a later empty preview.2 would hide the
 * preview.1→preview.2 gap from both carried notes and the generated delta.
 */
export function selectNewestCarriedPreviewTag(
  entries: Array<{ tag: string; releaseBody: string | null }>,
): string | null {
  let newest: string | null = null;
  for (const entry of entries) {
    if (entry.releaseBody === null) continue;
    const stripped = stripCarriedReleaseNotes(entry.releaseBody);
    if (hasMeaningfulCarriedNotes(stripped)) newest = entry.tag;
  }
  return newest;
}

/**
 * Parse a maintainer-takeover source PR number from title/body text.
 * Matches forms already used in-repo: `takeover of #N`, `takeover #N`,
 * `maintainer takeover of #N` (case-insensitive).
 */
export function parseTakeoverSourcePr(title: string, body = ""): number | null {
  const text = `${title}\n${body}`;
  const match = /\b(?:maintainer\s+)?takeover(?:\s+of)?\s+#(\d+)\b/i.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const GENERATE_NOTES_PR_LINE =
  /^(?<prefix>\* .+? by @)(?<author>[A-Za-z0-9-]+)(?<mid> in https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/)(?<pr>\d+)(?<suffix>\s*)$/;

export type TakeoverCreditLookup = {
  title: string;
  body: string;
  authorLogin: string;
};

/**
 * Rewrite generate-notes lines so maintainer-takeover PRs also credit the
 * original PR creator: `by @Original (takeover by @Landing) in …/pull/P`.
 *
 * Prefer the takeover marker already present in the notes-line title (cheap,
 * no landing lookup). Fall back to `resolveLanding` only when the title
 * mentions "takeover" but does not match a known `#N` form, so body text can
 * still supply the source. Ordinary non-takeover lines never call either
 * resolver.
 */
export async function rewriteTakeoverCredits(
  notesBody: string,
  resolveLanding: (prNumber: number) => Promise<TakeoverCreditLookup | null>,
  resolveOriginalAuthor: (sourcePrNumber: number) => Promise<string | null>,
): Promise<string> {
  const lines = notesBody.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const match = GENERATE_NOTES_PR_LINE.exec(line);
    if (!match?.groups) {
      out.push(line);
      continue;
    }
    const landingPr = Number(match.groups.pr);
    const landingAuthor = match.groups.author!;
    const titleHint = match.groups.prefix
      .replace(/^\* /, "")
      .replace(/ by @$/, "");
    let sourcePr = parseTakeoverSourcePr(titleHint);
    if (sourcePr == null) {
      if (!/\btakeover\b/i.test(titleHint)) {
        out.push(line);
        continue;
      }
      const landing = await resolveLanding(landingPr);
      if (!landing) {
        out.push(line);
        continue;
      }
      sourcePr = parseTakeoverSourcePr(landing.title, landing.body);
      if (sourcePr == null) {
        out.push(line);
        continue;
      }
    }
    const original = await resolveOriginalAuthor(sourcePr);
    if (!original || original.toLowerCase() === landingAuthor.toLowerCase()) {
      out.push(line);
      continue;
    }
    out.push(
      `${match.groups.prefix}${original} (takeover by @${landingAuthor})${match.groups.mid}${match.groups.pr}${match.groups.suffix ?? ""}`,
    );
  }
  return out.join("\n");
}

export type ReleaseNotePr = {
  number: number;
  title: string;
  author: string;
};

export type ReleaseNoteCategory = {
  title: string;
  prs: ReleaseNotePr[];
};

/**
 * Parse GitHub generate-notes output (`* <title> by @<author> in …/pull/<N>`,
 * including maintainer-takeover lines rewritten by `credit-takeovers`) into
 * category sections. Also understands the renderer's own output (`## <Category>`
 * sections with `- … (#N)` bullets and a `## Changelog` list of
 * `- #N <title> @author` lines), so already-rendered preview bodies carry into
 * stable notes losslessly. Scaffolding (`## What's Changed`, `## New
 * Contributors`, `## Commits`) never reaches the renderer. Changelog lines
 * supply the authoritative title/author for PRs first seen in bullets.
 */
const GENERATED_PR_LINE =
  /^\*\s*(?<title>.+?)\s+by\s+@(?<author>[A-Za-z0-9-]+)(?:\s+\(takeover\s+by\s+@[A-Za-z0-9-]+\))?\s+in\s+https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(?<pr>\d+)\s*$/;
const GENERATED_BULLET_LINE =
  /^-\s+(?<text>.+?)\s+\((?<refs>#\d+(?:\s*,\s*#\d+)*)\)\s*$/;
const CHANGELOG_PR_LINE =
  /^-\s+#(?<pr>\d+)\s+(?<title>.+?)\s+@(?<author>[A-Za-z0-9-]+)\s*$/;
const SCAFFOLD_HEADINGS = new Set(["What's Changed", "New Contributors", "Commits", "Changelog", "Since preview"]);

export function parseGeneratedNotes(body: string): ReleaseNoteCategory[] {
  const sections: ReleaseNoteCategory[] = [];
  const globalPrs = new Map<number, ReleaseNotePr>();
  let current: ReleaseNoteCategory | null = null;
  for (const rawLine of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("<!--")) continue;
    if (line.startsWith("### ")) {
      const title = line.slice(4).trim();
      current = { title, prs: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith("## ")) {
      const title = line.slice(3).trim();
      if (SCAFFOLD_HEADINGS.has(title)) {
        current = null;
      } else {
        current = { title, prs: [] };
        sections.push(current);
      }
      continue;
    }
    const changelogLine = CHANGELOG_PR_LINE.exec(line);
    if (changelogLine?.groups) {
      globalPrs.set(Number(changelogLine.groups.pr), {
        number: Number(changelogLine.groups.pr),
        title: changelogLine.groups.title!,
        author: changelogLine.groups.author!,
      });
      continue;
    }
    if (!current) continue;
    const match = GENERATED_PR_LINE.exec(line);
    if (match?.groups) {
      current.prs.push({
        number: Number(match.groups.pr),
        title: match.groups.title!,
        author: match.groups.author!,
      });
      continue;
    }
    const bullet = GENERATED_BULLET_LINE.exec(line);
    if (bullet?.groups) {
      const text = bullet.groups.text!;
      for (const ref of bullet.groups.refs!.matchAll(/#(\d+)/g)) {
        current.prs.push({ number: Number(ref[1]), title: text, author: "" });
      }
    }
  }
  for (const section of sections) {
    section.prs = section.prs.map(pr => globalPrs.get(pr.number) ?? pr);
  }
  return sections;
}

/**
 * Strip a conventional-commit prefix (`feat(scope): …`, `fix: …`, …) and a
 * trailing `(#N)` that repeats the PR's own number, then sentence-case the
 * remaining title for the curated section bullets.
 */
const CONVENTIONAL_COMMIT_PREFIX =
  /^(?:feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert|merge|release)(?:\(([^)]+)\))?:\s*(.+)$/i;

export function cleanPrTitle(title: string, prNumber: number | null = null): { scope: string | null; text: string } {
  let text = title.trim();
  let scope: string | null = null;
  const prefix = CONVENTIONAL_COMMIT_PREFIX.exec(text);
  if (prefix) {
    scope = prefix[1] ?? null;
    text = prefix[2]!.trim();
  }
  if (prNumber !== null) {
    text = text.replace(new RegExp(`\\s*\\(#${prNumber}\\)\\s*$`), "");
  }
  text = text.trim();
  if (text.length > 0) {
    text = text[0]!.toUpperCase() + text.slice(1);
  }
  return { scope, text };
}

/** "release-notes" → "Release-Notes" for group-bullet scope labels. */
export function scopeLabel(scope: string): string {
  return scope
    .split("-")
    .map(part => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join("-");
}

/** Group PRs by conventional-commit scope, preserving first-appearance order. */
export function groupPrsByScope(prs: ReleaseNotePr[]): Array<{ scope: string | null; prs: ReleaseNotePr[] }> {
  const groups: Array<{ scope: string | null; prs: ReleaseNotePr[] }> = [];
  for (const pr of prs) {
    const { scope } = cleanPrTitle(pr.title, pr.number);
    const group = groups.find(candidate => candidate.scope === scope);
    if (group) {
      group.prs.push(pr);
    } else {
      groups.push({ scope, prs: [pr] });
    }
  }
  return groups;
}

const RENDER_CATEGORY_ORDER = ["New Features", "Bug Fixes", "Documentation", "Chores", "Other Changes"];

/**
 * Render OpenAI-Codex-style release notes from the generate-notes pieces:
 * H2 category sections with scope-grouped, prefix-free summary bullets, then a
 * `## Changelog` section with every PR (`- #N <title> @author`) and the compare
 * link. Carried preview notes and the since-preview delta merge by category;
 * duplicate PR numbers (defensive; ranges are normally disjoint) keep the
 * first occurrence.
 */
export function renderReleaseNotes(input: {
  npmMetadata: string;
  carriedPreviewNotes?: string;
  deltaPrNotes?: string;
  compareFrom?: string | null;
  compareTo?: string;
  repository?: string;
}): string {
  const categories = new Map<string, ReleaseNotePr[]>();
  const order: string[] = [];
  const add = (body: string): void => {
    for (const section of parseGeneratedNotes(body)) {
      const existing = categories.get(section.title);
      if (!existing) {
        categories.set(section.title, []);
        order.push(section.title);
      }
      const seen = new Set(categories.get(section.title)!.map(pr => pr.number));
      for (const pr of section.prs) {
        if (seen.has(pr.number)) continue;
        seen.add(pr.number);
        categories.get(section.title)!.push(pr);
      }
    }
  };
  add(input.carriedPreviewNotes ?? "");
  add(input.deltaPrNotes ?? "");

  const parts: string[] = [];
  const npmMetadata = input.npmMetadata.trim();
  if (npmMetadata) parts.push(npmMetadata);

  const sortedOrder = [...order].sort((a, b) => {
    const ia = RENDER_CATEGORY_ORDER.indexOf(a);
    const ib = RENDER_CATEGORY_ORDER.indexOf(b);
    const rankA = ia === -1 ? RENDER_CATEGORY_ORDER.length : ia;
    const rankB = ib === -1 ? RENDER_CATEGORY_ORDER.length : ib;
    if (rankA !== rankB) return rankA - rankB;
    return order.indexOf(a) - order.indexOf(b);
  });

  for (const title of sortedOrder) {
    const prs = categories.get(title)!;
    if (prs.length === 0) continue;
    const lines: string[] = [`## ${title}`, ""];
    for (const group of groupPrsByScope(prs)) {
      if (group.prs.length === 1) {
        const pr = group.prs[0]!;
        lines.push(`- ${cleanPrTitle(pr.title, pr.number).text} (#${pr.number})`);
      } else {
        const label = group.scope ? scopeLabel(group.scope) : null;
        const texts = group.prs.map(pr => cleanPrTitle(pr.title, pr.number).text);
        const refs = group.prs.map(pr => `#${pr.number}`).join(", ");
        lines.push(`- ${label ? `${label}: ` : ""}${texts.join("; ")} (${refs})`);
      }
    }
    parts.push(lines.join("\n"));
  }

  const allPrs = [...categories.values()].flat().sort((a, b) => a.number - b.number);
  if (allPrs.length > 0) {
    const changelog: string[] = ["## Changelog", ""];
    const from = input.compareFrom?.trim();
    const to = input.compareTo?.trim();
    const repo = input.repository?.trim();
    if (from && to && repo) {
      changelog.push(`Full Changelog: https://github.com/${repo}/compare/${from}...${to}`, "");
    }
    for (const pr of allPrs) {
      changelog.push(`- #${pr.number} ${pr.title.trim()} @${pr.author}`);
    }
    parts.push(changelog.join("\n"));
  }

  if (parts.length === 0) return "";
  return parts.join("\n\n").replace(/\n+$/, "") + "\n";
}

/** Every `#N` reference in a text, deduplicated and ascending. */
export function extractPrNumbers(text: string): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(/#(\d+)/g)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}

/** H2 headings in a section, excluding the machine-rendered Changelog. */
export function parseSectionHeadings(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => /^##\s+(.+)$/.exec(line.trim())?.[1])
    .filter((title): title is string => typeof title === "string" && title !== "Changelog");
}

/**
 * Guard rails for the optional LLM polish step: the rewritten head must keep
 * the exact PR set and the exact category headings. Any missing/invented PR or
 * category is a hard failure so a summarizer can never silently corrupt notes.
 */
export function validatePolishedSections(head: string, expectedPrs: number[], expectedHeadings: string[]): string[] {
  const errors: string[] = [];
  const actualPrs = extractPrNumbers(head);
  const missing = expectedPrs.filter(number => !actualPrs.includes(number));
  const unexpected = actualPrs.filter(number => !expectedPrs.includes(number));
  if (missing.length > 0) errors.push(`missing PR references: #${missing.join(", #")}`);
  if (unexpected.length > 0) errors.push(`unexpected PR references: #${unexpected.join(", #")}`);

  const headings = parseSectionHeadings(head);
  const missingHeadings = expectedHeadings.filter(title => !headings.includes(title));
  const extraHeadings = headings.filter(title => !expectedHeadings.includes(title));
  if (missingHeadings.length > 0) errors.push(`missing headings: ${missingHeadings.join(", ")}`);
  if (extraHeadings.length > 0) errors.push(`unexpected headings: ${extraHeadings.join(", ")}`);
  return errors;
}

const POLISH_SYSTEM_PROMPT = `You are the release notes editor for opencodex, a universal provider proxy for OpenAI Codex and Claude Code.
Rewrite the release-notes sections below (everything before "## Changelog") in the style of OpenAI Codex release notes:

- Keep the exact same markdown headings and their order.
- Keep the first line (npm metadata) verbatim.
- Group related pull requests into single bullets: one human-readable sentence (or two) summarizing what changed, ending with the full PR reference list in parentheses, e.g. "- Honor configured proxies across authentication, plugin downloads, and redirects. (#123, #456)".
- Every PR number must appear exactly once across the bullets; never invent PR numbers or features.
- Do not add or remove categories. Omit a category only when it has no PRs.
- Do not output the "## Changelog" section.
Output only the rewritten markdown.`;

async function callChatCompletion(apiKey: string, baseUrl: string, model: string, head: string): Promise<string> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: "system", content: POLISH_SYSTEM_PROMPT },
        { role: "user", content: head },
      ],
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error(`✗ polish LLM request failed (HTTP ${response.status}): ${detail.slice(0, 500)}`);
    process.exit(1);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    console.error("✗ polish LLM returned no content");
    process.exit(1);
  }
  return content;
}

function splitPolishInput(body: string): { head: string; changelog: string } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const index = lines.findIndex(line => /^##\s+Changelog\s*$/.test(line.trim()));
  if (index === -1) {
    console.error("✗ polish input has no `## Changelog` section to validate against");
    process.exit(1);
  }
  return {
    head: lines.slice(0, index).join("\n").trim(),
    changelog: lines.slice(index).join("\n").trim(),
  };
}

async function readStdinOrFile(path: string | undefined): Promise<string> {
  if (path && path !== "-") {
    return await Bun.file(path).text();
  }
  return await new Response(Bun.stdin).text();
}

function parseFlagArgs(rest: string[]): Map<string, string> {
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
  return args;
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === "strip-carried") {
    const stripped = stripCarriedReleaseNotes(await readStdinOrFile(rest[0]));
    process.stdout.write(stripped.endsWith("\n") ? stripped : stripped + "\n");
    return;
  }

  if (cmd === "has-meaningful") {
    const stripped = (await readStdinOrFile(rest[0])).trim();
    process.exit(hasMeaningfulCarriedNotes(stripped) ? 0 : 1);
  }

  if (cmd === "join-carried") {
    let out: string | undefined;
    const files: string[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (arg === "--out") {
        const value = rest[i + 1];
        if (!value || value.startsWith("--")) {
          console.error("Missing value for --out");
          process.exit(1);
        }
        out = value;
        i += 1;
        continue;
      }
      if (arg?.startsWith("--")) {
        console.error(`Unknown flag: ${arg}`);
        process.exit(1);
      }
      if (arg) files.push(arg);
    }
    if (!out || files.length === 0) {
      console.error("Usage: bun scripts/release-notes.ts join-carried --out <file> <part-file>...");
      process.exit(1);
    }
    const parts = await Promise.all(files.map(path => Bun.file(path).text()));
    const joined = joinCarriedPreviewNotes(parts);
    await Bun.write(out, joined ? joined + "\n" : "");
    return;
  }

  if (cmd === "matching-preview-tag" || cmd === "matching-preview-tags" || cmd === "previous-release-tag") {
    const version = rest[0];
    if (!version) {
      console.error(`Usage: bun scripts/release-notes.ts ${cmd} <version>`);
      process.exit(1);
    }
    const tagsText = await new Response(Bun.stdin).text();
    const tags = tagsText.split(/\r?\n/);
    if (cmd === "matching-preview-tag") {
      const tag = matchingPreviewTag(version, tags);
      if (tag) process.stdout.write(tag + "\n");
      return;
    }
    if (cmd === "previous-release-tag") {
      const tag = previousReleaseNotesTag(version, tags);
      if (tag) process.stdout.write(tag + "\n");
      return;
    }
    for (const tag of matchingPreviewTags(version, tags)) {
      process.stdout.write(tag + "\n");
    }
    return;
  }

  if (cmd === "credit-takeovers") {
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
    const repo = args.get("repo");
    const inputPath = args.get("in");
    const outPath = args.get("out");
    if (!repo || !inputPath || !outPath) {
      console.error("Usage: bun scripts/release-notes.ts credit-takeovers --repo <owner/name> --in <file> --out <file>");
      process.exit(1);
    }
    const [owner, name] = repo.split("/");
    if (!owner || !name || repo.split("/").length !== 2) {
      console.error(`Invalid --repo value: ${repo}`);
      process.exit(1);
    }

    async function ghJson(
      path: string,
      options: { allowNotFound?: boolean } = {},
    ): Promise<unknown | null> {
      const proc = Bun.spawn(["gh", "api", path], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        const detail = stderr.trim() || `exit ${exitCode}`;
        const notFound =
          /\b404\b/i.test(detail) ||
          /\bNot Found\b/i.test(detail) ||
          /\bHTTP\s+404\b/i.test(detail);
        if (options.allowNotFound && notFound) {
          return null;
        }
        console.error(`gh api ${path} failed: ${detail}`);
        process.exit(1);
      }
      try {
        return JSON.parse(stdout) as unknown;
      } catch {
        console.error(`gh api ${path} returned non-JSON`);
        process.exit(1);
      }
    }

    const body = await Bun.file(inputPath).text();
    const rewritten = await rewriteTakeoverCredits(
      body,
      async (prNumber) => {
        const data = await ghJson(`repos/${owner}/${name}/pulls/${prNumber}`, {
          allowNotFound: true,
        });
        if (data === null) return null;
        if (!data || typeof data !== "object") {
          console.error(`Landing PR #${prNumber} lookup returned no object`);
          process.exit(1);
        }
        const pr = data as { title?: unknown; body?: unknown; user?: { login?: unknown } };
        if (typeof pr.title !== "string" || typeof pr.user?.login !== "string") {
          console.error(`Landing PR #${prNumber} is missing title or author login`);
          process.exit(1);
        }
        return {
          title: pr.title,
          body: typeof pr.body === "string" ? pr.body : "",
          authorLogin: pr.user.login,
        };
      },
      async (sourcePrNumber) => {
        // Missing landing/source PRs leave the line unchanged; other lookup failures abort.
        const data = await ghJson(`repos/${owner}/${name}/pulls/${sourcePrNumber}`, {
          allowNotFound: true,
        });
        if (data === null) return null;
        if (typeof data !== "object") {
          console.error(`Source PR #${sourcePrNumber} lookup returned no object`);
          process.exit(1);
        }
        const pr = data as { user?: { login?: unknown } };
        if (typeof pr.user?.login !== "string") {
          console.error(`Source PR #${sourcePrNumber} is missing author login`);
          process.exit(1);
        }
        return pr.user.login;
      },
    );
    await Bun.write(outPath, rewritten.endsWith("\n") ? rewritten : rewritten + "\n");
    return;
  }

  if (cmd === "render") {
    const args = parseFlagArgs(rest);
    const npmMetadata = args.get("npm-metadata");
    const out = args.get("out");
    if (!npmMetadata || !out) {
      console.error("Usage: bun scripts/release-notes.ts render --npm-metadata <text> --out <file> [--carried <file>] [--delta <file>] [--compare-from <tag>] [--compare-to <tag>] [--repository <owner/name>]");
      process.exit(1);
    }
    const readOptional = async (name: string): Promise<string> => {
      const path = args.get(name);
      if (!path) return "";
      return await Bun.file(path).text();
    };

    const notes = renderReleaseNotes({
      npmMetadata,
      carriedPreviewNotes: await readOptional("carried"),
      deltaPrNotes: await readOptional("delta"),
      compareFrom: args.get("compare-from") ?? null,
      compareTo: args.get("compare-to"),
      repository: args.get("repository"),
    });
    await Bun.write(out, notes);
    return;
  }

  if (cmd === "polish") {
    const args = parseFlagArgs(rest);
    const inputPath = args.get("in");
    const outPath = args.get("out");
    if (!inputPath || !outPath) {
      console.error("Usage: bun scripts/release-notes.ts polish --in <file> --out <file> [--model <model>] [--base-url <url>] [--api-key <key>]");
      process.exit(1);
    }
    const apiKey = args.get("api-key") ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("✗ polish needs an OpenAI-compatible API key: set OPENAI_API_KEY or pass --api-key");
      process.exit(1);
    }
    const baseUrl = (args.get("base-url") ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const model = args.get("model") ?? process.env.OPENAI_MODEL ?? "gpt-5.4";

    const body = await Bun.file(inputPath).text();
    const { head, changelog } = splitPolishInput(body);
    const expectedPrs = extractPrNumbers(changelog);
    const expectedHeadings = parseSectionHeadings(head);
    if (expectedPrs.length === 0) {
      console.error("✗ polish input Changelog contains no PR references");
      process.exit(1);
    }

    const rewritten = await callChatCompletion(apiKey, baseUrl, model, head);
    const errors = validatePolishedSections(rewritten, expectedPrs, expectedHeadings);
    if (errors.length > 0) {
      console.error("✗ polished notes failed validation:");
      for (const error of errors) console.error(`  - ${error}`);
      process.exit(1);
    }
    const out = `${rewritten.trimEnd()}\n\n${changelog}`;
    await Bun.write(outPath, out.endsWith("\n") ? out : out + "\n");
    return;
  }

  console.error(`Unknown command: ${cmd ?? "(none)"}
Usage:
  bun scripts/release-notes.ts strip-carried [body-file]
  bun scripts/release-notes.ts has-meaningful [body-file]
  bun scripts/release-notes.ts join-carried --out <file> <part-file>...
  bun scripts/release-notes.ts matching-preview-tag <version>   # tags on stdin
  bun scripts/release-notes.ts matching-preview-tags <version>  # tags on stdin, oldest→newest
  bun scripts/release-notes.ts previous-release-tag <version>   # tags on stdin
  bun scripts/release-notes.ts credit-takeovers --repo <owner/name> --in <file> --out <file>
  bun scripts/release-notes.ts render --npm-metadata ... --out ... [--carried ...] [--delta ...] [--compare-from ...] [--compare-to ...] [--repository ...]
  bun scripts/release-notes.ts polish --in <file> --out <file> [--model ...] [--base-url ...] [--api-key ...]`);
  process.exit(1);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
