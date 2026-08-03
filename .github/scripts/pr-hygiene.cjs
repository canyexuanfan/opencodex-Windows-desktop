"use strict";

const GENERATED_PREFIXES = [
  "gui/dist/",
  "dist/",
  "coverage/",
  ".next/",
  "node_modules/",
];
const BEHAVIOR_PREFIXES = ["src/", "gui/src/"];
const TEST_PREFIXES = ["tests/"];
const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec)\.[^.]+)$/;
const SUPPRESSION_PATTERN = /(?:@ts-ignore|@ts-nocheck|eslint-disable|biome-ignore|prettier-ignore)/;
const FOCUSED_TEST_PATTERN = /\b(?:describe|it|test)\.(?:only|skip)\s*\(/;

function addedLines(patch) {
  if (typeof patch !== "string") return [];
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

function isGeneratedPath(path) {
  return GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isBehaviorPath(path) {
  return BEHAVIOR_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isTestPath(path) {
  return TEST_PREFIXES.some((prefix) => path.startsWith(prefix)) || TEST_FILE_PATTERN.test(path);
}

function hasEmptyCatch(lines) {
  const text = lines.join("\n");
  return /catch\s*(?:\([^)]*\))?\s*\{\s*\}/m.test(text);
}

function assessHygiene({ files = [], labels = [] }) {
  const labelSet = new Set(labels);
  const failures = [];
  const filenames = files.map((file) => file.filename);
  // Renames are classified on both sides: moving a behavior or generated file
  // to a documentation path must not bypass the hygiene gates.
  const previousFilenames = files.flatMap((file) =>
    file.previous_filename ? [file.previous_filename] : [],
  );
  const allPaths = [...new Set([...filenames, ...previousFilenames])];
  const behaviorChanged = allPaths.some(isBehaviorPath);
  const testsChanged = allPaths.some(isTestPath);

  if (
    behaviorChanged &&
    !testsChanged &&
    !labelSet.has("test-exception-approved")
  ) {
    failures.push({ code: "missing_regression_test" });
  }

  const generated = allPaths.filter(isGeneratedPath);
  if (
    generated.length > 0 &&
    !labelSet.has("generated-change-approved")
  ) {
    failures.push({ code: "generated_output", paths: generated });
  }

  if (
    filenames.includes("bun.lock") &&
    !filenames.includes("package.json") &&
    !labelSet.has("dependency-change-approved")
  ) {
    failures.push({ code: "orphan_lockfile" });
  }

  const suppressions = [];
  const focusedTests = [];
  const emptyCatches = [];
  for (const file of files) {
    const lines = addedLines(file.patch);
    if (lines.some((line) => SUPPRESSION_PATTERN.test(line))) {
      suppressions.push(file.filename);
    }
    if (lines.some((line) => FOCUSED_TEST_PATTERN.test(line))) {
      focusedTests.push(file.filename);
    }
    if (hasEmptyCatch(lines)) emptyCatches.push(file.filename);
  }

  if (
    suppressions.length > 0 &&
    !labelSet.has("suppression-approved")
  ) {
    failures.push({ code: "new_suppression", paths: suppressions });
  }
  if (
    focusedTests.length > 0 &&
    !labelSet.has("test-exception-approved")
  ) {
    failures.push({ code: "focused_or_skipped_test", paths: focusedTests });
  }
  if (emptyCatches.length > 0) {
    failures.push({ code: "empty_catch", paths: emptyCatches });
  }

  return failures;
}

module.exports = {
  addedLines,
  assessHygiene,
  hasEmptyCatch,
  isBehaviorPath,
  isGeneratedPath,
  isTestPath,
};
