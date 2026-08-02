"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { addedLines, assessHygiene, hasEmptyCatch } = require("./pr-hygiene.cjs");

describe("patch parsing", () => {
  it("returns added content without diff headers", () => {
    assert.deepEqual(addedLines("+++ b/a.ts\n+const x = 1;\n-old"), ["const x = 1;"]);
  });

  it("detects empty catch blocks across added lines", () => {
    assert.equal(hasEmptyCatch(["try { work(); } catch (error) {", "}"]), true);
    assert.equal(hasEmptyCatch(["catch (error) {", "report(error);", "}"]), false);
  });
});

describe("assessHygiene", () => {
  it("requires regression coverage for behavior changes", () => {
    const failures = assessHygiene({ files: [{ filename: "src/router.ts", patch: "+change" }] });
    assert.equal(failures[0].code, "missing_regression_test");
  });

  it("accepts behavior changes with tests or approved exception", () => {
    assert.deepEqual(assessHygiene({ files: [
      { filename: "src/router.ts", patch: "+change" },
      { filename: "tests/router.test.ts", patch: "+test" },
    ] }), []);
    assert.deepEqual(assessHygiene({
      files: [{ filename: "src/router.ts", patch: "+change" }],
      labels: ["test-exception-approved"],
    }), []);
  });

  it("blocks added suppressions", () => {
    const failures = assessHygiene({ files: [
      { filename: "tests/a.test.ts", patch: "+// @ts-ignore\n+value();" },
    ] });
    assert.equal(failures[0].code, "new_suppression");
  });

  it("blocks focused or skipped tests", () => {
    const failures = assessHygiene({ files: [
      { filename: "tests/a.test.ts", patch: "+test.only(\"x\", () => {});" },
    ] });
    assert.equal(failures[0].code, "focused_or_skipped_test");
  });

  it("blocks empty catches", () => {
    const failures = assessHygiene({ files: [
      { filename: "tests/a.test.ts", patch: "+try {} catch (error) {}" },
    ] });
    assert.equal(failures[0].code, "empty_catch");
  });

  it("blocks generated output and orphan lockfile churn", () => {
    const failures = assessHygiene({ files: [
      { filename: "gui/dist/index.js", patch: "+built" },
      { filename: "bun.lock", patch: "+package" },
    ] });
    assert.deepEqual(failures.map((failure) => failure.code), ["generated_output", "orphan_lockfile"]);
  });

  it("allows maintainer-approved narrow exceptions", () => {
    const failures = assessHygiene({
      files: [
        { filename: "src/router.ts", patch: "+// eslint-disable-next-line\n+run();" },
        { filename: "gui/dist/index.js", patch: "+built" },
        { filename: "bun.lock", patch: "+package" },
      ],
      labels: [
        "test-exception-approved",
        "suppression-approved",
        "generated-change-approved",
        "dependency-change-approved",
      ],
    });
    assert.deepEqual(failures, []);
  });
});
