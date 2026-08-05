import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashBelongsToPage, readPageFromHash, resolveAppHashChange, VALID_PAGES } from "../gui/src/app-routing";

const guiRoot = join(import.meta.dir, "..", "gui", "src");

test("routing is a first-class dashboard page with a registered hash", () => {
  expect(VALID_PAGES.has("routing")).toBe(true);
  expect(readPageFromHash("routing")).toBe("routing");
  expect(hashBelongsToPage("routing", "routing")).toBe(true);
  expect(resolveAppHashChange("routing").replaceTo).toBeNull();
});

test("Routing page wires profiles, dry-run, and analytics against management APIs", () => {
  const page = readFileSync(join(guiRoot, "pages", "RoutingProfiles.tsx"), "utf8");
  expect(page).toContain("/api/routing-profiles");
  expect(page).toContain("/api/routing-analytics");
  expect(page).toContain("/api/routing-profiles/dry-run");
  expect(page).toContain("if (!response.ok)");
  expect(page).toContain('data-page="routing"');
});

test("Logs detail renders a route-decision section with an honest empty state", () => {
  const page = readFileSync(join(guiRoot, "pages", "Logs.tsx"), "utf8");
  expect(page).toContain("routeDecision");
  expect(page).toContain('logs.detail.route.section');
  expect(page).toContain('logs.detail.route.unknown');
  expect(page).toContain("log-detail-route");
});

test("App mounts RoutingProfiles from the sidebar NAV entry", () => {
  const app = readFileSync(join(guiRoot, "App.tsx"), "utf8");
  expect(app).toContain('id: "routing"');
  expect(app).toContain("RoutingProfiles");
  expect(app).toContain('page === "routing"');
  expect(app).toContain("IconRoute");
});
