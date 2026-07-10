---
title: CLI 레퍼런스
description: 모든 ocx 명령어와 플래그.
---

opencodex CLI는 `ocx`입니다. 최상위 사용법은 `ocx help`(또는 `--help` / `-h`)로 확인합니다.
도움말 표에 등록된 명령의 상세 사용법은 `ocx help <command>`로 볼 수 있습니다. 도움말과 버전
명령은 읽기 전용이며 Codex/opencodex 상태를 시작, 중지, 설치, 제거하거나 다시 쓰지 않습니다.

## 설정 및 라이프사이클

### `ocx init`

대화형 설정 마법사입니다. 프로바이더(프리셋 또는 사용자 지정), API 키(직접 입력 또는 `${ENV}`),
기본 모델, 프록시 포트를 차례로 묻고 `~/.opencodex/config.json`을 저장합니다. 선택에 따라 프록시를
`$CODEX_HOME/config.toml`(기본값 `~/.codex/config.toml`)에 주입하고 Codex 자동 시작 shim도
설치합니다.

### `ocx start [--port <port>]`

프록시 서버를 시작합니다(우선 포트 `10100`). 해당 포트를 이미 사용 중이면 opencodex가 다른 빈
포트를 골라 기록합니다. PID와 런타임 포트 상태를 저장하며, 살아 있는 두 번째 인스턴스는 시작하지
않습니다. 시작할 때 각 프로바이더의 모델을 Codex 카탈로그에 동기화합니다. 관리형 서비스
(`OCX_SERVICE=1`)로 실행한 경우가 아니면 종료 시 네이티브 Codex를 복원합니다.

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

실행 중인 프록시를 PID로 중지하고 PID 파일을 지운 뒤 네이티브 Codex를 복원합니다. 관리형
백그라운드 서비스가 설치되어 있으면 먼저 서비스를 중지해 프록시가 다시 뜨지 않게 합니다. 웹
대시보드의 **Stop** 버튼(`POST /api/stop`)도 같은 작업을 수행합니다.

### `ocx restore` &nbsp;·&nbsp; `ocx eject`

프록시는 그대로 두고 네이티브 Codex를 복원합니다. 주입된 설정 줄과 라우팅 카탈로그 항목을 제거해
일반 `codex`가 다시 네이티브로 동작하게 합니다. `eject`는 `restore`의 별칭입니다.

어느 표기든 `back`을 붙이면 프록시 라이프사이클을 바꾸지 않고, 이미 실행 중인 프록시를 일반
`codex`에 다시 연결합니다.

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai`

되돌릴 수 있는 백업을 지원하기 전에 Codex App 기록을 재매핑했던 예전 개발 빌드용 명시적 복구
명령입니다. 기록 데이터베이스가 잠겨 있다면 먼저 Codex를 닫으세요.

### `ocx restart`

`stop` 다음에 `ensure`를 실행합니다. 프록시/서비스를 중지하고 네이티브 Codex를 복원한 뒤 프록시를
백그라운드에서 시작하고, 실제 포트를 Codex에 다시 동기화합니다.

### `ocx ensure`

백그라운드 프록시가 실행 중인지 멱등적으로 확인하고 실시간 모델 카탈로그를 동기화합니다.
`codexAutoStart`가 `false`이면 자동 시작이 꺼져 있다는 메시지만 출력하고 아무 작업도 하지 않습니다.

### `ocx status [--json]`

프록시 PID, `/healthz` 연결 상태, 대시보드 URL, 설정 파일 경로, 기본 프로바이더, Codex 자동 시작
설정, 서비스 상태, shim 상태를 읽기 전용 진단 요약으로 출력합니다.

기계가 읽을 수 있는 읽기 전용 진단 계약은 `--json`으로 받습니다.

```bash
ocx status --json
```

축약된 객체 형태는 다음과 같습니다.

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.opencodex/config.json",
    "pid": "/Users/example/.opencodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.opencodex/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

실제 객체에는 `listen`(포트, 호스트명, 런타임/설정 출처), 설정 로드 진단, 번들 Codex 플러그인
진단도 들어갑니다. JSON 스키마는 필드 추가만 허용하므로 이후 버전에 필드가 늘 수 있지만 기존
필드는 유지됩니다. API 키, OAuth 토큰, authorization 헤더, 요청 내용, 이메일, 계정 식별자는
의도적으로 제외합니다.

### `ocx health [--json]`

실행 중인 프록시의 신원을 확인합니다. 일반 출력에는 PID와 포트가 나오고, `--json`은
`{ok, pid, port}`를 출력합니다. 정상일 때만 종료 코드 0, 그 밖에는 1을 반환하므로 서비스 probe에
쓸 수 있습니다.

### `ocx uninstall` &nbsp;·&nbsp; `ocx remove`

서비스와 프록시를 중지하고 서비스와 Codex shim을 제거한 뒤 네이티브 Codex를 복원합니다. 모든
복원 단계가 성공한 경우에만 opencodex 로컬 설정까지 지웁니다. `remove`는 `uninstall`의 별칭입니다.

## 모델 및 Codex

### `ocx sync`

설정된 모든 프로바이더에서 실시간 모델 목록을 가져와 병합한 카탈로그를 Codex에 다시 주입합니다.
프로바이더를 추가했거나 사용 가능한 모델 목록을 새로 고칠 때 실행하세요.

### `ocx sync-cache`

Codex의 로컬 모델 선택기 캐시를 무효화해 현재 opencodex 카탈로그로 다시 만들게 합니다.

### `ocx v2 [subcommand]`

Codex의 `multi_agent_v2` 기능 플래그와 3단계 multi-agent surface mode를 관리합니다.

| Subcommand | Action |
| --- | --- |
| `status` (기본값) | 현재 v2 플래그, multi-agent mode, thread concurrency를 보고합니다. |
| `on` | `$CODEX_HOME/config.toml`에서 `multi_agent_v2` 기능을 켜고 카탈로그를 다시 동기화합니다. |
| `off` | `multi_agent_v2` 기능을 끄고 다시 동기화합니다. |
| `mode v1` | 모든 모델을 v1 multi-agent surface로 강제합니다(업스트림 pin보다 우선). |
| `mode default` | 업스트림 model pin을 따릅니다(sol/terra=v2, luna=v1, 나머지=Codex 플래그). 설치 기본값입니다. |
| `mode v2` | 모든 모델을 v2 multi-agent surface로 강제합니다(업스트림 pin보다 우선). |
| `threads <n>` | `max_concurrent_threads_per_session`을 설정합니다(1 이상의 정수, v2 전용). |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

`mode` 하위 명령은 opencodex 설정에 `multiAgentMode`를 기록하고 Codex 카탈로그를 다시
동기화합니다. `on`/`off`는 `codex features enable|disable`로 codex-rs 기능 플래그를 바꿉니다.
변경 사항은 새 Codex 세션부터 적용되며, 실행 중인 세션은 고정된 surface를 유지합니다.

### `ocx models [--provider <name>] [--json]`

설정된 프로바이더에 정적으로 시드된 모델을 나열합니다. `--provider`는 한 프로바이더만 고르고,
`--json`은 모델 메타데이터와 함께 `liveModels`가 런타임 전용 항목을 추가할 수 있다는 안내를
반환합니다. 실시간 카탈로그를 가져오는 명령은 아닙니다. 그 작업은 `ocx sync`나 대시보드를
사용하세요.

### `ocx provider <subcommand>`

비대화형 프로바이더 관리 명령입니다. 레지스트리 항목은 이름만으로 시드되며, 사용자 지정 이름에는
`--adapter`와 `--base-url`이 모두 필요합니다.

| Subcommand | Supported flags | Action |
| --- | --- | --- |
| `list` | `--json` | 설정된 프로바이더와 아직 추가하지 않은 레지스트리 항목을 나열합니다. |
| `add <name>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync` | 레지스트리/사용자 지정 프로바이더를 추가합니다. `--force`는 덮어쓰고, 일반 출력 모드의 `--sync`는 실행 중인 프록시를 새로 고칩니다. |
| `show <name>` | `--json` | API 키를 가린 설정을 표시합니다. |
| `remove <name>` | `--json` | 기본 프로바이더가 아닌 항목을 제거합니다. 마지막 프로바이더는 제거할 수 없습니다. |
| `set-default <name>` | `--json` | 기존 프로바이더를 기본값으로 선택합니다. |

```bash
ocx provider list --json
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
```

## 인증

### `ocx login <provider>`

프로바이더에 등록된 로그인 절차를 시작합니다. OAuth 프로바이더는 브라우저를 열고 자동 갱신되는
자격 증명을 `~/.opencodex/` 아래에 저장합니다. API 키 로그인 프로바이더는 키 대시보드를 열고 키를
입력받아 가능한 경우 검증한 뒤 결과 프로바이더 설정을 저장합니다. 이름이 없거나 알 수 없는 이름이면
현재 허용되는 OAuth 및 API 키 프로바이더 id를 출력합니다.

```bash
ocx login xai
```

### `ocx logout <provider>`

프로바이더에 저장된 OAuth 자격 증명을 제거합니다.

## 대시보드

### `ocx gui`

`http://localhost:<port>`에서 [웹 대시보드](/opencodex/ko/guides/web-dashboard/)를 엽니다.
프록시가 실행 중이 아니면 자동으로 시작합니다.

## 백그라운드 서비스

### `ocx service [subcommand]`

opencodex를 로그인 관리형 백그라운드 서비스(macOS **launchd**, Linux **systemd user unit**,
Windows **Task Scheduler**)로 실행합니다. 로그인 시 자동으로 시작되고 비정상 종료 시 다시
시작됩니다. 서비스 실행은 `OCX_SERVICE=1`을 설정하므로 재시작할 때 Codex 설정을 반복해서
바꾸지 않습니다.

| Subcommand | Action |
| --- | --- |
| 없음 | 서비스를 생성/갱신하고 시작합니다. |
| `install` | 서비스를 생성하고 시작합니다. |
| `start` | 설치된 서비스를 시작합니다. |
| `stop` | 서비스를 중지하고 네이티브 Codex를 복원합니다. |
| `status` | 서비스 실행 여부를 보고합니다. |
| `uninstall` | 서비스를 제거하고 네이티브 Codex를 복원합니다. |
| `remove` | `uninstall`의 별칭입니다. |

```bash
ocx service
ocx service install
ocx service status
ocx service uninstall
```

### `ocx codex-shim <subcommand>`

PATH에 있는 스크립트 기반 `codex` 런처를 가벼운 자동 시작 스크립트로 감쌉니다. 실제 `codex.exe`
대상은 정확한 실행 파일 호출이 깨지지 않도록 건드리지 않습니다.

Codex 업데이트가 래퍼를 덮어쓰더라도 다음 `install` 호출에서 shim이 스스로 복구됩니다. 새
바이너리를 백업한 뒤 새 래퍼를 씁니다.

| Subcommand | Action |
| --- | --- |
| `install` | shim을 설치합니다(오래된 상태면 복구). |
| `uninstall` | shim을 제거하고 원래 Codex 바이너리를 복원합니다. |
| `remove` | `uninstall`의 별칭입니다. |
| `status` | shim 상태(설치됨 / 오래됨 / 없음)를 보고합니다. |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Service vs Shim]
항상 프록시를 켜두려면 `ocx service`를 사용하세요(권장). 데몬 없이 필요할 때만 가볍게 시작하려면
`ocx codex-shim`을 사용하세요. 이 경우 프록시는 `codex`를 실행할 때만 시작됩니다.
:::

## 진단

### `ocx doctor`

상태 경로와 파일시스템 유형, WSL 이중 설치, 프록시 환경/설정, ChatGPT 연결 상태, Codex 플러그인과
프로젝트 설정 경고, 대기 중인 기록 마이그레이션을 읽기 전용으로 진단합니다. 복구 안내는 출력하지만
직접 적용하지 않습니다.

### `ocx debug [provider|usage …]`

실행 중인 프록시의 관리 API에서 런타임 디버그 override를 읽거나 바꿉니다.

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

범위를 지정하지 않으면 `ocx debug`가 사용법을 출력합니다. 프록시가 멈춰 있을 때는 다음 시작 시
적용될 환경 변수 기본값도 보여 줍니다. 프로바이더 디버그 기본값은 `OCX_DEBUG=1`이며 기존
`OCX_DEBUG_FRAMES=1`도 지원합니다. 사용량 디버그 기본값은 `OPENCODEX_USAGE_DEBUG=1`입니다.

## 업데이트

### `ocx update`

npm에서 opencodex를 자체 업데이트합니다. 안정판 설치는 `@latest`, 프리뷰 설치는 `@preview`를
유지하며 `--tag latest|preview`로 바꿀 수 있습니다. 소스 checkout에서는 대신
`git pull && bun install`을 안내하고, 해당 태그의 최신 버전이면 아무 작업도 하지 않습니다. 파일을
교체하기 전에 실행 중인 프록시를 중지합니다. 설치된 서비스는 다시 빌드해 자동으로 시작하고,
포그라운드 설치에는 다음 단계로 `ocx start`를 안내합니다.

```bash
ocx update
ocx update --tag preview
```

[Release 워크플로](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)가 npm에
게시하는 즉시 새 버전을 사용할 수 있습니다.

## 도움말

`ocx help`, `ocx --help`, `ocx -h` — 최상위 사용법과 예제를 출력합니다.

`ocx help <command>`, `ocx <command> --help`, `ocx <command> -h` — `src/cli/help.ts`에 등록된
명령의 상세 사용법을 출력합니다. `provider`, `debug`, `v2`의 전체 하위 명령 계약은 위에 정리되어
있습니다.

도움말 플래그가 있더라도 알 수 없는 명령은 오류로 처리하므로, 스크립트는 출력 문자열을 분석하지
않고 종료 코드를 믿을 수 있습니다.

## 버전

`ocx --version`, `ocx -v`, `ocx version` — 스크립트에서 읽기 쉬운 한 줄 버전을 출력하고
종료합니다.

## 내부 명령

두 dispatch 대상은 일반 도움말에서 의도적으로 숨깁니다. `__refresh-version [preview]`는 분리된
프로세스에서 업데이트 알림 캐시를 갱신합니다.
`__gui-update-worker <job-id> [latest|preview] [restart]`는 대시보드 업데이트 작업을 실행합니다.
구현 세부 사항이며 안정적인 사용자 명령이 아닙니다.
