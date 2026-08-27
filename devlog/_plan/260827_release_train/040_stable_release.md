# 040 — publish the stable release

## Target

`2.34.0`, dist-tag `latest`.

## How

From a checkout on `main`:

```
OCX_RELEASE_SSH_KEY=~/.ssh/opencodex_release_ed25519 \
  bun scripts/release.ts 2.34.0 --tag latest        # dry run
  # inspect, then re-run with --publish
```

`release.ts` refuses a prerelease version on `main`, so the plain `2.34.0` is required
here rather than a matter of taste.

## Acceptance

- `npm view @bitkyc08/opencodex dist-tags` shows `latest = 2.34.0`
- `npm view @bitkyc08/opencodex@2.34.0 gitHead` equals the `main` release commit
- the `v2.34.0` git tag exists and points at that commit
- the published tarball's `package.json` version reads `2.34.0` — checked by unpacking,
  not by trusting registry metadata

## Risk

npm publish is irreversible. The dry run is not optional ceremony: it is the only
rehearsal available. Read the dry-run job log for the packed file list before publishing —
a release that ships the wrong files cannot be unshipped, only superseded.
