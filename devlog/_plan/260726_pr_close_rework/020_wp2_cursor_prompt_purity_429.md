# WP2 — PR #429 Cursor 프롬프트 오염 제거 + 빈 shell 호출 거부

대상: PR #429 (Aciredy), head `f408f348`. 보안 경계 없음.

## 충돌 상황

`git merge-tree`가 3파일 텍스트 충돌을 보고한다.

```
src/adapters/cursor/protobuf-events.ts
src/adapters/cursor/tool-definitions.ts
tests/cursor-blob.test.ts
```

원인은 이 PR이 #402의 `shell_command`/`exec_command` 이중 alias 계약보다 앞서 작성됐기
때문이다. PR을 그대로 적용하지 않고, dev의 현재 계약 위에 **의도만** 재구현한다.
보존해야 할 것: `protobuf-events.ts`의 alias 해석과 `cursorToolNameMap`,
`tool-definitions.ts`의 두 shell alias·시스템 가이던스·카탈로그 필터·인자 정규화.
제거할 것: 사용자 메시지 변조 경로 하나뿐이다.

## MODIFY `src/adapters/cursor/protobuf-request.ts`

before:

```ts
import {
  appendCursorGenericToolUseHint,
  appendCursorShellAliasHint,
```

after:

```ts
import {
  appendCursorGenericToolUseHint,
```

before:

```ts
const text = lastRole === "user" || lastRole === "developer"
  ? appendCursorShellAliasHint(request.tools, appendCursorGenericToolUseHint(request.tools, rawText))
  : rawText;
```

after:

```ts
const text = lastRole === "user" || lastRole === "developer"
  ? appendCursorGenericToolUseHint(request.tools, rawText)
  : rawText;
```

## MODIFY `src/adapters/cursor/tool-definitions.ts`

DELETE: `CURSOR_SHELL_ALIAS_USER_HINT` 상수 전체, 그리고
`looksLikeShellCommandRequest`, `activeTextMentionsExecCommand`,
`shouldAppendCursorShellAliasHint`, `appendCursorShellAliasHint` 네 함수.

KEEP (삭제 금지): `CURSOR_SHELL_ALIAS_SYSTEM_NOTE`, `CURSOR_GENERIC_TOOL_USE_USER_HINT`,
`CODEX_SHELL_BRIDGE_TOOL_NAMES`, `isCodexShellBridgeToolName`, 모든 alias 해석 헬퍼.

시스템 노트는 남는다. 제거 대상은 사용자 턴 텍스트에 주입되던 힌트뿐이다.

## MODIFY `src/adapters/cursor/protobuf-events.ts`

`tool-definitions.ts` import에 `isCodexShellBridgeToolName`을 추가한다.

before (`dev:src/adapters/cursor/protobuf-events.ts:364`):

```ts
function commitToolCall(state: CursorProtobufEventState, callId: string, finalArgs: string): CursorServerMessage[] {
  const open = state.openToolCalls.get(callId);
  if (!open) return [];
  const out: CursorServerMessage[] = [{ type: "tool_call_start", id: callId, name: open.name }];
```

after:

```ts
function commitToolCall(state: CursorProtobufEventState, callId: string, finalArgs: string): CursorServerMessage[] {
  const open = state.openToolCalls.get(callId);
  if (!open) return [];

  if (isCodexShellBridgeToolName(open.name)) {
    let parsed: unknown;
    try {
      parsed = finalArgs ? JSON.parse(finalArgs) : {};
    } catch {
      parsed = null;
    }
    const args = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    const command = args.command ?? args.cmd;
    if (typeof command !== "string" || command.trim().length === 0) {
      state.openToolCalls.delete(callId);
      state.completedToolCalls.add(callId);
      return [{
        type: "error",
        message: `Cursor emitted ${open.name} without a non-empty command; the tool call was dropped.`,
      }];
    }
  }

  const out: CursorServerMessage[] = [{ type: "tool_call_start", id: callId, name: open.name }];
```

`args.command ?? args.cmd` 둘 다 보는 이유: 정규화 전후 필드명이 다르고 alias도 둘이다.

## 회귀 테스트

APPEND: `tests/cursor-tool-arg-decoding.test.ts`

```ts
test("shell bridge aliases reject empty or malformed commands and accept both wire fields", () => {
  const cases = [
    { tool: "exec_command", args: { cmd: jsonBytes("echo ok") }, valid: true },
    { tool: "exec_command", args: { cmd: jsonBytes("   ") }, valid: false },
    { tool: "shell_command", args: { command: jsonBytes("echo ok") }, valid: true },
    { tool: "shell_command", args: { command: jsonBytes("") }, valid: false },
    { tool: "exec_command", args: { cmd: jsonBytes(42) }, valid: false },
  ] as const;

  for (const [index, entry] of cases.entries()) {
    const state = createCursorProtobufEventState({
      clientToolNames: [entry.tool],
    });
    const args = create(McpArgsSchema, {
      name: entry.tool,
      toolName: entry.tool,
      toolCallId: `shell_${index}`,
      providerIdentifier: "opencodex-responses",
      args: entry.args,
    });

    const events = mapSyntheticMcpExecToToolEvents(
      args,
      "fallback",
      { allowEmptyArgs: true, state },
    );

    if (entry.valid) {
      expect(events[0]).toEqual({
        type: "tool_call_start",
        id: `shell_${index}`,
        name: entry.tool,
      });
      expect(events.at(-1)).toEqual({
        type: "tool_call_end",
        id: `shell_${index}`,
      });
    } else {
      expect(events).toEqual([{
        type: "error",
        message: `Cursor emitted ${entry.tool} without a non-empty command; the tool call was dropped.`,
      }]);
    }
  }
});
```

RED→GREEN 근거: 수정 전에는 빈/잘못된 인자도 평범한 `start`/`end` 쌍이 되어
`valid:false` 케이스의 `expect(events).toEqual([{type:"error"...}])`가 실패한다.

## 활성화 시나리오

새 조건 분기는 `isCodexShellBridgeToolName(open.name)` 게이트와 그 안의 빈 커맨드 판정이다.
테스트가 5개 케이스로 두 분기를 모두 밟는다: alias 2종 × 필드명 2종 × 빈/비빈/타입오류.
관찰 가능한 효과는 `tool_call_start` 대신 단일 `error` 이벤트가 나오고 `openToolCalls`에서
제거되는 것이다.

## 커밋

```
fix(cursor): stop injecting shell-alias hints and reject empty bridge calls (#429)

Co-authored-by: Markus Dunk <markus@markusdunk.com>
```

## 검증

```bash
bun test --isolate tests/cursor-tool-arg-decoding.test.ts tests/cursor-blob.test.ts tests/cursor-protobuf.test.ts
bun run typecheck
```
