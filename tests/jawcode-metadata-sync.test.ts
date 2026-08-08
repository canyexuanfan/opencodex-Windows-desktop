import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `src/generated/jawcode-model-metadata.ts` is generated from the jawcode `models.json`, and until
 * now nothing checked that the committed file still matched its source. It drifted by 95 models —
 * 148 price fields, 36 context windows, 45 maxTokens, and 36 entirely new models — which meant a
 * routine regeneration would sweep all of that into cost accounting alongside whatever the author
 * actually intended to change.
 *
 * This guard closes that. It regenerates into a temp directory and byte-compares, so it can never
 * clobber the committed file.
 *
 * The generator's default source is the vendored snapshot `scripts/jawcode-models.json`, so this
 * guard runs everywhere — including CI, which previously skipped it for lack of a sibling jawcode
 * checkout. Refreshing the metadata is one deliberate commit: copy jawcode's current
 * packages/ai/src/models.json over the snapshot and rerun `bun run generate:jawcode-metadata`.
 * JAWCODE_MODELS_JSON still overrides the source to compare against a live jawcode checkout.
 */
const GENERATED = resolve(import.meta.dir, "../src/generated/jawcode-model-metadata.ts");
// Mirror the generator's default: the vendored snapshot next to the script, so the guard is
// deterministic in worktrees and CI. JAWCODE_MODELS_JSON opts into a live-checkout comparison.
const SOURCE = process.env.JAWCODE_MODELS_JSON
  ? resolve(process.env.JAWCODE_MODELS_JSON)
  : resolve(import.meta.dir, "../scripts/jawcode-models.json");

describe("generated jawcode metadata stays in sync with its source", () => {
  test.skipIf(!existsSync(SOURCE))(
    "regenerating reproduces the committed file byte for byte",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "jawcode-sync-"));
      const outPath = join(outDir, "jawcode-model-metadata.ts");

      const proc = Bun.spawn(
        ["bun", resolve(import.meta.dir, "../scripts/generate-jawcode-metadata.ts")],
        {
          cwd: resolve(import.meta.dir, ".."),
          env: { ...process.env, JAWCODE_MODELS_JSON: SOURCE, JAWCODE_METADATA_OUT: outPath },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const exitCode = await proc.exited;
      expect(exitCode, await new Response(proc.stderr).text()).toBe(0);

      expect(readFileSync(outPath, "utf-8")).toBe(readFileSync(GENERATED, "utf-8"));
    },
    30_000,
  );
});
