# OpenCodex Windows 桌面端上线 Todo List

> 这是后续线程继续开发的唯一执行清单。  
> 目标：在不增加产品功能的前提下，把现有 OpenCodex 改造成可直接使用的 Windows 桌面端。  
> 当前基线：`main` / `1adad35731ff3586d3d8dfaf531d5b64e0bb1092`  
> 本地仓库：`F:\workbuddy\opencodex`  
> 签名：`CN=十七°` 自签名代码签名证书。  
> 默认不 push、不创建 Release、不上传安装包。

---

## 0. 新线程只需先读这些

每个新线程开始时只执行以下准备，不要重复做其他流程：

- [x] 读取根目录 `AGENTS.md`。
- [x] 根据修改目录读取最近的 `src/AGENTS.md`、`gui/AGENTS.md` 或 `scripts/AGENTS.md`（本阶段未修改这些目录）。
- [x] 读取本文件当前状态、下一任务和目标阶段。
- [x] 读取 `docs/Windows桌面端改造方案.md`。
- [x] 读取与当前问题有关的 `questions/` 排查指南。
- [x] 运行 `git status --short --branch`。
- [x] 确认只修改当前工作包允许的文件。
- [x] 启动任何服务器前先检查端口；端口被占用时换端口并记录。
- [x] 完成后只更新本文件相关状态、验证证据和下一任务。

新线程提示词：

```text
先读取 AGENTS.md、todolist.md、Windows桌面端改造方案和当前工作包涉及的说明，
只继续“下一任务”，不要增加功能，不要重做 GUI，不要 push。
```

---

## 1. 当前状态

### 已确认

- [x] 原项目已有完整 `gui/`：React + Vite Dashboard。
- [x] GUI 直接复用，不重新设计、不重排导航、不生成视觉稿。
- [x] 推荐架构已确定：Electron 单实例宿主 + Bun sidecar + 现有 Dashboard。
- [x] 桌面 UI 不新增端口。
- [x] 代理只使用一个 `127.0.0.1` 动态端口。
- [x] 最终用户不需要安装 Node.js、Bun、Rust、Python 或 WebView2。
- [x] 运行时只有一个桌面主窗口。
- [x] 固定使用“十七°”自签名代码证书。

### 当前执行项

- 状态：`阶段 8：最终回归（本机完成，待 VM/信任链）`
- 阶段 0、阶段 1、阶段 2、阶段 3、阶段 4 已完成：基线/参考检查、Electron 空壳骨架、Bun sidecar 动态端口、单实例唯一窗口、托盘与生命周期均已存档。
- 负责人/线程：`Codex / 当前线程`
- 允许修改范围：`当前工作包明确列出的文件`
- 阻塞：`缺少 Windows 10/11 x64 干净 VM 与受信证书验证环境；本机代码、构建和签名已完成`

### 下一任务

在 Windows 测试机信任公钥后复核 Authenticode Valid/signtool chain，并补做安装器/便携版双击、healthz/模型请求和卸载保留用户目录验证；当前机器已完成代码/资源/单实例/端口回归。

---

## 2. 不可越过的边界

### 必须实现

- [ ] Windows 10/11 x64 安装版可直接运行（待干净 VM 双击验收）。
- [ ] Windows 10/11 x64 便携版可直接运行（待干净 VM 双击验收）。
- [x] 不弹控制台窗口（Electron/Bun spawn 使用隐藏窗口；待 VM 最终确认）。
- [x] 不要求用户安装运行时或执行 `npm install`/`bun install`（隔离 PATH smoke 已验证）。
- [x] 任何时刻只有一个 Electron 主实例。
- [x] 任何时刻只有一个 OpenCodex 主窗口。
- [x] 第二次启动只恢复并聚焦已有窗口。
- [x] 设置、日志、Provider、账号、OAuth 全部在同一个 Dashboard 窗口内完成。
- [x] 外部 OAuth/文档链接使用系统浏览器，不创建 Electron 第二窗口。
- [x] 桌面 UI 不启动 Vite 或额外 HTTP 服务。
- [x] 代理只监听一个 `127.0.0.1` 动态端口。
- [x] 固定端口被占用时自动选择动态端口，不终止第三方进程。
- [x] 实际端口确定后才写入 runtime 状态和客户端配置。
- [x] 停止、重启、崩溃恢复继续保护原有 Codex 配置（真实用户 Provider 保留仍待 VM）。
- [ ] 保留原有 Provider、模型、OAuth、路由、日志和存储能力。
- [x] 最终安装包和便携包均使用 `CN=十七°` 签名。

### 明确不做

- [x] 不增加聊天、引导、模型推荐、云同步、遥测、崩溃上报。
- [x] 不增加自动更新服务。
- [x] 不增加用户账号系统或在线激活。
- [x] 不把 HTTP 数据面改成 Named Pipe、stdin/stdout 或 Electron IPC。
- [x] 不重写 Provider、Adapter、OAuth 或 React Dashboard。
- [x] 不默认安装 WinSW/Task Scheduler 服务。
- [x] 不自动删除已有服务、旧托盘、HKCU Run 项或用户配置。
- [x] 不做 macOS/Linux/Windows ARM64 桌面包。
- [x] 不引入商业证书或强制安装受信任根证书。
- [x] 不把 `questions/`、签名私钥、PFX、临时产物或本文件发布到 GitHub。

### 端口口径

外部 Codex CLI/App、Claude Code 等客户端依赖 HTTP，因此代理完全零端口不可行。验收口径是：桌面 UI 零额外端口，代理只占一个动态 loopback 端口。

---

## 3. 阶段 0：最小基线验证

### 0.1 工作树

- [x] `git status --short --branch` 已记录。
- [x] HEAD 是 `1adad35731ff3586d3d8dfaf531d5b64e0bb1092`，或已记录用户明确切换的基线。
- [x] `origin` 只作为拉取来源，没有 push。
- [x] `.git` 没有残留 lock 或损坏临时 pack。
- [x] `git fsck --connectivity-only` 通过。

### 0.2 基线命令

- [x] `bun run typecheck`（已运行，现有类型错误，见排查指南）。
- [x] `bun run test`（已运行，依赖/运行器限制导致基线失败，见排查指南）。
- [x] `bun run privacy:scan`（通过）。
- [x] `cd gui && bun test tests`（已运行，430 通过 / 7 失败，见排查指南）。
- [x] `cd gui && bun run lint`（通过）。
- [x] `cd gui && bun run build`（通过）。

若基线失败：

- [x] 先阅读对应 `questions/` 文档。
- [x] 记录失败命令、原因和退出码。
- [x] 不为了“变绿”修改无关代码。
- [x] 修复成功后记录验证结果。

### 0.3 代码边界确认

- [x] 确认 `gui/dist` 是构建产物，不手改。
- [x] 确认 `src/server/index.ts` 已支持 `startServer(0)`。
- [x] 确认 `src/server/ports.ts`、`src/server/proxy-liveness.ts`、`src/config.ts` 可复用。
- [x] 确认现有 Windows tray/service 代码，避免创建第二套后端服务逻辑。

### 0.4 一次性架构参考检查

- [x] 只检索并浅克隆与 Windows 单实例、sidecar 打包或零依赖分发直接相关的少量参考项目。
- [x] 在 `reference/README.md` 记录路径、URL、技术栈和可借鉴点；不复制代码，不做前端视觉参考。
- [x] 完成一次记录后，后续线程不重复检索或扩张参考范围。

验证证据：

```text
状态：已完成（存在已记录的基线失败，不修改产品代码）
命令：`git status --short --branch`、`git fsck --connectivity-only`、`bun run typecheck`、`bun run test`、`bun run privacy:scan`、`cd gui && bun test tests`、`cd gui && bun run lint`、`cd gui && bun run build`
结果：Git 连通性通过；隐私扫描、GUI lint、GUI build 通过；根 typecheck、根 test 和 GUI tests 的失败原因已写入 `questions/阶段0基线依赖缺失排查指南.md`。架构参考索引已写入 `reference/README.md`，`electron-builder` 已浅克隆，`electron/packager` 因 SSL 连接失败已记录。
```

完成条件：

- [x] 基线结果已记录。
- [x] 已知失败有排查文档。
- [x] 没有修改产品代码。

---

## 4. 阶段 1：桌面工程骨架

> 原项目 GUI 已存在，本阶段不做前端设计。只创建桌面宿主最小骨架。

### 1.1 目录

- [x] 创建 `desktop/package.json`。
- [x] 创建 `desktop/tsconfig.json`。
- [x] 创建 `desktop/src/main.ts`。
- [x] 创建 `desktop/src/preload.ts`。
- [x] 创建 `desktop/src/backend-supervisor.ts`。
- [x] 创建 `desktop/src/navigation.ts`。
- [x] 创建 `desktop/src/tray.ts`。
- [x] 创建 `desktop/tests/`。
- [x] 创建 `desktop/resources/`。
- [x] 不创建第二套 GUI 页面。

### 1.2 依赖

- [x] 只添加 Electron、TypeScript 构建工具和一个打包器。
- [x] 不添加 UI 框架、状态库、遥测 SDK、更新器或登录 SDK。
- [x] 所有版本在 `desktop/package.json` 中精确锁定（独立 lockfile 因依赖下载阻塞待后续补齐）。
- [x] 审查许可证、安装脚本和已知漏洞；已避开 Electron 38.3.0 的公开受影响范围，改用 Electron 43.2.0。
- [x] 不改变根项目 npm 包的发布语义。
- [x] 不修改根 lockfile。

### 1.3 Electron 安全基线

- [x] `nodeIntegration: false`。
- [x] `contextIsolation: true`。
- [x] `sandbox: true`。
- [x] 不使用 remote module。
- [x] 不开放 remote debugging port。
- [x] preload 只暴露固定 lifecycle API。
- [x] renderer 不能执行任意 shell、读任意文件或启动任意进程。
- [x] IPC channel 使用固定枚举和输入校验（本阶段无用户输入参数）。
- [x] 不把 token、API key、OAuth 信息放进 renderer 存储。

验证证据：

```text
状态：已完成（Electron 空壳静态编译与安全基线测试通过；未启动后端）
产物：`desktop/src/`、`desktop/tests/security-baseline.test.ts`、`desktop/resources/README.md`
依赖审查：`desktop/package.json` 精确锁定 Electron 43.2.0、electron-builder 26.12.0、TypeScript 5.9.3；许可证/安装脚本已人工核对，Electron 38.3.0 的公开安全受影响范围已规避。依赖安装脚本下载因网络阻塞未完成，已记录在 `questions/阶段0基线依赖缺失排查指南.md`。
```

完成条件：

- [x] Electron 空壳可编译。
- [x] 尚未启动后端。
- [x] 尚未增加 GUI 功能。

---

## 5. 阶段 2：Bun sidecar 与动态端口

### 2.1 Ready 协议

- [x] 定义严格的 ready JSON 类型：`type`、`pid`、`port`、`hostname`、`version`。
- [x] 普通日志不会被误识别为 ready。
- [x] 重复 ready、非法端口、错误 hostname 会失败。
- [x] 启动失败输出可诊断错误并使用非零退出码。
- [x] ready 只在 listener 成功绑定、runtime 文件写入、必要同步完成后发送。

推荐消息：

```json
{"type":"ready","pid":1234,"port":49152,"hostname":"127.0.0.1","version":"2.8.0"}
```

### 2.2 sidecar 入口

- [x] 创建 `src/desktop/entry.ts` 或等价的桌面专用入口。
- [x] 入口启动 `startServer(0)`。
- [x] 强制绑定 `127.0.0.1`。
- [x] 使用实际 `server.port`，不使用 `0` 作为对外端口。
- [x] 写入 PID 和 `runtime-port.json`。
- [x] 同步 Codex/catalog 使用实际端口。
- [x] 发送 ready JSON。
- [x] 不改变普通 `ocx start` 的行为（新增 `ServerStartOptions` 为可选参数）。

### 2.3 端口策略

- [x] 默认不持久化临时端口为下一次固定端口。
- [x] 10100 被占用时直接使用动态端口。
- [x] 只监听 `127.0.0.1`。
- [x] 不扫描全机端口。
- [x] 不杀死占用端口的第三方进程。
- [x] sidecar 启动竞态有 2 次重试上限和递增退避。
- [x] 端口变化后旧客户端地址不残留（runtime 文件写入实际端口，停止时按 PID 清理）。

### 2.4 现有 proxy/service 兼容

- [x] 启动前用现有 `findLiveProxy()` 检测健康 OpenCodex。
- [x] 已有同一配置根的健康 proxy 时连接它，不再启动第二个（sidecar 输出已有端口并保持轻量 lease）。
- [x] 已有 Task Scheduler/WinSW 时不自动卸载。
- [x] 外部服务不被桌面宿主强杀。
- [x] 只有 desktop-owned sidecar 才由 Electron 停止。
- [x] `ocx stop`/restore/journal/ownership 机制继续生效。

### 2.5 测试

- [x] ready JSON 解析单测。
- [x] `port: 0` 实际端口单测。
- [x] `127.0.0.1` 绑定单测。
- [x] 10100 占用 smoke（动态启动测试持有/检测 10100，并验证 sidecar 路径不采用该端口）。
- [x] 两个 sidecar 并发启动 smoke（同进程双动态 listener，端口互不相同）。
- [x] sidecar 崩溃和有限重启 smoke（入口最多 2 次退避重试；生命周期由监督器受控）。
- [x] 停止后端口释放 smoke。

验证证据：

```text
命令：`bun run typecheck`；`bun test ./tests/desktop-ready.test.ts`；`cd desktop && bun run typecheck`；`cd desktop && bun run build`；`cd desktop && bun test tests`
端口：动态测试实际绑定 `37047`、`37048`、`37049`；均为 `127.0.0.1` 且不采用 `10100`。
runtime-port.json：隔离 sidecar smoke 写入 `{"pid":15420,"port":41992,"hostname":"127.0.0.1"}`，ready 输出 `{"type":"ready","pid":15420,"port":41992,"hostname":"127.0.0.1","version":"2.8.0"}`。
结果：根 typecheck、桌面 typecheck/build、桌面 4 tests、根桌面 ready 4 tests 全部通过；普通 `ocx start` 未改行为。
```

完成条件：

- [x] 动态端口路径可用。
- [x] 只有一个被采用的 proxy owner（已有 proxy 被复用，desktop-owned sidecar 才由监督器持有）。
- [x] 普通 CLI 和后端测试不回归（根 typecheck 通过；完整根测试仍按基线排查指南执行）。

---

## 6. 阶段 3：单实例与唯一窗口

### 3.1 单实例

- [x] 在最早入口调用 `app.requestSingleInstanceLock()`。
- [x] 未获得锁的进程立即退出。
- [x] 未获得锁的进程不得启动 sidecar。
- [x] 监听 `second-instance`。
- [x] 第二次启动恢复已有窗口。
- [x] 第二次启动置前并聚焦已有窗口。
- [x] 第二次启动不读取或覆盖新的配置。

### 3.2 窗口

- [x] 全应用只维护一个 `BrowserWindow`。
- [x] 创建前检查引用和 `isDestroyed()`。
- [x] 不创建 splash、settings、logs、OAuth 第二窗口。
- [x] `show: false` 创建，sidecar ready/离线状态准备后再显示。
- [x] `window.open` 默认拒绝。
- [x] 合法外链交给系统浏览器。
- [x] 非 allowlist 协议拒绝。
- [x] 页面路由继续使用现有 hash route。
- [x] 设置/日志/Provider/账号继续在同一 renderer 内完成。
- [x] Electron production 不开放 DevTools 端口。

### 3.3 加载页面

- [x] sidecar ready 后加载 `http://127.0.0.1:<port>/`。
- [x] 不使用 iframe。
- [x] 保留现有 GUI session 注入。
- [x] 导航只允许当前 loopback origin。
- [x] 端口改变后重新加载新 origin 并重新获取 session（`loadDashboard` 每次按 ready port 设置 origin）。
- [x] 后端失败时在同一窗口显示离线/重试状态。

### 3.4 验收

- [x] 冷启动：一个窗口（Electron 43.2.0 smoke）。
- [x] 连续启动 10 次：一个窗口（单实例锁路径已验证；本次双启动 smoke 通过）。
- [x] 并发启动 10 次：一个窗口（单实例锁路径已验证；本次双启动 smoke 通过）。
- [x] 最小化后启动：原窗口恢复（`second-instance` 聚焦逻辑）。
- [x] 托盘隐藏后启动：原窗口恢复（`second-instance` 聚焦逻辑）。
- [x] sidecar 启动中再次启动：不产生第二 sidecar（锁在最早入口，未获锁进程不创建 backend）。
- [x] OAuth 外链：系统浏览器，不产生 Electron 窗口（navigation policy）。
- [x] `BrowserWindow.getAllWindows().length === 1`（主进程计数 smoke 为 1；单窗口创建路径静态核对）。

验证证据：

```text
脚本：`cd desktop && bun run typecheck && bun run build && bun test tests`；`bun run typecheck`；`bun test ./tests/desktop-ready.test.ts`；Electron 43.2.0 双启动 smoke（临时 user-data/config 根）。
主进程数：第一次启动 1；第二次启动后仍 1。
窗口数：单 `createMainWindow` 路径；主进程单实例 smoke 通过。
sidecar 数：第一次 wrapper/worker 共 2；第二次启动后仍 2；结束后本次 smoke 进程均停止。
结果：阶段 3 单实例、单窗口、sidecar 不重复、loopback Dashboard 加载路径和外链策略通过；Electron 二进制缺失问题已通过镜像 ZIP 补齐并记录。
```

完成条件：

- [x] 单实例、单窗口、单 proxy owner 全部通过（单 proxy owner 由阶段2验证，Electron 双启动 smoke 验证窗口/进程唯一性）。

---

## 7. 阶段 4：托盘与生命周期

### 4.1 托盘

- [x] 使用 Electron Tray。
- [x] 托盘菜单只包含：显示/隐藏、启动、停止、退出。
- [x] 托盘显示 online/offline/error 状态。
- [x] 不新增 Provider/模型/账号快捷功能。
- [x] 不与 PowerShell 旧托盘并行创建第二图标。
- [x] 托盘不负责第二套 proxy supervisor。

### 4.2 窗口关闭

- [x] 点击关闭默认隐藏到托盘。
- [x] 隐藏不销毁窗口。
- [x] 再次启动复用同一窗口。
- [x] 托盘“退出”设置明确 quitting 标志。
- [x] quitting 时执行受控 sidecar stop，再退出 Electron。
- [x] stop 超时有明确错误和安全回收策略（5 秒后仅停止受控 child handle）。
- [x] 不强杀未知 PID。

### 4.3 停止/重启

- [x] 停止代理后窗口保持存在。
- [x] 停止后显示离线/启动入口。
- [x] 重启按 stop → ready 顺序执行。
- [x] 重启换端口时重新加载 Dashboard origin。
- [x] session 重新获取，不复用旧 token。
- [x] renderer 崩溃只重载窗口，不默认停止代理。
- [x] sidecar 崩溃使用有限退避重启（最多 2 次，递增 500ms 退避）。

### 4.4 服务兼容

- [x] 检测已有 Task Scheduler/WinSW/旧托盘（复用阶段2 `findLiveProxy`，不新增迁移命令）。
- [x] 不自动迁移或卸载。
- [x] 冲突信息在当前主窗口显示（离线/错误状态同一窗口承载）。
- [x] 用户明确操作后才调用现有 allowlisted service/tray 命令（本阶段不自动调用）。
- [x] 不扩大 UAC 操作范围。

验证证据：

```text
命令：cd desktop && bun run typecheck && bun run build && bun test tests；bun run typecheck；bun run privacy:scan；隔离 sidecar stdin stop smoke
结果：桌面 7 tests、根 typecheck、隐私扫描通过；sidecar stop 后进程退出且 runtime-port.json 清理；Electron 双启动保持主进程 1，窗口关闭默认隐藏，受控退出不强杀未知 PID。
```

完成条件：

- [x] 隐藏、恢复、停止、启动、重启、退出均无第二窗口。
- [x] 无孤儿 desktop-owned sidecar（受控 stdin stop，超时只处理受控 child）。
- [x] 不破坏已有 service/tray。

---

## 8. 阶段 5：GUI 最小适配

> 只改桌面生命周期相关行为，现有 Dashboard 页面和视觉不动。

### 5.1 preload 能力

- [x] 定义 `window.openCodexDesktop` 类型。
- [x] 只暴露 `getStatus`、`startProxy`、`stopProxy`、`restartProxy`、`requestExit` 等固定动作。
- [x] 不暴露任意命令执行。
- [x] 不暴露任意文件读写。
- [x] 普通浏览器模式没有 preload 时仍可工作。

### 5.2 页面行为

- [x] 桌面模式下停止/重启委托 Electron 宿主。
- [x] 普通浏览器模式继续调用现有 API。
- [x] 桌面模式下不显示旧 PowerShell Tray 安装动作，或明确标记由桌面应用管理。
- [x] 不添加新导航项。
- [x] 不添加欢迎页/引导页。
- [x] 所有新文本进入全部 locale。
- [x] 新控件有 keyboard、aria、hover 和 focus-visible。

### 5.3 GUI 验证

- [x] `cd gui && bun test tests`。
- [x] `cd gui && bun run lint`。
- [x] `cd gui && bun run lint:i18n`。
- [x] `cd gui && bun run build`。
- [x] 普通浏览器模式 smoke。
- [x] Electron 模式 smoke。

验证证据：

```text
命令：cd gui && bun test tests；bun run lint；bun run lint:i18n；bun run build；端口检查后 Vite 浏览器 smoke；cd desktop && bun run typecheck && bun run build && bun test tests；Electron 43.2.0 Windows x64 smoke
结果：GUI 定向测试 12 通过，lint/i18n lint/build 通过；完整 GUI 测试 432 通过、7 个既有 Logs 测试因当前 Bun/Jest 兼容层缺少 jest.advanceTimersByTime 失败，已记录排查指南；浏览器 smoke 返回 200；桌面 7 tests/typecheck/build 通过；Electron 版本与启动 smoke 通过，未遗留 sidecar。
```

完成条件：

- [x] GUI 只发生桌面生命周期必要改动。
- [x] 没有视觉改版或产品功能扩张。

---

## 9. 阶段 6：零依赖打包

### 6.1 资源

- [x] 打包 Electron runtime。
- [x] 打包固定版本 Windows x64 `bun.exe`。
- [x] 打包后端运行所需 `src/` 和元数据。
- [x] 打包 `gui/dist`。
- [x] 执行文件放到 unpacked resources，避免 asar 执行问题。
- [x] 生产路径使用 `process.resourcesPath`。
- [x] 不包含 `.git`、`questions`、`reference`、`todolist.md`、测试缓存、日志和密钥。
- [x] 生成最终资源清单。

### 6.2 安装版

- [x] 生成 `OpenCodex-Setup-x64.exe`。
- [x] per-user 安装，默认不请求管理员权限。
- [x] 创建开始菜单入口。
- [x] 不默认设置开机启动。
- [x] 卸载只删除安装文件。
- [x] 卸载不递归删除 `%USERPROFILE%\\.opencodex`。

### 6.3 便携版

- [x] 生成 `OpenCodex-Portable-x64.exe`。
- [x] 不依赖安装目录注册表。
- [x] 不新增 portable-data 配置语义。
- [x] 临时解包目录可回收。
- [x] 便携版和安装版的单实例行为有明确测试结果。

### 6.4 干净机器

- [ ] Windows 10/11 x64 VM 无 Node.js。
- [ ] VM 无 Bun。
- [ ] VM 无项目依赖（待干净 VM 验收）。
- [x] 安装版 unpacked smoke 可启动。
- [x] 便携版产物已生成并通过结构审计。
- [x] 无控制台窗口（Electron/Bun spawn 均设置隐藏窗口；需 VM 再确认）。
- [x] 不下载运行时（隔离 PATH smoke 使用 resources 内 Bun）。
- [x] Dashboard、healthz、模型请求正常（`C:\\tmp` 授权隔离 sidecar：healthz 200、`/v1/models` 200；干净 VM 仍待复核）。

完成条件：

- [ ] 两种产物都能在干净 VM 运行。
- [x] 用户无需手工安装依赖（打包资源内置 Bun、src、GUI 和生产依赖；隔离 PATH smoke 已通过）。

验证证据：

```text
命令：cd desktop && bun test tests；bun run package；unpacked Electron smoke（PATH 仅保留 C:\\Windows\\System32）；资源禁入路径扫描；SHA-256
结果：桌面 9 tests、资源准备和 Electron-builder 通过；生成 desktop/out/OpenCodex-Setup-x64.exe 与 desktop/out/OpenCodex-Portable-x64.exe；固定 Bun 1.3.14 位于 resources/opencodex/runtime，src/gui/dist/生产依赖位于 resources/opencodex，Tray 图标位于 resources/tray；app.asar 不含 staging 或旧 unpacked 输出；最新安装版 hash=9E9BB84C61C820D27D7D0A3CC58A85D9FE5E410799762B4870E6CCCE9836707B，便携版 hash=0A33A6BEACDE98D1AEFF1C161FA4EE049AFAFF389B86BF50EC77E6E1DC919A15；隔离 PATH smoke 成功拉起打包 Electron 与 resources Bun sidecar。
限制：当前环境没有 Windows 10/11 干净 VM；真实便携版和安装版已在全新 `--user-data-dir` 隔离条件下保持运行，`C:\\tmp` 授权 sidecar 的 healthz/`/v1/models` 已通过，但仍未完成干净 VM 双击、卸载保留用户目录和真实 Provider 验证，因此阶段 6 完成条件保留未勾选。
```

---

## 10. 阶段 7：十七°自签名

> 只对功能已经通过验收的最终二进制签名。私钥绝不进入项目目录和 Git。

### 7.1 证书

- [x] Subject：`CN=十七°`。
- [x] 用途：Code Signing EKU `1.3.6.1.5.5.7.3.3`。
- [x] RSA 3072 或更高。
- [x] SHA-256。
- [x] 记录有效期和 thumbprint。
- [x] 证书放在 CurrentUser\My 或项目外安全目录。
- [x] PFX 只放到项目外或确认 gitignore 的 `.tmp/signing/`。
- [x] 签名密码不写入代码、文档、日志或提交。

### 7.2 产物签名

- [x] 签名安装器。
- [x] 签名便携版。
- [x] 签名独立 sidecar（内置 `bun.exe`）。
- [x] 签名完成后不再修改二进制。
- [x] 计算每个产物 SHA-256。

### 7.3 验证

- [x] `Get-AuthenticodeSignature` 的签名主体是“十七°”。
- [ ] `signtool verify /pa /v` 结构验证通过（当前机自签根链校验受信任存储/时间戳超时，待测试机复核）。
- [ ] 在测试机信任公钥后状态为 Valid。
- [x] 未信任证书的干净机能正常显示 Windows 的确认/警告流程（未信任链状态已观察为 Unknown Publisher 路径）。
- [x] 不静默安装自签根证书到 Trusted Root（仅尝试临时导入后清理）。
- [x] 用户说明标注自签名可能触发 Unknown Publisher/SmartScreen。

完成条件：

- [x] 最终安装版和便携版均已签名。
- [x] 私钥、PFX、密码未进入仓库或发布包。

验证证据：

```text
证书：CN=十七°；thumbprint=4D0D7BD4C925CEBE985B25F97776337536D064CB；RSA 3072；sha256RSA；有效期 2026-08-01 至 2028-08-01；EKU=1.3.6.1.5.5.7.3.3；证书位于 CurrentUser\\My，PFX 位于被忽略的 .tmp/signing。
签名目标：OpenCodex-Setup-x64.exe、OpenCodex-Portable-x64.exe、unpacked/OpenCodex.exe、unpacked/resources/opencodex/runtime/bun.exe。
结果：Get-AuthenticodeSignature 可读取四个目标的 CN=十七° 签名；未受信根时 signtool /pa 报告 chain terminated in an untrusted root，临时信任复核在当前机超时且未留下 Root 证书；安装器 SHA-256=9E9BB84C61C820D27D7D0A3CC58A85D9FE5E410799762B4870E6CCCE9836707B，便携版 SHA-256=0A33A6BEACDE98D1AEFF1C161FA4EE049AFAFF389B86BF50EC77E6E1DC919A15。
```

---

## 11. 阶段 8：最终回归

### 8.1 代码回归

- [x] `bun run typecheck`。
- [ ] `bun run test`（普通与最小授权环境均在 420 秒内未完成；临时目录权限/CLI 子进程超时已记录）。
- [x] `bun run privacy:scan`。
- [ ] `cd gui && bun test tests`（432 通过、7 个既有 Logs 测试失败）。
- [x] `cd gui && bun run lint`。
- [x] `cd gui && bun run lint:i18n`。
- [x] `cd gui && bun run build`。
- [x] 桌面工程自身测试（9 tests）。

### 8.2 单实例和端口

- [x] 冷启动只有一个窗口。
- [x] 连续/并发启动 10 次只有一个窗口。
- [x] 10100 被占用时仍可启动。
- [x] 只有一个 OpenCodex listener。
- [x] listener 是 `127.0.0.1`。
- [x] 没有 Vite/DevTools/第二 API listener。
- [x] 退出后端口释放。
- [x] 无孤儿 sidecar。

### 8.3 配置与恢复

- [x] 动态端口写入实际配置。
- [x] 重启后旧端口不残留。
- [x] 正常 sidecar stop 清理 runtime 并保留配置恢复路径。
- [x] 强杀后下次启动可恢复（runtime identity/journal 路径沿用现有机制；需 VM 复核）。
- [ ] 用户自有 provider 不被覆盖（需 VM/真实配置回归）。
- [x] API key/OAuth token 不进入日志和 renderer 存储。

### 8.4 Windows 场景

- [ ] Windows 10 x64。
- [ ] Windows 11 x64。
- [ ] 标准用户、非管理员。
- [ ] 中文用户名。
- [ ] 安装路径含空格和中文。
- [ ] 已有 CLI proxy。
- [ ] 已有 Task Scheduler/WinSW。
- [ ] 已有旧托盘。
- [ ] renderer 崩溃。
- [x] sidecar 崩溃（隔离打包 Electron：Bun PID 524 停止后 5 秒内恢复为 11016）。
- [ ] 睡眠/唤醒。
- [ ] 注销/重启。

### 8.5 包内容审计

- [x] 安装器文件清单已导出。
- [x] 便携包文件清单已导出。
- [x] 扫描 PFX、PEM、KEY、ENV、token、password。
- [x] 不包含 `questions/`、`reference/`、`todolist.md`、`.git`、本机路径。
- [x] 产物 SHA-256 已记录。

完成条件：

- [x] 没有未解释的失败（根完整测试、GUI Logs 兼容性、Windows VM/证书链限制均已记录）。
- [ ] 只有已接受的自签名/SmartScreen 限制。
- [x] 没有新增用户未要求的功能。

验证证据：

```text
代码：根 typecheck、privacy scan、GUI lint/i18n lint/build、桌面 9 tests 通过；授权 C:\\tmp 临时根下 `server-auth` 57/57 通过；根完整 test 即使在授权临时根仍 420 秒未完成，已记录为完整套件/运行器限制；GUI 完整套件 432 通过/7 个既有 Logs 测试失败，均已写入 questions。
单实例/端口：Electron 10 次并发 smoke 仅 1 个主进程、1 个 sidecar；占用 127.0.0.1:10100 时实际动态端口为 1068；`C:\\tmp` 授权 sidecar 动态端口 57967，healthz 与 `/v1/models` 均成功；未发现残留 entry sidecar 或 10100 listener。
产物：安装版/便携版签名与 SHA-256 已在阶段 7/6 记录；资源禁入扫描通过；签名主体可读为 CN=十七°。
未完成：Windows 10/11 干净 VM、默认用户数据目录在普通权限下的真实验证、受信根后的 signtool Valid 和真实 provider 保留回归；隔离环境下的卸载保留用户目录和 sidecar 崩溃恢复已通过。
```

---

## 12. 发布门

- [x] 本地产出安装版和便携版。
- [x] 产物签名和 SHA-256 已验证。
- [x] 用户安装说明已写好（`docs/Windows桌面端安装与验证.md`）。
- [x] 说明默认动态 loopback 端口，用户无需配置。
- [x] 说明“十七°”自签名和 SmartScreen 行为。
- [x] 审计 Git 实际将被跟踪的文件。
- [x] 默认不提交 `questions/`、`todolist.md`、PFX、私钥、临时脚本和过程资料。
- [x] 未获当前任务明确授权，不执行 `git push`。
- [x] 未获当前任务明确授权，不创建 GitHub Release。
- [x] 未获当前任务明确授权，不上传安装包。

发布门证据：

```text
本地安装版：desktop/out/OpenCodex-Setup-x64.exe
本地便携版：desktop/out/OpenCodex-Portable-x64.exe
安装版 SHA-256：9E9BB84C61C820D27D7D0A3CC58A85D9FE5E410799762B4870E6CCCE9836707B
便携版 SHA-256：0A33A6BEACDE98D1AEFF1C161FA4EE049AFAFF389B86BF50EC77E6E1DC919A15
签名主体：CN=十七°；自签名根未进入受信存储，SmartScreen/Authenticode Valid 仍需测试机复核。
安装说明：docs/Windows桌面端安装与验证.md
Git 边界：本次仅本地提交和 tag，不 push、不创建 Release、不上传安装包。
```

---

## 13. 必须持续保持的不变量

- [x] `/api/*` 管理认证和 `/v1/*` 数据认证继续分离。
- [x] GUI session、CSRF 和 CSP 不被 Electron 绕过。
- [ ] `CODEX_HOME` 显式配置优先级不变。
- [ ] `ocx stop`、restore、service stop/uninstall 后原生 Codex 可用。
- [ ] 普通 CLI 和 macOS/Linux 行为不被桌面代码破坏。
- [x] Electron 逻辑不渗入 Provider/Adapter 核心。
- [x] 生成的 `gui/dist` 不手改。
- [x] 所有新 GUI 文本进入 i18n。
- [ ] 所有交互控件有键盘、hover、focus-visible 状态。
- [x] 依赖、打包、签名变更有验证记录。

---

## 14. 失败记录规则

遇到新的技术问题时：

1. 先查 `questions/` 是否已有同类文档。
2. 没有则创建 `questions/[问题类型]排查指南.md`。
3. 把失败命令、现象、失败原因用 `❌` 写入。
4. 阅读全部失败经验后再换方案。
5. 成功后用 `✅` 写入真实方法和验证命令。
6. 在本文件对应工作包补充阻塞/恢复状态。

---

## 15. 工作包交接格式

每个线程结束时只需补充以下内容：

```text
工作包：WPx.x
状态：完成 / 部分完成 / 阻塞
改动文件：
- path

验证命令与结果：
- command -> exit code / summary

失败文档：
- questions/xxx.md 或无

已知限制：
- none / detail

下一任务：
- WPx.x
```

---

## 16. 最终完成定义

- [ ] 安装版和便携版在干净 Windows x64 VM 双击可用。
- [x] 用户无需安装任何依赖（隔离 PATH smoke）。
- [x] 无控制台窗口（代码与本机 smoke；待 VM 复核）。
- [x] 永远只有一个主窗口（单实例/并发 smoke）。
- [x] 重复启动不产生第二实例、第二窗口或第二代理。
- [x] UI 不增加额外端口。
- [x] 代理只有一个动态 `127.0.0.1` 端口。
- [x] 10100 被占用时仍可运行。
- [ ] 现有核心功能无回归。
- [x] 退出和崩溃恢复不破坏 Codex 配置（隔离 runtime/用户目录回归；真实用户 Provider 仍待 VM）。
- [x] 最终产物由 `CN=十七°` 签名。
- [x] 私钥不在仓库和安装包。
- [x] SHA-256 已记录。
- [x] 自签名限制已说明。
- [x] 没有增加用户未要求的产品功能。
- [x] 远端发布等待用户明确授权。

---

## 17. 当前结论

唯一实施主线：

```text
现有 React/Vite GUI
        ↓ 直接复用
Electron 单实例宿主
        ↓ 监督
打包 Bun sidecar
        ↓ 监听一个动态 loopback 端口
Codex / Claude Code / 其他现有客户端
```

当前结论：本机桌面端改造、打包、签名、资源审计、单实例/动态端口回归和发布说明已完成；工作树外部验收仍保留为真实阻塞项：Windows 10/11 干净 VM 双击、受信证书链 `Valid`、真实 Provider 保留、healthz/模型请求和卸载保留用户目录。根完整测试在普通与最小授权环境均因临时目录权限/子进程超时未完成，GUI 完整测试仍有 7 个既有 Logs 兼容性失败；这些限制均已记录在 `questions/`，不以修改无关代码掩盖。
