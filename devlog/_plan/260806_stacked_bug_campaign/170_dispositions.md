# 170 — Disposition matrix (final)

Schema per `160_phase17_closeout.md`. Reconciles against the frozen cutoff:
**49 open issues, 32 open PRs** (+ #1129 merged mid-triage).

## Stack PRs created

| Stack | PR | Base | Subject | Credited |
|-------|----|------|---------|----------|
| 01 | [#1133](https://github.com/lidge-jun/opencodex/pull/1133) | `dev` | Bounded translated SSE inspection | ingwannu |
| 02 | [#1134](https://github.com/lidge-jun/opencodex/pull/1134) | stack 01 | Skip empty native-profile stage sweeps | ingwannu |
| 03 | [#1135](https://github.com/lidge-jun/opencodex/pull/1135) | stack 02 | Native-main ACL timeout retry | luvs01 |
| 04 | [#1136](https://github.com/lidge-jun/opencodex/pull/1136) | stack 03 | Bounded rollout inspection | Simon |
| 05 | [#1137](https://github.com/lidge-jun/opencodex/pull/1137) | stack 04 | Structured output + Gemini effort ladders | Pranav Yerramaneni |
| 06 | [#1138](https://github.com/lidge-jun/opencodex/pull/1138) | stack 05 | Anthropic response-model identity | Giulio Leone, ingwannu |
| 07 | [#1139](https://github.com/lidge-jun/opencodex/pull/1139) | stack 06 | Vision raw-body sync + usage attempts | Bailey, Takashi Yamashiro |
| 08 | [#1141](https://github.com/lidge-jun/opencodex/pull/1141) | stack 07 | GitHub Copilot Responses normalization | Simon |
| 09 | [#1142](https://github.com/lidge-jun/opencodex/pull/1142) | stack 08 | Darwin eager rewrite relay gate | biao, 0xWinner98 |
| 10 | [#1144](https://github.com/lidge-jun/opencodex/pull/1144) | stack 09 | Cursor structured edits + reasoning replay | NexusCore, Vincent-HD |

The chain is linear: each PR targets the previous head, and stack 01 targets
`dev`. Merging bottom-up collapses the whole chain onto `dev`.

## Issues

| Item | Kind | Final state | Carrier | Credited | Evidence |
|------|------|-------------|---------|----------|----------|
| #1112 | issue | landed-stack01 | #1133 | ingwannu | `b2d1bb85d`, sse-inspector-bounds 23 pass |
| #1120 | issue | landed-stack02 | #1134 | ingwannu | `94c5ccf59`, native-profile trio 51 pass |
| #1117 | issue | landed-stack06 | #1138 | Giulio Leone | `1879bd0df`, identity suites 132 pass, red-green confirmed |
| #1110 | issue | landed-stack08 | #1141 | Simon | `8369eb949`, `58500d277`, copilot suites 50 pass |
| #1127 | issue | landed-stack09 | #1142 | biao, 0xWinner98 | `b6d325079`, 70 pass, red-green confirmed |
| #1017 | issue | landed-stack10 | #1144 | NexusCore | cursor+replay suites 32 pass |
| #241 | issue | upstream | — | Yuxin Qiao | Desktop allowlist is outside this repo (openai/codex#19694); #999 documents it, phase 150 deferred |
| #1102 | issue | deferred | — | — | Transparent credential hand-off to a spawned binary needs a new trust/admission design |
| #1059 | issue | deferred | — | — | Windows suite failures cross six subsystems; no subset provable from macOS |
| #1049 | issue | deferred | — | — | Crash-safe adoption is migration-grade work with its own recovery matrix |
| #92, #417, #1100 | issue | upstream | — | — | Fernet task body, Korean realtime U+FFFD, Codex summary-flag gating — all client-side |
| #1128, #1024, #994, #904, #796, #418 | issue | needs-info | — | — | Not reproducible on the current tree; each row in `001` cites the code that refutes or cannot confirm the report |
| 30 further issues | issue | feature | — | — | Enumerated in `001_issue_triage.md`; enhancement or roadmap, not bugs |

**Issue total: 6 landed + 1 upstream-documented + 3 deferred-large + 3 upstream
+ 6 needs-info + 30 feature = 49.**

## Pull requests

| Item | Kind | Final state | Carrier | Credited | Evidence |
|------|------|-------------|---------|----------|----------|
| #1114 | pr | landed-stack01 | #1133 | ingwannu | cherry-picked, authorship preserved; comment 5206431175 |
| #1124 | pr | landed-stack02 | #1134 | ingwannu | cherry-picked; comment 5206431146 |
| #1130 | pr | landed-stack03 | #1135 | luvs01 | cherry-picked; comment 5206434180 |
| #1115 | pr | landed-stack04 | #1136 | Simon | 5 commits cherry-picked; comment 5206434197 |
| #985 | pr | landed-stack05 | #1137 | Pranav Yerramaneni | adapted (schema-less `json_schema` guard); comment 5206933287 |
| #978 | pr | landed-stack05 | #1137 | Pranav Yerramaneni | adapted (docs + provider-wide case); comment 5206933565 |
| #1122 | pr | landed-stack06 | #1138 | Giulio Leone | adapted, narrowed to Anthropic; comment 5206933313 |
| #1121 | pr | credited-only | #1138 | ingwannu | duplicate of #1122; diagnosis credited; comment 5206933787 |
| #1047 | pr | landed-stack07 | #1139 | Bailey | adapted (failure-path leaks closed); comment 5206941034 |
| #1093 | pr | landed-stack07 (partial) | #1139 | Takashi Yamashiro | attempts adopted; ingress spans withheld as forgeable; comment 5206941258 |
| #1111 | pr | landed-stack08 | #1141 | Simon | adapted, dropped `6247d3932`; comment 5207281602 |
| #947 | pr | reimplemented-stack09 | #1142 | biao | predicate ported, timing-based tests rewritten; comment 5207281733 |
| #1036 | pr | landed-stack10 | #1144 | NexusCore | adapted (post-filter provenance); comment 5207281718 |
| #1126 | pr | landed-stack10 (partial) | #1144 | NexusCore | empty-delta adopted; disk persistence withheld; comment 5207281904 |
| #1092, #1085 | pr | deferred | — | Eachann, n3wr1ch | Phase 140 planned and diff-level specified; not executed this pass |
| #997, #999 | pr | deferred | — | Yuxin Qiao | Phase 150 planned and diff-level specified; not executed this pass |
| #1095 | pr | rejected-unsafe | — | Bailey | Idle-timer completion can truncate a slow valid response; needs authoritative EOF |
| #1056 | pr | deferred | — | biao | 54 files with backup/convergence/GUI gaps |
| #1131, #1109, #1096, #1039, #1010, #1002, #812, #811, #581 | pr | deferred | — | various | Feature programs / security-review units, enumerated in `002` |
| #557, #1008 | pr | deferred | — | JUN | Maintainer-owned, already in flight, deliberately untouched |
| #1119 | pr | deferred | — | JUN | Maintainer's own contract-test PR |
| #1129 | pr | already-merged | — | JUN | `e9d957bf6`, merged mid-triage |

**PR total: 12 landed + 1 credited-only + 1 rejected + 18 deferred = 32 open,
+ #1129 already merged.**

## Contributors credited

ingwannu, luvs01, Simon (Simon-Opopeee), Pranav Yerramaneni (DevMello),
Giulio Leone, Bailey (baileyh8), Takashi Yamashiro, biao (WZBbiao),
NexusCore (ZachDreamZ) — plus reporters MarcusNeufeldt, 0xWinner98, Vincent-HD.

Every landed commit derived from contributor work carries either their original
authorship (cherry-pick) or a `Co-authored-by:` trailer. No contributor PR was
merged, closed, or force-pushed.

## Not done, deliberately

- No PR merged. No issue or PR closed — including issues the stack fixes; they
  close when the stack merges, which is the maintainer's call.
- Phases 140 and 150 are specified at diff level but not executed. They are the
  natural next work-phases, not blockers.
- No branch deleted, no release, no version bump.

## CI state at close

Stacks 01-06 fully green. Stacks 07-10 were still completing or hit a GitHub
Actions outage (`Failed to resolve action download info: Service Unavailable`)
that was rerun. One earlier `test 3/4` failure on #1133 was a Bun runtime
`EEXIST: epoll_ctl` between tests with **no assertion failure**, proven
incidental by #1134 — which contains the same commit — passing that shard; it
is green after rerun.
