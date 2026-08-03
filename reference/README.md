# 参考项目索引

本目录用于保存阶段性架构参考项目。参考项目只用于比较实现边界、运行时生命周期、打包方式和故障恢复策略，不直接复制实现。

## 参考项目

| 本地路径 | GitHub URL | 主要功能 | 技术栈 | 对本项目的参考价值 |
| --- | --- | --- | --- | --- |
| `reference/electron-builder` | https://github.com/electron-userland/electron-builder | Electron 安装版、便携版、资源与签名构建 | TypeScript、Node.js、Electron 构建工具链 | 用于比较 `extraResources`、`process.resourcesPath`、ASAR 解包、NSIS/portable 产物与代码签名边界。 |
| `reference/cockpit-tools` | https://github.com/jlcodes99/cockpit-tools | 多账号/多 IDE 管理，包含 Codex API Service，可把 Codex/Claude/Gemini 等账号能力暴露为本地兼容 API | Tauri/Rust + React/TypeScript + Go `cockpit-cliproxy` sidecar | 重点参考 Go sidecar 的 WebSocket/HTTP 流生命周期、upstream execution session 释放、心跳/超时、请求日志与 usage 记录边界。 |
| `reference/cc-switch` | https://github.com/farion1231/cc-switch | Claude Code / Codex / 多 provider 本地路由、代理、用量统计与配置切换 | Tauri/Rust + React/TypeScript | 重点参考 Rust 内置 proxy 的轻量 session、RAII active connection guard、流式首包/静默超时、SSE usage collector 收尾机制。 |
| 未落地（网络连接失败） | https://github.com/electron/packager | 将 Electron 应用打包为平台目录 | TypeScript、Node.js、Electron Packager | 用于对比最小目录打包模型；本次 `git clone --depth 1 --filter=blob:none` 因 SSL 连接失败未成功，不复制其代码。 |

## 本次检查结论

- `cockpit-tools` 和 `cc-switch` 都具备本地代理/中转能力，低内存占用说明“中转站”本身不必然需要 1GB+ 驻留内存。
- `cockpit-tools` 把 Codex API 代理核心放在 Go sidecar 中，WebSocket 连接断开时集中释放 tool cache、upstream execution session 和连接；另外中继层有 read/write deadline、heartbeat 和 pending request 清理。
- `cc-switch` 把 proxy 写在 Tauri/Rust 侧，每请求只提取 session id 做日志关联，不做复杂常驻 Session 管理；流式响应使用 Drop/RAII 风格收尾，usage 事件在 finish 时清空。
- OpenCodex 当前内存异常更像 WebSocket turn 生命周期没有释放，而不是 Windows 桌面端天然成本。Windows/Bun/JSC 会让 external/JSC heap 指标更显眼，但 `activeTurnCount` 长期高企是应用层信号。

## 检出范围

为避免下载大型图片和发布资产，本次只检出两个参考仓库的代理相关源码：

- `reference/cockpit-tools`：`cockpit-cliproxy` 的 WebSocket、OpenAI Responses、wsrelay、usage、少量 Tauri/Rust process 模块。
- `reference/cc-switch`：`src-tauri/src/proxy`、proxy 命令/服务、usage 相关 DAO/API、少量前端 proxy/usage 组件。
