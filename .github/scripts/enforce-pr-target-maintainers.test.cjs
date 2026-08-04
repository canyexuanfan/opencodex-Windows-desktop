"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseMaintainerLogins
} = require("./enforce-pr-target-maintainers.cjs");

const FIXTURE = [
  "## Current maintainers",
  "",
  "| GitHub account | Project role | Responsibilities |",
  "| --- | --- | --- |",
  "| [@lidge-jun](https://github.com/lidge-jun) | Project owner | x |",
  "| [@Ingwannu](https://github.com/Ingwannu) | Maintainer | x |",
  "| [@Wibias](https://github.com/Wibias) | Maintainer | x |",
  "",
  "## Change log",
  "",
  "- [@Wibias](https://github.com/Wibias) was added as a maintainer.",
  "- [@retired](https://github.com/retired) stepped down.",
].join("\n");

describe("parseMaintainerLogins", () => {
  it("reads the current-maintainers table and excludes the change log", () => {
    assert.deepEqual(parseMaintainerLogins(FIXTURE), [
      "lidge-jun",
      "Ingwannu",
      "Wibias",
    ]);
  });

  it("returns the whole text when the section heading is missing", () => {
    const text = "- [@only](https://github.com/only) is listed.";
    assert.deepEqual(parseMaintainerLogins(text), ["only"]);
  });

  it("handles empty and duplicate-free output", () => {
    assert.deepEqual(parseMaintainerLogins(""), []);
    assert.deepEqual(
      parseMaintainerLogins(
        [
          "## Current maintainers",
          "| [@dup](https://github.com/dup) | x |",
          "| [@dup](https://github.com/dup) | y |",
        ].join("\n"),
      ),
      ["dup"],
    );
  });
});
