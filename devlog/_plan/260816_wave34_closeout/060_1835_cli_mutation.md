# 060 — #1835/#1838: route `config set/unset` through the existing primitive

Both issues are CLOSED as duplicates of each other, but the defect is live and the fix is small. Reopen `#1838` (the surviving number) or land the fix referencing both.

## Verified defect

`config set/unset` reads the disk snapshot OUTSIDE the mutation lock (`src/cli/config-command.ts:133`), then sends that whole older snapshot through `saveConfig` (`:145`). A concurrent edit landing in between is silently reverted. `config import` likewise replaces via raw `saveConfig` (`:178`).

## Fix — no new primitive needed

The roadmap asks for a new "config mutation intent primitive". It already exists:

```ts
mutatePersistedConfig<T>(mutate: (config: OcxConfig) => PersistedConfigMutation<T>): PersistedConfigMutationOutcome<T>
```

(`src/config.ts:2884` — clones the latest validated disk config, reruns the callback, compares exact raw strings, rebases up to three times.)

So `set`/`unset` become:

```diff
-  const config = loadConfig();
-  applyPath(config, path, value);
-  saveConfig(config);
+  const outcome = mutatePersistedConfig(config => {
+    applyPath(config, path, value);
+    return { config, result: undefined };
+  });
```

The read now happens inside the transaction, so the mutation is applied to whatever is actually on disk at commit time.

**`import` deliberately does NOT change.** Import is an intentional whole-document replacement; forcing it through patch semantics would silently merge instead of replace, which is a different and worse surprise. What it needs instead is honesty: compute the set of top-level keys present on disk but absent from the imported document and warn about each before writing, so a replacement that drops the user's providers is announced rather than discovered later.

## Tests

In the CLI config tests: a `set` whose callback observes an externally-changed disk state applies onto the NEW state, not the stale one; `unset` likewise; `import` still replaces wholesale but emits a warning naming each dropped top-level key; and a byte-identical `set` does not bump the config generation.
