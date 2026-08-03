# WP2 — the client-dialect modality filter

Research: `004_export_modality_poisoning.md`. Read it first; this doc is the diff.

Independent of every other phase. It fixes a failure the user is hitting right
now, so it goes first despite not being a switch.

## IN / OUT

IN: `src/clients/config-export.ts` (MODIFY),
`tests/client-export-modality-enum.test.ts` (NEW).

OUT: `src/server/management/model-rows.ts`, `src/cli/export-command.ts`,
`src/codex/catalog/*`, `normalizeExportModels`. All four deliberately keep
carrying `audio` — the internal vocabulary is correct, only two destinations are
narrower.

## The helper

MODIFY `src/clients/config-export.ts`, immediately after `outputBudgetFor`
(currently line 432) so the two value-normalizing helpers sit together:

```ts
/**
 * Modalities a given client's schema will actually accept.
 *
 * Our internal vocabulary is `text | image | audio` (model-routes.ts
 * ALLOWED_INPUT_MODALITIES). Pi and Gajae both accept only `text | image`, and
 * both reject the WHOLE config file over one out-of-enum value — Gajae reports
 * `/providers/opencodex/models/N/input/2: Invalid option` and falls back to its
 * built-in list, Pi returns an empty model config. So a single `audio` model
 * takes every routed model down with it.
 *
 * This is the same defect the Codex catalog had with `video`, where the app
 * showed zero apps (tests/catalog-input-modality-enum.test.ts). The fix is the
 * same shape: filter to what the destination accepts, and fall back to `text`
 * rather than an empty list — a modality-less entry would leave the client
 * unable to tell the model takes prompts at all.
 *
 * Deliberately NOT applied in ExportModel construction: the management and CLI
 * boundaries carry catalog modalities verbatim on purpose, and stripping `audio`
 * globally would destroy valid metadata before the destination is known.
 */
const CLIENT_INPUT_MODALITIES: Record<"pi" | "gajae", ReadonlySet<string>> = {
  pi: new Set(["text", "image"]),
  gajae: new Set(["text", "image"]),
};

function inputModalitiesForClient(
  client: "pi" | "gajae",
  modalities: readonly string[] | undefined,
): string[] {
  const accepted = CLIENT_INPUT_MODALITIES[client];
  const kept: string[] = [];
  for (const value of modalities ?? []) {
    if (accepted.has(value) && !kept.includes(value)) kept.push(value);
  }
  return kept.length > 0 ? kept : ["text"];
}
```

Order-preserving and deduping, so `[text, image, audio]` becomes `[text, image]`
and the existing byte-exact golden is unaffected for models that never carried
`audio`.

## Call site 1 — Pi

`buildPiClientConfig`, currently line 659:

```diff
     const entry: PiModelEntry = {
       id: model.namespaced,
       name: exportModelLabel(model),
-      // Text is the one modality every routed model supports; anything richer must come
-      // from the catalog rather than an assumption.
-      input: model.inputModalities && model.inputModalities.length > 0 ? [...model.inputModalities] : ["text"],
+      // Text is the one modality every routed model supports; anything richer must come
+      // from the catalog rather than an assumption — and must still be inside the
+      // enum Pi accepts, because Pi returns an EMPTY model config on a schema
+      // failure rather than dropping the offending entry.
+      input: inputModalitiesForClient("pi", model.inputModalities),
     };
```

Also MODIFY the stale docstring above `buildPiClientConfig` (line 649), which
still says Pi's schema is UNVERIFIED. It is verified now — upstream
`packages/coding-agent/src/core/model-config.ts:156-169` pins `text|image`, and
`:267-274` is the whole-file rejection. Replace the "UNVERIFIED" sentence with
that citation.

## Call site 2 — Gajae

`buildGajaeClientConfig`, currently line 765:

```diff
     const entry: GajaeModelEntry = {
       id: model.namespaced,
       name: exportModelLabel(model),
-      input: model.inputModalities && model.inputModalities.length > 0
-        ? [...model.inputModalities]
-        : ["text"],
+      input: inputModalitiesForClient("gajae", model.inputModalities),
     };
```

## Test — `tests/client-export-modality-enum.test.ts` (NEW)

Named to sit beside `catalog-input-modality-enum.test.ts`, whose incident this
repeats. Cases:

1. `audio` is dropped from a Gajae entry — the exact live failure, using
   `zenmux/meta-muse-spark-1.1` with `[text, image, audio]`, asserting
   `[text, image]`.
2. The same for Pi, so the latent half is pinned too.
3. A model whose only modality is rejected falls back to `["text"]`, never `[]`.
4. `[text, image]` survives untouched in both.
5. Order and dedupe: `[image, text, image]` yields `[image, text]`.
6. A whole-catalog assertion: no emitted Pi or Gajae `input` value is outside
   `text|image`, given a catalog containing `audio`. This is the one that would
   have caught the bug, since the per-entry tests all passed while the file was
   broken.

## Verification

A unit test does not close this — 91 tests were green beside a config gjc
refuses to load.

1. `bun run typecheck`, `bun run test`
2. Re-apply the gajae integration through the running proxy
3. `grep -c audio ~/.gjc/agent/models.yml` → 0 inside the opencodex block
4. Launch gjc and confirm the model list loads with no schema error

Step 4 is the criterion. Steps 1-3 are necessary and insufficient.

## Accept criteria

- C1 — gjc loads the emitted config with no schema error, observed in the real
  file, and Pi's identical exposure is closed in the same change.
- No emitted Pi/Gajae `input` value outside the client's enum, asserted over a
  whole catalog rather than one entry.
- The byte-exact export goldens still pass, changing only where `audio` was
  previously emitted.
