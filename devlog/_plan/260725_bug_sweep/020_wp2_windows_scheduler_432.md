# WP2 — #432 Windows Task Scheduler 기본값 생략으로 인한 stale 오탐

## 증상

정상 동작 중인 Task Scheduler 서비스를 `ocx status`와 Dashboard Startup Safety가
stale / AT RISK로 표시한다. 실제 작업과 프록시는 멀쩡히 돌아간다. Windows 11 + 2.7.39.

## 근본 원인

Windows가 등록된 작업을 export할 때 스키마 기본값에 해당하는 요소를 생략한다.
OpenCodex는 XML의 유효 의미가 아니라 요소의 문자적 존재를 검사한다.

`src/service.ts:471`의 섹션 추출기는 여는/닫는 태그 쌍을 전제한다.

```ts
function taskXmlSection(xml: string, tag: string): string {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml)?.[1] ?? "";
}
```

`windowsTaskRegistrationHealthy()`가 세 값을 리터럴로 요구한다.

```ts
  return /<Enabled>\s*true\s*<\/Enabled>/i.test(trigger)
    && /<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(principal)
    && /<RunLevel>\s*LeastPrivilege\s*<\/RunLevel>/i.test(principal)
    && /<Enabled>\s*true\s*<\/Enabled>/i.test(settings)
    && ...
```

세 가지가 동시에 깨진다.

- `<LogonTrigger />`는 self-closing이라 `taskXmlSection()`이 빈 문자열을 반환한다.
- 생략된 Trigger/Settings `<Enabled>`가 `false`로 판정된다.
- 생략된 `<RunLevel>`이 `false`로 판정된다.

**두 번째 독립 오탐**이 `src/service.ts:953`에 따로 있다. 이걸 놓치면 반쪽 수정이 된다.

```ts
const schedulerEnabled =
  schedulerInstalled && /<Enabled>\s*true\s*<\/Enabled>/i.test(schedulerSettings);
```

`windowsTaskRegistrationHealthy()`만 고치면 `schedulerEnabled`는 계속 `false`이고
서비스는 여전히 disabled로 표시된다.

전파 경로는 `src/service.ts:897`의 `stale` 계산 → `src/codex/autostart-health.ts:127`의
`service.stale` → 146행의 `AT RISK after restart (background service files are stale...)`.

## 공식 스키마 근거

Microsoft 문서로 확인한 실제 기본값:

- Trigger `Enabled`: [Task Scheduler Schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema)가
  `default="true" minOccurs="0"`. [Common Trigger Elements](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tsch/a0cf999f-aa47-4821-a46a-00fd28431f65)도
  "필드가 없거나 TRUE이면 enabled"라고 명시한다.
- Settings `Enabled`: 같은 XSD에서 `default="true" minOccurs="0"`.
  [SchRpcRegisterTask](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tsch/849c131a-64e4-46ef-b015-9d4c599c5167)는
  Settings/Enabled가 "존재하고 FALSE일 때"만 실행하지 않는다고 규정한다.
- Principal `RunLevel`: XSD에서 `minOccurs="0"`이고, 생략 시 서버가 `LeastPrivilege`를
  사용해야 한다고 같은 프로토콜 문서가 명시한다.

개별 [Enabled(settingsType) 페이지](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-enabled-settingstype-element)는
`minOccurs="1"`이라고 적지만 전체 XSD 및 등록 프로토콜과 모순된다. 전체 스키마와 동작
프로토콜을 우선 근거로 삼는다.

## Diff-level 변경안

### `src/service.ts`

헬퍼 두 개를 `taskXmlSection()` 옆에 추가한다.

```ts
+/** Count occurrences of a tag, including self-closing forms. */
+function taskXmlElementCount(xml: string, tag: string): number {
+  return xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?\\s*\\/?>`, "gi"))?.length ?? 0;
+}
+
+/**
+ * Task Scheduler omits schema-default elements when exporting a registered task,
+ * so absence means the documented default, not a mismatch (#432). An element that
+ * IS present must still match exactly — never treat a malformed value as healthy.
+ */
+function taskXmlOptionalValueEquals(xml: string, tag: string, expected: string): boolean {
+  const elementCount = taskXmlElementCount(xml, tag);
+  if (elementCount === 0) return true;
+  const values = [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*<\\/${tag}>`, "gi"))];
+  return elementCount === 1
+    && values.length === 1
+    && values[0]![1]!.trim().toLowerCase() === expected.toLowerCase();
+}
+
+/** Settings/Enabled defaults to true when omitted. */
+export function windowsTaskRegistrationEnabled(xml: string): boolean {
+  return taskXmlOptionalValueEquals(taskXmlSection(xml, "Settings"), "Enabled", "true");
+}
```

`windowsTaskRegistrationHealthy()` 본문:

```ts
-  return /<Enabled>\s*true\s*<\/Enabled>/i.test(trigger)
-    && /<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(principal)
-    && /<RunLevel>\s*LeastPrivilege\s*<\/RunLevel>/i.test(principal)
-    && /<Enabled>\s*true\s*<\/Enabled>/i.test(settings)
+  // A self-closing <LogonTrigger /> yields an empty section, so check the element
+  // itself rather than inferring presence from its body.
+  return taskXmlElementCount(xml, "LogonTrigger") > 0
+    && taskXmlOptionalValueEquals(trigger, "Enabled", "true")
+    && /<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(principal)
+    && taskXmlOptionalValueEquals(principal, "RunLevel", "LeastPrivilege")
+    && windowsTaskRegistrationEnabled(xml)
     && /<MultipleInstancesPolicy>\s*IgnoreNew\s*<\/MultipleInstancesPolicy>/i.test(settings)
     && /<ExecutionTimeLimit>\s*PT0S\s*<\/ExecutionTimeLimit>/i.test(settings)
     && action.includes(...)
```

`diagnoseService()`의 두 번째 오탐 (953-958행):

```ts
-const schedulerSettings = taskXmlSection(schedulerXml, "Settings");
-const schedulerEnabled =
-  schedulerInstalled && /<Enabled>\s*true\s*<\/Enabled>/i.test(schedulerSettings);
+const schedulerEnabled = schedulerInstalled && windowsTaskRegistrationEnabled(schedulerXml);
```

`schedulerSettings` 지역 변수가 다른 곳에서 쓰이지 않으면 함께 제거한다.

## 회귀 테스트

`tests/service.test.ts` (203행 부근의 `buildWindowsTaskXml()` + `.replace()` inline
fixture 패턴을 따른다).

1. `accepts canonicalized scheduler XML with omitted defaults`
   - `<LogonTrigger />` self-closing, Trigger/Settings `Enabled` 없음, `RunLevel` 없음
   - `windowsTaskRegistrationHealthy()` 및 `windowsTaskRegistrationEnabled()` 모두 `true`
   - 수정 전 실패: 세 리터럴 정규식과 빈 섹션 때문에 `false`

2. `rejects explicit unsafe values even when defaults may be omitted`
   - Trigger `Enabled=false`, Settings `Enabled=false`, `RunLevel=HighestAvailable`
   - 각각 `false` — 생략 허용이 명시적 비활성화까지 통과시키지 않음을 고정

3. `still requires a logon trigger`
   - `<LogonTrigger />` → `<BootTrigger />`
   - `false` — optional-default 도입이 trigger 부재를 우연히 통과시키지 않음

4. `preserves exact service lifecycle constraints`
   - `InteractiveToken→Password`, `IgnoreNew→Parallel`, `PT0S→PT72H`,
     `wscript.exe→cmd.exe`, launcher path 변경 → 전부 `false`

5. `canonicalized scheduler state remains viable`
   - 두 판정 결과를 `deriveWindowsServiceDiagnostic()`에 넣어
     `stale:false`, `enabled:true`, `viable:true` 확인
   - 이 테스트가 `schedulerEnabled`를 고치지 않은 반쪽 수정을 잡는다

## 유지해야 할 동작

- `LogonTrigger` 자체의 존재 요구.
- 명시적 `Enabled=false` / `RunLevel=HighestAvailable` 거부.
- `LogonType=InteractiveToken`, `MultipleInstancesPolicy=IgnoreNew` exact check.
- `ExecutionTimeLimit=PT0S` exact check — 생략 기본값이 `PT72H`라 여기서는 생략도 진짜 불일치.
- 정확한 `wscript.exe` action과 VBS launcher 인자.
- asset 파일 존재, baked path, backend-state mismatch, WinSW 충돌 검사.

## PR #408과의 관계

PR #408은 `src/service.ts`의 import 부근과 321-330행(`schtasks()` 래핑 + elevation)만
건드린다. 우리가 고치는 471-493행과 953-958행은 손대지 않으므로 텍스트 충돌은 없다.
`tests/service.test.ts`도 #408은 건드리지 않는다.

다만 의미상 결합이 있다. #408의 `evaluateWindowsSchedulerInstallVerification()`이 같은
`windowsTaskRegistrationHealthy()`를 호출하므로, #432를 고치지 않으면 elevated install
성공 후에도 canonicalized XML을 unhealthy로 보고 rollback할 수 있다. 즉 이 수정은
#408을 방해하지 않고 오히려 보강한다.

## 검증 명령

```bash
bun test tests/service.test.ts
bun run typecheck
```
