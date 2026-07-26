import { describe, expect, test } from "bun:test";
import { maskAccountId } from "../src/lib/privacy";

describe("maskAccountId", () => {
  test("redacts long account ids to account-…suffix", () => {
    expect(maskAccountId("acct_abcdefghijklmnopqrstuvwxyz")).toBe("account-…wxyz");
  });

  test("returns null for empty", () => {
    expect(maskAccountId(null)).toBeNull();
    expect(maskAccountId("")).toBeNull();
  });

  test("short ids still redact without leaking full value when length > 4", () => {
    expect(maskAccountId("abcdef")).toBe("account-…cdef");
  });
});
