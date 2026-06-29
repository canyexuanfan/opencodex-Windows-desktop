import { describe, expect, test } from "bun:test";
import { normalizeArgKeys } from "../src/adapters/cursor/arg-normalize";

const schema = {
  type: "object",
  properties: {
    path: { type: "string" },
    command: { type: "string" },
    old_string: { type: "string" },
    new_string: { type: "string" },
  },
};

describe("normalizeArgKeys", () => {
  test("renames a known alias to the schema-declared canonical key", () => {
    expect(normalizeArgKeys({ filepath: "a.txt" }, schema)).toEqual({ path: "a.txt" });
    expect(normalizeArgKeys({ cmd: "ls -la" }, schema)).toEqual({ command: "ls -la" });
    expect(normalizeArgKeys({ oldstring: "x", newstring: "y" }, schema)).toEqual({ old_string: "x", new_string: "y" });
  });

  test("leaves keys already matching the schema untouched", () => {
    const args = { path: "a.txt", command: "ls" };
    expect(normalizeArgKeys(args, schema)).toBe(args);
  });

  test("does not rename when the canonical key is not in the schema", () => {
    // `cmd`->`command` but this schema has no `command` property.
    const narrow = { type: "object", properties: { path: { type: "string" } } };
    expect(normalizeArgKeys({ cmd: "ls" }, narrow)).toEqual({ cmd: "ls" });
  });

  test("does not clobber an existing canonical key", () => {
    // Both `path` (canonical) and `filepath` (alias) present -> keep canonical, keep alias as-is.
    const result = normalizeArgKeys({ path: "real.txt", filepath: "alias.txt" }, schema);
    expect(result.path).toBe("real.txt");
    expect(result.filepath).toBe("alias.txt");
  });

  test("returns args unchanged when schema has no properties", () => {
    const args = { filepath: "a.txt" };
    expect(normalizeArgKeys(args, undefined)).toBe(args);
    expect(normalizeArgKeys(args, { type: "object" })).toBe(args);
  });

  test("is case-insensitive on the alias key", () => {
    expect(normalizeArgKeys({ FilePath: "a.txt" }, schema)).toEqual({ path: "a.txt" });
  });
});
