# 110 — App-route QA session + planning-time narration (m1)

Instrument: self-created Codex app thread 01a03c74-3d91-74f3-b060-03f521e83c6c
(cursor/grok-4.6 high, projectless cursor-app-qa), created via
codex_app__create_thread from this session — the first app-route QA driven
entirely by the agent.

## Result

- Terminal: APP_QA_RESULT: PASS (5 read-only calls + qa.txt LINE1/LINE2
  lifecycle completed).
- Cost signatures: 13 commandExecutions for a ~8-call task; 21
  switch-mentions; 5 empty-output mentions; file writes done via shell
  printf instead of apply_patch.

## Mechanism finding (key)

The 차단/전환 narration originates at PLANNING time: reasoning contains
"Shell 도구를 사용해 5개의 독립적인 명령을 한 번에 실행할 것이다" and
"Shell이 차단되어 브리지로 전환" BEFORE any denial payload arrives in that
round — the pattern is replayed-history-driven (G1 class), not a reaction
to our gap-8 denial text. Response-layer rewrites therefore reduce
narration in fresh sessions (codex exec rounds: 0 hits) but cannot zero it
in app sessions whose history already contains the pattern.

User screenshot (13:5x) independently confirms: same-day app session still
narrates 차단/전환 and fills batches via bridge after a native probe.

## Increment shipped (this commit)

- Guidance note: "Tool-selection commentary is forbidden — FIRST visible
  action is the bridge call itself; 차단/전환/blocked/switching must not
  appear for tool-routing reasons."
- Guidance note: shell-redirection file writes forbidden while
  apply_patch/structured-edit advertised (printf/echo >, heredoc, sed -i).
- Tests extended (cursor-tool-definitions 26 pass).

## Honest bound

Zeroing app-session narration requires the G1 replay-representation line:
tool-suspended checkpoints (gap-3) engaging in real app threads so history
stops replaying the old pattern. Until the stack lands and sessions turn
over, existing threads keep echoing it. Re-probe after service repair
recorded below.
