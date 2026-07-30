import { describe, expect, test } from "bun:test";
import { ensureStrictCatalogFields } from "../src/codex/catalog/parsing";
import { catalogHintsFromModelsApiItem } from "../src/codex/catalog/provider-fetch";

/**
 * Codex parses `input_modalities` as a closed enum of text | image | audio. A single out-of-enum
 * value makes its config loader reject the WHOLE catalog file, and because that file is referenced
 * from config, the failure cascades: plugins, apps and MCP servers all stop loading.
 *
 * This actually happened — zenmux advertises "video" on meta-muse-spark-1.1, which we wrote through
 * verbatim and the Codex app reported `unknown variant 'video'` while showing zero apps.
 */
describe("catalog input_modalities stay inside the enum Codex accepts", () => {
  test("an out-of-enum modality is dropped rather than written through", () => {
    const entry = ensureStrictCatalogFields(
      { slug: "zenmux/meta-muse-spark-1.1", input_modalities: ["text", "image", "audio", "video"] },
      {},
    );
    expect(entry.input_modalities).toEqual(["text", "image", "audio"]);
  });

  test("an entry left with nothing acceptable falls back to text, never an empty list", () => {
    // A modality-less entry would be worse than a text-only one: Codex would have no way to know
    // the model takes prompts at all.
    const entry = ensureStrictCatalogFields({ slug: "p/only-video", input_modalities: ["video"] }, {});
    expect(entry.input_modalities).toEqual(["text"]);
  });

  test("accepted modalities survive untouched", () => {
    const entry = ensureStrictCatalogFields({ slug: "p/vision", input_modalities: ["text", "image"] }, {});
    expect(entry.input_modalities).toEqual(["text", "image"]);
  });

  test("preserveExactInputModalities still cannot smuggle a rejected value through", () => {
    // That option exists to stop us inventing a default, not to bypass the enum.
    const entry = ensureStrictCatalogFields(
      { slug: "p/exact", input_modalities: ["text", "video"] },
      { preserveExactInputModalities: true },
    );
    expect(entry.input_modalities).toEqual(["text"]);
  });

  test("provider metadata is filtered at the source as well", () => {
    const hints = catalogHintsFromModelsApiItem("zenmux", {
      id: "meta-muse-spark-1.1",
      input_modalities: ["text", "image", "audio", "video"],
    } as Parameters<typeof catalogHintsFromModelsApiItem>[1]);
    expect(hints.inputModalities).toEqual(["text", "image", "audio"]);
  });
});
