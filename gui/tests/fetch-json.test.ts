import { expect, test } from "bun:test";
import { readJsonIfOk, readJsonOrThrow } from "../src/fetch-json";

test("readJsonIfOk returns null for non-OK responses", async () => {
  const res = new Response("nope", { status: 500 });
  expect(await readJsonIfOk(res)).toBeNull();
});

test("readJsonIfOk returns null for malformed OK JSON (does not throw)", async () => {
  const res = new Response("{not-json", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  expect(await readJsonIfOk(res)).toBeNull();
});

test("readJsonIfOk returns undefined for empty OK bodies", async () => {
  const res = new Response("", { status: 200 });
  expect(await readJsonIfOk(res)).toBeUndefined();
});

test("readJsonOrThrow surfaces server error messages", async () => {
  const res = Response.json({ error: "locked" }, { status: 503 });
  await expect(readJsonOrThrow(res, "fallback")).rejects.toThrow("locked");
});
