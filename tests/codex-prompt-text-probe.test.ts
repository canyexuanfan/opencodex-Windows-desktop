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
    // Codex wraps the body in <INSTRUCTIONS>; the fixture matches live output.
    const raw = message("<skills_instructions>S</skills_instructions># AGENTS.md instructions for /home/u/.codex\n\n<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS>");
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

  test("AGENTS.md is bounded by its own INSTRUCTIONS wrapper", () => {
    // Capturing to end-of-message swept up whatever untagged prose followed. The
    // body is delimited, so the delimiter is the boundary.
    const raw = message(
      "</recommended_plugins># AGENTS.md instructions for /home/u/.codex\n\n<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS><environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>",
    );
    const sections = extractSectionsForTests(raw);
    expect(sections.get("__agents_md")).toBe("Be brief.");
    // The section that follows is its own entry, not swallowed into the doc.
    expect(sections.get("environment_context")).toContain("<cwd>/tmp</cwd>");
  });

  test("XML-like prose a user wrote inside AGENTS.md survives", () => {
    // Stripping tag-shaped blocks before extraction deleted the user's own text.
    const raw = message(
      "# AGENTS.md instructions for /home/u/.codex\n\n<INSTRUCTIONS>\nUse <angle> brackets freely.\n</INSTRUCTIONS>",
    );
    expect(extractSectionsForTests(raw).get("__agents_md")).toBe("Use <angle> brackets freely.");
  });

  test("a tag-shaped fragment inside prose does not become its own section", () => {
    const raw = message("# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>\nPrefer <div> over <span>.\n</INSTRUCTIONS>");
    const sections = extractSectionsForTests(raw);
    expect(sections.has("div")).toBe(false);
    expect(sections.get("__agents_md")).toContain("<div>");
  });
});
