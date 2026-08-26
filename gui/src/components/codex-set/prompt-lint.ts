import type { TKey } from "../../i18n/en";

/**
 * Compatibility linter for a custom prompt layer. Pure, no I/O.
 *
 * Every rule traces to devlog 002 section 6. Findings are WARNINGS and never
 * block a save: a user who deliberately wants to override Codex's identity may,
 * they just should not do it by accident.
 */
export type LintLevel = "warn" | "info";

export interface LintFinding {
  level: LintLevel;
  rule: string;
  messageKey: TKey;
  /** [start, end) into the body, for inline highlighting. */
  span?: [number, number];
}

/**
 * The 8 KB advisory is OPENCODEX POLICY, not an upstream limit.
 * `developer_instructions` is a plain config string with no cap, and an earlier
 * draft wrongly cited the 32 KiB AGENTS.md project-doc budget, which governs an
 * unrelated mechanism. The justification is per-request token cost and keeping a
 * hand-editable config file hand-editable - so it is info, never warn.
 */
const SIZE_ADVISORY_BYTES = 8 * 1024;

interface Rule {
  rule: string;
  level: LintLevel;
  messageKey: TKey;
  pattern: RegExp;
}

const RULES: readonly Rule[] = [
  {
    // Contradicts the base identity Codex already establishes.
    rule: "identity",
    level: "warn",
    messageKey: "codexSet.lint.identity",
    pattern: /you\s+are\s+(claude|grok|gemini|gpt-|chatgpt)/gi,
  },
  {
    // The tool registry defines the tools; prose cannot add or rename one.
    rule: "foreign-tool",
    level: "warn",
    messageKey: "codexSet.lint.foreignTool",
    pattern: /\b(Read|Edit|Write|Bash|Glob|Grep)\s+tool\b/g,
  },
  {
    // No template engine runs over instructions, so a placeholder ships literally.
    rule: "placeholder",
    level: "warn",
    messageKey: "codexSet.lint.placeholder",
    pattern: /\$\{\{[\s\S]*?\}\}/g,
  },
  {
    rule: "apply-patch",
    level: "warn",
    messageKey: "codexSet.lint.applyPatch",
    pattern: /apply_patch\s+(?:is|must|should|means|works)/gi,
  },
  {
    // Codex injects its own approval vocabulary; a second one contradicts it.
    rule: "approval-vocab",
    level: "warn",
    messageKey: "codexSet.lint.approvalVocab",
    pattern: /\b(always-approve|ask mode|acceptEdits)\b/gi,
  },
  {
    // Environment facts are generated later and will contradict a stated one.
    rule: "environment",
    level: "warn",
    messageKey: "codexSet.lint.environment",
    pattern: /\b(your (?:cwd|working directory) is|today's date is|you have no network access|you are running on (?:macos|linux|windows))/gi,
  },
];

function utf8Length(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export function lintPromptLayer(body: string): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const rule of RULES) {
    // Fresh regex per call: a shared /g literal carries lastIndex between calls,
    // which makes the SECOND lint of the same text miss its first match.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
      findings.push({
        level: rule.level,
        rule: rule.rule,
        messageKey: rule.messageKey,
        span: [match.index, match.index + match[0].length],
      });
      // A zero-length match would spin forever.
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  if (utf8Length(body) > SIZE_ADVISORY_BYTES) {
    findings.push({ level: "info", rule: "size", messageKey: "codexSet.lint.size" });
  }
  return findings.sort((a, b) => (a.span?.[0] ?? Infinity) - (b.span?.[0] ?? Infinity));
}

