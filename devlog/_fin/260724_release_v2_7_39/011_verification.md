# v2.7.39 release verification

## Local and tracked-state proof

- Release command: `npm exec --yes --package=bun@1.3.14 -- bun scripts/release.ts 2.7.39 --publish`.
- Local typecheck: exit 0.
- Full suite: 4024 pass, 0 fail, 19566 assertions, 318 files.
- Privacy scan: passed.
- `git diff-tree --no-commit-id --name-status -r 357acee62458684bc027e9d524e95bd066df3a43`: `M package.json` only.
- `git status --short --branch`: clean `main...origin/main`.

## Workflow proof

- Cross-platform CI: `https://github.com/lidge-jun/opencodex/actions/runs/30073226065`, success, head SHA `357acee62458684bc027e9d524e95bd066df3a43`.
- Service lifecycle: `https://github.com/lidge-jun/opencodex/actions/runs/30073226071`, success, same SHA.
- Release: `https://github.com/lidge-jun/opencodex/actions/runs/30073562521`, success, same SHA, `dry-run=false`.

## Public artifact proof

- npm version: 2.7.39.
- npm dist-tags: `latest=2.7.39`, `preview=2.7.39-preview.20260724`.
- npm tarball: `https://registry.npmjs.org/@bitkyc08/opencodex/-/opencodex-2.7.39.tgz`.
- npm integrity: `sha512-Vy9DBmXw27x7RNKrlWhIMD0kD0qhamJ9LCBctW+lepac2+rL1gKqEXBCSIfsMCqCGUk5kFKSakEYXUyMpbYD6w==`.
- Git tag: `refs/tags/v2.7.39` -> release SHA.
- GitHub Release: `https://github.com/lidge-jun/opencodex/releases/tag/v2.7.39`, stable, non-draft, same SHA.
- Fresh CLI smoke: `opencodex 2.7.39`.

## Independent C-phase review

- Verdict: PASS; blockers: none.
- Independently confirmed one SHA across `origin/main`, npm `gitHead`, Git tag, GitHub Release, and all three Actions runs.
- Independently recomputed the downloaded tarball SHA-512 and matched the registry integrity value.
- Independently confirmed npm provenance identifies `lidge-jun/opencodex`, `.github/workflows/release.yml`, `refs/heads/main`, Release run `30073562521`, and the release SHA.
- Independently reproduced a fresh-cache CLI smoke: `opencodex 2.7.39`.
