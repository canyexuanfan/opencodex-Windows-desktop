import { expect, test } from "bun:test";
import { isAllowedLoopbackUrl } from "../src/url-policy";

test("navigation allows only the active loopback origin", () => {
  expect(isAllowedLoopbackUrl("http://127.0.0.1:49152/", "http://127.0.0.1:49152")).toBe(true);
  expect(isAllowedLoopbackUrl("http://127.0.0.1:49153/", "http://127.0.0.1:49152")).toBe(false);
  expect(isAllowedLoopbackUrl("https://127.0.0.1:49152/", "http://127.0.0.1:49152")).toBe(false);
  expect(isAllowedLoopbackUrl("http://0.0.0.0:49152/", "http://0.0.0.0:49152")).toBe(false);
});
