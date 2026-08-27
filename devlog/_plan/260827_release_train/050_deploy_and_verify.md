# 050 — docs deploy and installed-runtime proof

## Docs deploy

`deploy-docs.yml` triggers on push to `main` under `docs-site/**`. The `030` promotion
carries 293 commits of `docs-site` changes, so the deploy should fire on that merge without
a manual dispatch. Confirm rather than assume: if the path filter did not match, dispatch it.

## Installed-runtime proof

Registry metadata is not the same claim as a working install. Install the published
version into a scratch prefix and run it:

```
cd "$(mktemp -d)" && npm i @bitkyc08/opencodex@2.34.0 && npx ocx --version
```

The version the runtime reports is the evidence, not what the registry says it stored.

## Release record

Write the outcome to this unit: both channel versions, both release commits, both workflow
run ids, the docs deploy run id, and what was deliberately NOT included (#2745). Then the
unit is closable to `_fin`.

## Acceptance

- the docs deploy run for the `main` release concluded `success`
- a real install of `2.34.0` reports `2.34.0` from its own runtime
- the record names every sha and run id rather than describing them
