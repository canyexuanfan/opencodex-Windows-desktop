/**
 * Models workspace tabs — routing contract.
 *
 * Phase 1 is additive: `#combos` and `#routing` are still first-class pages here, and
 * the nested hashes exist alongside them. The cutover assertions arrive with wp02b.
 */
import { expect, test, describe } from "bun:test";
import {
  MODELS_TAB_HASHES,
  hashBelongsToPage,
  readPageFromHash,
  resolveAppHashChange,
} from "../gui/src/app-routing";
import {
  MODELS_TABS,
  modelsPanelDomId,
  modelsTabDomId,
  modelsTabHash,
  readModelsTab,
  type ModelsTab,
} from "../gui/src/pages/models-tab";

describe("nested Models hashes", () => {
  test("both tab hashes are registered and belong to the models page", () => {
    expect([...MODELS_TAB_HASHES]).toEqual(["models/combos", "models/routing"]);
    for (const hash of MODELS_TAB_HASHES) {
      expect(hashBelongsToPage(hash, "models")).toBe(true);
      // The first segment already answers the page; the suffix only picks the tab.
      expect(readPageFromHash(hash)).toBe("models");
    }
  });

  test("the bare page hash still belongs to models", () => {
    expect(hashBelongsToPage("models", "models")).toBe(true);
    expect(resolveAppHashChange("models").replaceTo).toBeNull();
  });

  test("an unregistered sub-hash is normalised away instead of rendering a blank tab", () => {
    expect(hashBelongsToPage("models/nope", "models")).toBe(false);
    expect(resolveAppHashChange("models/nope")).toEqual({ page: "models", replaceTo: "models" });
  });

  test("a registered tab hash survives resolution untouched", () => {
    for (const hash of MODELS_TAB_HASHES) {
      expect(resolveAppHashChange(hash)).toEqual({ page: "models", replaceTo: null });
    }
  });
});

describe("readModelsTab", () => {
  test("maps every nested hash to its tab", () => {
    expect(readModelsTab("#models")).toBe("catalog");
    expect(readModelsTab("#models/combos")).toBe("combos");
    expect(readModelsTab("#models/routing")).toBe("routing");
  });

  test("accepts the bare and slash-prefixed hash forms", () => {
    expect(readModelsTab("models/combos")).toBe("combos");
    expect(readModelsTab("#/models/routing")).toBe("routing");
  });

  /*
   * The redirect that rewrites `#combos` uses replaceState and emits no `hashchange`,
   * so tab state is read from the ORIGINAL hash. Recognising only the nested form
   * would land a cold load on the catalog with the URL claiming Combos.
   */
  test("resolves legacy top-level hashes so a cold load lands on the right tab", () => {
    expect(readModelsTab("#combos")).toBe("combos");
    expect(readModelsTab("#routing")).toBe("routing");
    expect(readModelsTab("#combos/anything")).toBe("combos");
    expect(readModelsTab("#routing/anything")).toBe("routing");
  });

  test("anything unrecognised falls back to the catalog", () => {
    expect(readModelsTab("#dashboard")).toBe("catalog");
    expect(readModelsTab("#")).toBe("catalog");
    expect(readModelsTab("")).toBe("catalog");
  });

  /*
   * The legacy arms match on a `/` delimiter, not a bare prefix. Without these a
   * later "simplification" to `startsWith("routing")` would hijack any future page
   * whose id merely begins with one of these words.
   */
  test("legacy matching is delimiter-aware, not prefix-aware", () => {
    expect(readModelsTab("#combosomething")).toBe("catalog");
    expect(readModelsTab("#routings")).toBe("catalog");
    expect(readModelsTab("#routingthing")).toBe("catalog");
    expect(readModelsTab("#combos-legacy")).toBe("catalog");
  });

  /*
   * `models/combos/extra` is not a registered hash: the resolver normalises it away,
   * so the tab reader must agree rather than treating it as the Combos tab.
   */
  test("a deeper nested hash is not mistaken for a tab", () => {
    expect(readModelsTab("#models/combos/extra")).toBe("catalog");
    expect(readModelsTab("#models/routing/extra")).toBe("catalog");
  });
});

describe("modelsTabHash", () => {
  test("round-trips every tab", () => {
    for (const tab of MODELS_TABS) {
      expect(readModelsTab(`#${modelsTabHash(tab)}`)).toBe(tab);
    }
  });

  test("the catalog owns the bare page hash", () => {
    expect(modelsTabHash("catalog")).toBe("models");
    expect(modelsTabHash("combos")).toBe("models/combos");
    expect(modelsTabHash("routing")).toBe("models/routing");
  });

  test("every non-catalog hash is registered for normalization", () => {
    const nested = MODELS_TABS.filter((tab): tab is Exclude<ModelsTab, "catalog"> => tab !== "catalog");
    expect(nested.map(modelsTabHash).sort()).toEqual([...MODELS_TAB_HASHES].sort());
  });
});

test("tab and panel dom ids are distinct per tab, so aria-controls cannot collide", () => {
  const ids = MODELS_TABS.flatMap(tab => [modelsTabDomId(tab), modelsPanelDomId(tab)]);
  expect(new Set(ids).size).toBe(ids.length);
  // Pin the exact shape: the rendered aria-controls/aria-labelledby pair is asserted
  // against these ids once the strip exists, so a silent rename would desync them.
  expect(modelsTabDomId("combos")).toBe("models-tab-combos");
  expect(modelsPanelDomId("combos")).toBe("models-panel-combos");
});

test("an unregistered deep hash normalises to the bare page, matching readModelsTab", () => {
  for (const stray of ["models/combos/extra", "models/routing/extra"]) {
    expect(hashBelongsToPage(stray, "models")).toBe(false);
    expect(resolveAppHashChange(stray)).toEqual({ page: "models", replaceTo: "models" });
    expect(readModelsTab(`#${stray}`)).toBe("catalog");
  }
});
