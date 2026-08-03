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

function hasDeletions(patch) {
  if (typeof patch !== "string") return false;
  return patch
    .split("\n")
    .some((line) => line.startsWith("-") && !line.startsWith("---"));
}

// Lines that survive in the result of a hunk: additions plus context. Used for
// empty-catch detection when the hunk also deletes lines, so deleting a catch
// body cannot bypass the check.
function resultLines(patch) {
  if (typeof patch !== "string") return [];
  return patch
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        line.startsWith(" "),
    )
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

// A hunk whose surviving and removed lines are all comments or blank changed no
// behavior, so it cannot owe a regression test. This matters because the review
// standard here asks for dense explanatory comments in the source: a PR that
// only sharpens a comment about WHY something fails closed would otherwise be
// told to add a test for a change it did not make, and the only escape would be
// a maintainer label — which trains contributors to ask for the label instead of
// writing tests, weakening the gate everywhere it actually matters.
//
// Deliberately narrow: a single non-comment line anywhere in the file's patch
// makes the whole file count as behavior again. Block-comment CONTINUATION
// lines are recognized only in the common leading-asterisk form; anything more
// clever than that reads as code and keeps the requirement.
function isCommentOnlyChange(patch) {
  if (typeof patch !== "string") return false;
  const changed = patch
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    )
    .map((line) => line.slice(1).trim());
  if (changed.length === 0) return false;
  return changed.every(
    (line) =>
      line === "" ||
      line.startsWith("//") ||
      line.startsWith("/*") ||
      line.startsWith("*") ||
      line.startsWith("#"),
  );
}

function hasEmptyCatch(lines) {
  const text = lines.join("\n");
  return /catch\s*(?:\([^)]*\))?\s*\{\s*\}/m.test(text);
}

function assessHygiene({ files = [], labels = [] }) {
  const labelSet = new Set(labels);
  const failures = [];
  const filenames = files.map((file) => file.filename);
  const removedFilenames = new Set(
    files
      .filter((file) => file.status === "removed")
      .map((file) => file.filename),
  );
  // Renames are classified on both sides: moving a behavior or generated file
  // to a documentation path must not bypass the hygiene gates.
  const previousFilenames = files.flatMap((file) =>
    file.previous_filename ? [file.previous_filename] : [],
  );
  const allPaths = [...new Set([...filenames, ...previousFilenames])];
  // A file whose patch is entirely comments changed no behavior. Renamed-from
  // paths carry no patch of their own, so they are judged by the file that
  // carries them.
  const commentOnlyPaths = new Set(
    files
      .filter((file) => isCommentOnlyChange(file.patch))
      .flatMap((file) =>
        file.previous_filename
          ? [file.filename, file.previous_filename]
          : [file.filename],
      ),
  );
  const behaviorChanged = allPaths.some(
    (path) => isBehaviorPath(path) && !commentOnlyPaths.has(path),
  );
  // Deleted tests add no coverage and must not satisfy the regression gate.
  const testsChanged = allPaths.some(
    (path) => isTestPath(path) && !removedFilenames.has(path),
  );

  if (
    behaviorChanged &&
    !testsChanged &&
    !labelSet.has("test-exception-approved")
  ) {
    failures.push({ code: "missing_regression_test" });
  }

  const generated = allPaths.filter(
    (path) => isGeneratedPath(path) && !removedFilenames.has(path),
  );
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
    const catchLines = hasDeletions(file.patch) ? resultLines(file.patch) : lines;
    if (hasEmptyCatch(catchLines)) emptyCatches.push(file.filename);
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
  hasDeletions,
  isBehaviorPath,
  isGeneratedPath,
  isTestPath,
  resultLines,
};
