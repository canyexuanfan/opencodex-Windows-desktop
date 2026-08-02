import { describe, expect, test } from "bun:test";
import { isDeferralCurrent } from "../src/cli/star-prompt";

const NOW = Date.parse("2026-08-02T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function record(daysAgo: number, version: string): string {
  return `${new Date(NOW - daysAgo * DAY).toISOString()} ${version}`;
}

describe("isDeferralCurrent", () => {
  test("no record or a malformed record never suppresses the relay", () => {
    expect(isDeferralCurrent(null, "2.10.0", NOW)).toBe(false);
    expect(isDeferralCurrent("garbage", "2.10.0", NOW)).toBe(false);
    expect(isDeferralCurrent("not-a-date 2.10.0", "2.10.0", NOW)).toBe(false);
  });

  test("a real version already asked on suppresses for that whole version", () => {
    expect(isDeferralCurrent(record(30, "2.10.0"), "2.10.0", NOW)).toBe(true);
  });

  test("a newer version within the week stays quiet, an older record re-asks", () => {
    expect(isDeferralCurrent(record(3, "2.9.1"), "2.10.0", NOW)).toBe(true);
    expect(isDeferralCurrent(record(8, "2.9.1"), "2.10.0", NOW)).toBe(false);
  });

  test("an unreadable version falls back to the weekly bound only", () => {
    // A "?" record must not stick forever via the same-version rule.
    expect(isDeferralCurrent(record(30, "?"), "?", NOW)).toBe(false);
    expect(isDeferralCurrent(record(3, "?"), "?", NOW)).toBe(true);
  });

  test("future-dated records fail toward re-asking", () => {
    const future = `${new Date(NOW + 30 * DAY).toISOString()} 2.9.1`;
    expect(isDeferralCurrent(future, "2.10.0", NOW)).toBe(false);
  });
});
