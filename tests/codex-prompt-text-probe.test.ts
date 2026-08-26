/**
 * The prompt-text probe: what it reads, and what it refuses to guess.
 *
 * These are unit tests over the pure extraction and classification logic. The
 * spawn itself is exercised by the route test and by hand; what matters here is
 * that a missing body is attributed to the right cause, because the dialog shows
 * that attribution to a user as an explanation.
 */
import { describe, expect, test } from "bun:test";
import { extractSectionsForTests } from "../src/codex/prompt-text-probe";

function message(text: string): string {
  return JSON.stringify([{ type: "message", role: "developer", content: [{ type: "input_text", text }] }]);
}

describe("section extraction", () => {
  test("a tag name containing a space is still matched", () => {
    // Codex renders `<permissions instructions>`, with a space. A [a-z_]+ pattern
    // skipped it silently and the layer was reported as having sent nothing.
    const sections = extractSectionsForTests(message("<permissions instructions>Sandbox rules.</permissions instructions>"));
    expect(sections.get("permissions instructions")).toBe("Sandbox rules.");
  });

  test("AGENTS.md is found even though it carries no tag of its own", () => {
    const raw = message("<skills_instructions>S</skills_instructions>\n# AGENTS.md instructions for /home/u/.codex\n\nBe brief.");
    const sections = extractSectionsForTests(raw);
    expect(sections.get("skills_instructions")).toBe("S");
    expect(sections.get("__agents_md")).toContain("Be brief.");
  });

  test("malformed JSON yields no sections rather than inventing them", () => {
    // The caller turns an empty map into a failed read. Returning a populated
    // map here would have told the user fifteen layers each chose to send nothing.
    expect(extractSectionsForTests("{not json").size).toBe(0);
    expect(extractSectionsForTests("[]").size).toBe(0);
  });

  test("a section spanning multiple lines keeps its body", () => {
    const sections = extractSectionsForTests(message("<apps_instructions>line one\nline two</apps_instructions>"));
    expect(sections.get("apps_instructions")).toBe("line one\nline two");
  });
});

