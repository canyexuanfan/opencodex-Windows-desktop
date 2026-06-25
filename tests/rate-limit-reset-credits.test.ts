import { describe, it, expect } from "bun:test";
import {
  parseUsageQuota,
  updateAccountQuota,
  getAccountQuota,
  clearAccountQuota,
  type WhamUsageResponse,
} from "../src/codex-quota";

describe("rate-limit reset credits", () => {
  describe("parseUsageQuota", () => {
    it("extracts resetCredits from response", () => {
      const data: WhamUsageResponse = {
        rate_limit: {
          primary_window: { used_percent: 50, reset_at: 1700000000 },
          secondary_window: { used_percent: 20, reset_at: 1700100000 },
        },
        rate_limit_reset_credits: { available_count: 2 },
      };
      const quota = parseUsageQuota(data);
      expect(quota).not.toBeNull();
      expect(quota!.resetCredits).toBe(2);
      expect(quota!.fiveHourPercent).toBe(50);
    });

    it("returns undefined resetCredits when field is absent", () => {
      const data: WhamUsageResponse = {
        rate_limit: {
          primary_window: { used_percent: 30, reset_at: 1700000000 },
        },
      };
      const quota = parseUsageQuota(data);
      expect(quota).not.toBeNull();
      expect(quota!.resetCredits).toBeUndefined();
    });

    it("handles credits-only response (no rate_limit)", () => {
      const data: WhamUsageResponse = {
        rate_limit_reset_credits: { available_count: 1 },
      };
      const quota = parseUsageQuota(data);
      expect(quota).not.toBeNull();
      expect(quota!.resetCredits).toBe(1);
      expect(quota!.weeklyPercent).toBeUndefined();
    });

    it("returns null when neither rate_limit nor credits exist", () => {
      const data: WhamUsageResponse = {};
      expect(parseUsageQuota(data)).toBeNull();
    });

    it("handles null rate_limit_reset_credits", () => {
      const data: WhamUsageResponse = {
        rate_limit: {
          primary_window: { used_percent: 10 },
        },
        rate_limit_reset_credits: null,
      };
      const quota = parseUsageQuota(data);
      expect(quota).not.toBeNull();
      expect(quota!.resetCredits).toBeUndefined();
    });

    it("handles zero available_count", () => {
      const data: WhamUsageResponse = {
        rate_limit: {
          primary_window: { used_percent: 80, reset_at: 1700000000 },
        },
        rate_limit_reset_credits: { available_count: 0 },
      };
      const quota = parseUsageQuota(data);
      expect(quota).not.toBeNull();
      expect(quota!.resetCredits).toBe(0);
    });
  });

  describe("updateAccountQuota resetCredits", () => {
    it("stores resetCredits when provided", () => {
      clearAccountQuota();
      updateAccountQuota("test-1", 50, 30, undefined, undefined, undefined, undefined, 3);
      const q = getAccountQuota("test-1");
      expect(q).not.toBeNull();
      expect(q!.resetCredits).toBe(3);
    });

    it("preserves resetCredits when not provided in subsequent update", () => {
      clearAccountQuota();
      updateAccountQuota("test-2", 50, 30, undefined, undefined, undefined, undefined, 2);
      updateAccountQuota("test-2", 60, 40);
      const q = getAccountQuota("test-2");
      expect(q).not.toBeNull();
      expect(q!.resetCredits).toBe(2);
      expect(q!.weeklyPercent).toBe(60);
    });

    it("overwrites resetCredits when explicitly provided", () => {
      clearAccountQuota();
      updateAccountQuota("test-3", 50, 30, undefined, undefined, undefined, undefined, 5);
      updateAccountQuota("test-3", 50, 30, undefined, undefined, undefined, undefined, 1);
      const q = getAccountQuota("test-3");
      expect(q!.resetCredits).toBe(1);
    });
  });
});
