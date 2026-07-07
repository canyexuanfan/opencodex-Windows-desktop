# WSL + Windows 동시 설치 하드닝 (260707)

Goal: Codex CLI가 WSL과 Windows 양쪽에 설치된 머신에서 ocx의 shim/홈 해석/진단이 안전하게 동작. Session 019f34f2-3c06-7250-a2ee-dd3707f8130d.

## 조사 (cxc-search Tier 1+2)

- 공식 문서(developers.openai.com/codex/app/windows): Windows Codex는 `%USERPROFILE%\.codex`, WSL은 `~/.codex`로 분리가 기본. 공유하려면 WSL에서 `CODEX_HOME=/mnt/c/Users/<user>/.codex` 지정 방식 안내.
- WSL FAQ(learn.microsoft.com): WSL은 기본으로 Windows PATH를 이어붙임(appendWindowsPath) → `/mnt/c/...`의 Windows codex 런처(codex/codex.exe/codex.cmd)가 WSL 셸에서 잡힐 수 있음.
- WSL networking: NAT 모드 localhost는 Windows→WSL 단방향(localhostForwarding). WSL→Windows는 mirrored 필요. 관련: openai/codex#15447 (WSL2 내부 codex가 Windows 프록시 미사용).

## 위험 모델

1. **Shim이 Windows 런처를 감싸는 사고**: WSL에서 `ocx ensure` 시 PATH interop으로 `/mnt/c/.../codex`(npm sh 런처)가 발견되면, WSL 전용 bun 경로를 박은 sh shim으로 교체됨 → Windows 쪽 codex 호출 전부 파손. ← 이번 패치로 차단.
2. **홈 불일치**: 양쪽 설치 시 ocx는 리눅스 `~/.codex`를 관리하는데 사용자가 Windows Codex app을 쓰면 카탈로그/로그인이 서로 다른 홈에 있음 → doctor 진단+힌트로 가시화.
3. **localhost 방향성**: WSL의 ocx에 Windows codex가 붙는 건 기본 동작(NAT localhostForwarding), 역방향은 mirrored 필요 → doctor 힌트 텍스트에 포함하지 않고 dual-install 힌트로 노출(과잉 경고 방지).

## 구현

- shim.ts: `findCodexOnPath` 주입 가능 deps로 재작성. WSL에서 `/mnt/<drive>/` PATH 엔트리 스킵 + 스킵된 Windows codex를 `lastShimDiscoveryError` 가이던스로 기록("WSL에 codex 설치하거나 Windows에서 ocx ensure 실행"). interop 디렉토리는 Windows 런처 이름(codex.exe/.cmd/.ps1 포함)으로 조회. `isWindowsInteropDir`/`lastCodexDiscoveryError` export.
- home.ts: `listWslWindowsCodexHomes` 추출(동작 불변 리팩토링), doctor가 재사용.
- doctor.ts: `collectWslDualInstall` — 리눅스 `~/.codex/config.toml` 존재, Windows 프로필 `.codex` 목록, 유효 CODEX_HOME이 /mnt인지, PATH의 codex가 interop인지 보고. runDoctor에 "WSL Codex installs" 섹션 + 힌트 2종(홈 분리/공유 옵션, interop shim 거부 안내).

## 검증

- bun test ./tests/ 1619 pass / 0 fail, tsc clean. 신규 테스트 6건(shim 4, doctor 2).
- 독립 리뷰어(gpt-5.5, Arendt) 감사: **PASS, blocking_issues 없음.** non-WSL 동작 보존(shim.ts:95/105/121), interop 스킵 정확성(shim.ts:106/126), home.ts 리팩토링 동등성(home.ts:72), doctor off-WSL 불활성(doctor.ts:96/114), 구 시그니처 잔존 호출 없음 확인. 자체 재검증 34 pass + tsc exit 0.
