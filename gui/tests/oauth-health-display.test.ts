import { describe, expect, test } from "bun:test";
import {
  oauthHealthBadgeClass,
  oauthHealthBadgeTone,
  oauthHealthIsCooldown,
  oauthHealthShowsDoctor,
  oauthHealthShowsReauth,
} from "../src/oauth-health-display";
import { displayAccountId, maskAccountId } from "../src/lib/privacy";

describe("oauth health badge helpers", () => {
  test("maps statuses to badge tones and classes", () => {
    expect(oauthHealthBadgeTone("healthy")).toBe("ok");
    expect(oauthHealthBadgeTone("cooldown")).toBe("muted");
    expect(oauthHealthBadgeTone("reauth_required")).toBe("warn");
    expect(oauthHealthBadgeTone("warning")).toBe("warn");
    expect(oauthHealthBadgeClass("healthy")).toBe("badge badge-green");
    expect(oauthHealthBadgeClass("reauth_required")).toBe("badge badge-amber");
    expect(oauthHealthBadgeClass("cooldown")).toBe("badge badge-muted");
  });

  test("action gates: reauth and doctor, not during cooldown probe", () => {
    expect(oauthHealthShowsReauth("reauth_required")).toBe(true);
    expect(oauthHealthShowsReauth("cooldown")).toBe(false);
    expect(oauthHealthShowsDoctor("warning")).toBe(true);
    expect(oauthHealthShowsDoctor("reauth_required")).toBe(true);
    expect(oauthHealthShowsDoctor("cooldown")).toBe(false);
    expect(oauthHealthIsCooldown("cooldown")).toBe(true);
    expect(oauthHealthIsCooldown("healthy")).toBe(false);
  });

  test("maskAccountId never returns the full raw id for long values", () => {
    const raw = "aaaa1111bbbb2222";
    const masked = maskAccountId(raw);
    expect(masked).toBe("account-…2222");
    expect(masked).not.toBe(raw);
    expect(masked!.includes(raw)).toBe(false);
  });

  test("displayAccountId never falls back to the raw id", () => {
    const raw = "acct_raw_should_not_leak";
    expect(displayAccountId(raw)).toBe("account-…leak");
    expect(displayAccountId(raw)).not.toBe(raw);
    expect(displayAccountId(null)).toBe("account-…");
    expect(displayAccountId("")).toBe("account-…");
    expect(displayAccountId("   ")).toBe("account-…");
  });
});
