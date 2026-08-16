# OpenCodex Windows 桌面端改造方案

> 规划日期：2026-08-01  
> 基线仓库：`canyexuanfan/opencodex-Windows-desktop`  
> 基线提交：`1adad35731ff3586d3d8dfaf531d5b64e0bb1092`

## 1. 目标与硬性约束

桌面版需要满足以下验收标准：

1. 用户下载安装包或便携版后即可运行，不要求预装 Node.js、Bun、Rust、Python、WebView2 SDK 或其他开发依赖。
2. 应用不弹出命令行窗口。
3. 任意时刻只存在一个桌面应用实例、一个主窗口和一个受该实例管理的代理进程。
4. 第二次启动应用时，不创建第二个窗口或第二个代理进程，只恢复、置前并聚焦已有窗口。
5. 桌面 UI 不额外监听端口。
6. 代理只绑定 `127.0.0.1`，默认请求 Windows 分配一个动态空闲端口；端口确定后再同步 Codex、Claude Code 等客户端配置。
7. 固定端口被占用时不结束启动、不终止占用端口的其他程序，自动改用动态空闲端口。
8. 关闭窗口默认最小化到系统托盘；只有“退出 OpenCodex”才执行受控退出和配置恢复。
9. OAuth、设置、日志、更新等交互都在同一个主窗口内完成；需要访问第三方登录页时打开系统默认浏览器，不创建第二个应用窗口。
10. 卸载、停止或异常退出不得破坏用户原有 Codex 配置；继续沿用现有 journal、ownership manifest 和原子写入机制。

## 2. 当前项目评估

当前代码不是纯 Web 项目，而是一个已经具备 Windows 能力的本地代理：

- 后端是 Bun 原生 TypeScript，入口为 `src/cli/index.ts`，HTTP 服务由 `src/server/index.ts` 提供。
- 前端是 React + Vite Dashboard，构建产物由同一个 Bun HTTP listener 提供。
- 数据面包含 `/v1/responses`、`/v1/messages`、`/v1/chat/completions` 等接口；外部 Codex/Claude 客户端必须通过 HTTP 访问它。
- 管理面使用 `/api/*`，与数据面凭据隔离；本地 Dashboard 使用同源、短时、内存态 GUI session。
- Windows 已有 Task Scheduler/WinSW 后台运行、PowerShell WinForms 托盘、PID、`runtime-port.json`、端口身份检查和配置恢复能力。
- 现有端口模块已经支持 `port: 0` 和回退到 ephemeral port，但 CLI 的显式 `--port 0` 目前会被拒绝，且普通启动仍采用“先探测、再绑定”的方式。

因此，不建议重写代理、Provider、OAuth 或 Dashboard。改造核心应是新增桌面宿主，把现有能力收拢到一个可安装、可托盘驻留、可管理后端进程的单实例 Windows 应用中。

## 3. 关于“完全不占用端口”

完全零端口不适合作为本项目目标。

Codex CLI/App、Claude Code、GitHub Copilot App 等外部进程按 HTTP API 调用 OpenCodex。若改成 Windows Named Pipe、stdin/stdout 或 Electron IPC，外部客户端将无法直接连接，除非同时修改每一个客户端。因此可行且兼容的边界是：

- 桌面 UI：不新增监听端口；
- 代理数据面和管理面：共用一个 `127.0.0.1` 动态端口；
- 不监听局域网地址，不占用固定端口，不弹 Windows 防火墙公网访问提示；
- 用户无需知道或手工配置端口。

## 4. 技术选型

### 推荐：Electron + 打包的 Bun 代理 sidecar

首版选择 Electron，原因如下：

- Electron 自带 Chromium 和 Node.js，用户机器不依赖系统 WebView2 或 Node.js。
- 现有 React Dashboard 可以直接复用，不需要重写为原生控件。
- Electron 原生支持单实例锁、主窗口、系统托盘、深链接、系统浏览器和 Windows 安装包。
- Bun 代理可作为应用资源随包分发，用户不需要单独安装 Bun。
- BrowserWindow 可以直接加载代理提供的 loopback Dashboard，继续使用项目现有同源 GUI session，不需要放宽管理 API 安全边界。

不优先采用 Tauri：它的运行体积通常更小，但 Windows UI 默认依赖 WebView2。若为满足“绝对零依赖”而附带固定 WebView2 Runtime，再加上 Bun sidecar，构建复杂度和安装体积优势会明显降低。

### Bun 后端的两阶段打包

MVP 先采用可靠方案：将已锁定版本的 `bun.exe`、后端源文件和 `gui/dist` 作为 Electron resources 打包，Electron 主进程以隐藏窗口方式启动 Bun sidecar。

稳定后再验证优化方案：使用 `bun build --compile --target=bun-windows-x64-baseline --windows-hide-console` 生成独立的 `opencodex-core.exe`。只有动态 import、Worker、静态资源、更新器和跨进程测试全部通过后，才替换 MVP sidecar 形态。

## 5. 目标架构

```text
Windows 用户
   │
   ▼
OpenCodex Desktop.exe
   ├─ 单实例锁
   ├─ 唯一 BrowserWindow
   ├─ Electron Tray
   ├─ 后端进程监督与崩溃恢复
   └─ 外部链接 / 自动启动 / 更新入口
            │
            ├── 启动或复用
            ▼
     OpenCodex Bun sidecar
       127.0.0.1:动态端口
       ├─ React Dashboard
       ├─ /api/* 管理面
       └─ /v1/* 数据面
            ▲
            │
   Codex CLI/App、Claude Code 等客户端
```

BrowserWindow 加载 `http://127.0.0.1:<实际端口>/`，不是 iframe。这样可以继续满足当前 `X-Frame-Options: DENY`、`frame-ancestors 'none'`、同源 session 和 CSRF 设计。

## 6. 单实例与单窗口设计

1. Electron 主进程在 `ready` 之前调用 `app.requestSingleInstanceLock()`。
2. 未获得锁的进程立即退出，不启动 sidecar，不创建窗口。
3. 主实例监听 `second-instance`：若窗口最小化则恢复，若隐藏则显示，然后置前、聚焦。
4. 全应用只允许一个 `BrowserWindow`。设置、日志、Provider、OAuth 状态等继续使用当前 hash route 和页面内 modal。
5. 拦截 `window.open`：OAuth/文档链接交给系统默认浏览器，拒绝创建新的 Electron 窗口。
6. 主窗口先以 `show: false` 创建，等后端健康且页面 `ready-to-show` 后再显示，避免白屏和第二个启动占位窗口。
7. 关闭按钮默认隐藏主窗口并保留托盘；托盘“退出”才进入完整退出流程。

## 7. 动态端口与后端启动设计

### 启动流程

1. 读取 `runtime-port.json` 和 PID，通过现有 `/healthz` 身份校验判断是否已有同一配置根拥有的代理。
2. 如果存在兼容且归本应用所有的代理，直接连接，不重复启动。
3. 否则以桌面模式启动 sidecar，并直接让 Bun listener 使用 `port: 0` 原子绑定动态端口。
4. sidecar 绑定成功后输出一行机器可读 ready 消息，例如：

   ```json
   {"type":"ready","pid":1234,"port":49152,"hostname":"127.0.0.1"}
   ```

5. sidecar 写入 `runtime-port.json`，再用实际端口同步 Codex/Claude/Grok 配置。
6. Electron 使用实际端口探测 `/healthz`；身份、PID、版本均匹配后才加载主窗口。

直接绑定 `port: 0` 比“先找空闲端口、关闭探测 socket、再绑定”更可靠，消除了其他进程在探测与绑定之间抢占端口的竞态。

### 端口策略

- 桌面模式默认始终动态，不把临时端口持久化为下一次必须使用的固定端口。
- 每次启动都允许获得不同端口，并以 `runtime-port.json` 为实时真相。
- 固定端口仅保留给高级用户兼容模式，不作为桌面默认设置。
- 只绑定 `127.0.0.1`；桌面模式不允许配置为 `0.0.0.0` 或局域网地址，除非未来提供单独的高级安全开关。
- 不杀死占用端口的第三方进程，不使用全盘端口扫描。

## 8. 进程生命周期

### 正常运行

- Electron 是用户可见宿主，Bun sidecar 是受监督子进程。
- renderer 崩溃：保留代理，重新加载唯一窗口。
- sidecar 崩溃：窗口进入“代理已停止”状态，采用有上限的退避策略重启；禁止无限快速循环。
- 第二次启动：只唤醒已有窗口。

### 关闭与退出

- 点击窗口关闭：隐藏到托盘，代理继续运行。
- 托盘“停止代理”：调用现有受控 stop/restore 流程，窗口保留并显示离线/可重启状态。
- 托盘“退出 OpenCodex”：停止由桌面宿主管理的 sidecar、恢复原生 Codex 配置、等待进程退出，再退出 Electron。
- Windows 注销/关机：不能只依赖 Electron `before-quit`。应保留现有 journal，确保下次启动能够识别并修复未完成的恢复事务。

### 与现有 Windows 服务/托盘的关系

- 桌面版安装后，Electron Tray 取代 PowerShell WinForms Tray，避免两个托盘图标和两个生命周期所有者。
- Task Scheduler/WinSW 作为高级“无 UI 后台服务模式”保留，但桌面模式和服务模式必须显式互斥或采用“桌面连接已有服务”的单一所有者模型。
- 安装迁移时只处理项目自己拥有并能验证身份的任务、服务和 HKCU Run 项；不覆盖外部同名项。

## 9. 安全边界

Electron 窗口配置：

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- preload 只暴露最小能力，例如读取桌面状态、请求隐藏/退出、打开经过校验的外部 URL。
- 禁止 renderer 直接执行 shell、读任意文件或启动任意进程。
- 导航仅允许当前 `127.0.0.1:<实际端口>`；其他 HTTP(S) URL 经过 allowlist 后交给系统浏览器。
- 保留现有管理面 session、CSRF、数据面/管理面凭据隔离，不为 Electron 增加 loopback 免认证后门。
- API Key、OAuth token、账户信息继续由后端保存；不进入 Electron localStorage、日志、崩溃报告或 IPC payload。

## 10. 建议目录与改动范围

```text
desktop/
  package.json
  src/main.ts              # 单实例、唯一窗口、托盘、应用生命周期
  src/backend-supervisor.ts# sidecar 启停、ready 协议、健康检查、退避
  src/navigation.ts        # 导航和外部 URL 策略
  src/preload.ts           # 最小 contextBridge
  resources/               # 图标、安装资源
  builder/                 # NSIS/portable 打包配置

src/desktop/
  entry.ts                 # 桌面 sidecar 专用入口/ready 协议
  lifecycle.ts             # 桌面宿主与代理生命周期适配
```

对现有代码的主要改造点：

- `src/cli/index.ts`：避免把动态端口硬编码为 CLI 固定端口；桌面启动走专用入口或允许安全的 `--port 0`。
- `src/server/index.ts`：继续支持 `startServer(0)`，把实际端口作为 ready 状态返回给宿主。
- `src/config.ts`、`src/server/proxy-liveness.ts`：明确 desktop-owned runtime identity 和动态端口真相。
- `src/tray/`：保留 CLI fallback；桌面安装时不再并行启动旧 PowerShell 托盘。
- `gui/`：增加极小的桌面能力检测；停止、重启、外部链接在桌面模式下委托宿主。所有新增可见文本进入全部 locale，所有可交互组件补齐 hover/focus-visible。
- `scripts/` 与 CI：新增桌面构建、打包、无依赖 VM smoke、签名和产物校验，不改动现有 npm 发布线的语义。

## 11. 安装与发布形态

首版同时产出：

1. `OpenCodex-Setup-x64.exe`：推荐给普通用户，按用户安装，不要求管理员权限；创建开始菜单入口，可选开机启动。
2. `OpenCodex-Portable-x64.exe`：便携单文件入口，运行时解包到受控临时目录；配置仍默认保存在 `%USERPROFILE%\.opencodex`，除非未来明确提供真正 portable data mode。

安装包内包含 Electron、应用代码、Dashboard 构建产物和 Bun sidecar，因此最终用户不需要执行 `npm install` 或 `bun install`。正式分发前应增加 Windows Authenticode 签名；未签名构建可用于内部测试，但会触发 SmartScreen。

## 12. 分阶段实施计划

### 阶段 A：桌面 MVP 骨架（2～3 天）

- 新建 `desktop/` 工程和打包配置。
- 实现单实例锁、唯一 BrowserWindow、外部链接拦截、Electron Tray。
- 用现有 Bun runtime + 源文件作为 sidecar 启动。
- 使用动态端口加载现有 Dashboard。

验收：连续双击 10 次始终只有一个主窗口、一个 Electron 主实例、一个代理 listener。

### 阶段 B：生命周期与配置安全（3～5 天）

- 增加 sidecar ready 协议、身份校验和有界重启。
- 打通动态端口写入、Codex 配置同步、停止与恢复。
- 处理已有 CLI proxy、Task Scheduler、WinSW 和旧托盘的迁移/连接场景。
- 增加窗口隐藏、托盘恢复、Windows 注销/异常退出恢复。

验收：端口 10100 被第三方程序占用时仍正常启动；退出后原生 Codex 可用；无孤儿代理。

### 阶段 C：零依赖安装包（2～3 天）

- 生成 NSIS 安装版和便携版。
- 验证路径包含空格、中文用户名、非管理员账户、无 Node/Bun 的干净 Windows VM。
- 隐藏控制台窗口，完善图标、卸载、开机启动和日志入口。

验收：干净 VM 双击即用，不下载运行时，不要求命令行操作。

### 阶段 D：加固与发布（3～5 天）

- 完成 Electron 安全基线、依赖审计、隐私扫描、签名流程。
- 增加安装升级、降级、崩溃恢复、休眠唤醒、多用户和杀进程测试。
- 评估 Bun standalone core；只有完整回归通过后切换。

预计首个可用 MVP 为 1～2 周，达到可公开分发质量约 2～3 周。

## 13. 必测场景

1. 干净 Windows 10/11 x64，无 Node、Bun 和开发工具。
2. `10100` 被第三方程序占用。
3. 同时启动 2、5、10 个应用进程。
4. 主窗口已最小化、已隐藏到托盘、已无响应时再次启动。
5. renderer 崩溃、Bun sidecar 崩溃、强制结束 Electron、Windows 注销/重启。
6. 现有 CLI proxy 正在运行；现有 Task Scheduler/WinSW 已安装；旧托盘正在运行。
7. 用户名和安装路径含中文、空格、括号。
8. OAuth 登录取消、超时、系统浏览器回跳。
9. 代理停止/重启后 GUI session 失效并自动重新引导。
10. 卸载后未知用户文件保留，OpenCodex 拥有的配置改动被恢复。
11. 只存在一个 loopback listener；没有 UI dev server、Vite port 或额外 IPC TCP port。
12. 新增按钮、导航、卡片、列表、输入和工具栏控件均有 hover 与 focus-visible 状态。

## 14. MVP 不做的事情

- 不把 HTTP 数据面改写成 Named Pipe；这会破坏外部客户端兼容性。
- 不重写 Provider、OAuth、路由或 React Dashboard。
- 不在首版默认安装系统级 WinSW 服务或申请管理员权限。
- 不把 API Key、OAuth token 搬进 Electron 存储。
- 不在未完成真实 Windows VM 验证前宣称 Bun standalone core 可替代当前运行方式。

## 15. 推荐结论

以“Electron 单实例宿主 + 现有 React Dashboard + 打包 Bun sidecar”为主线。桌面 UI 不额外占用端口，代理仅使用一个系统动态分配的 loopback 端口；启动时最多出现一个主窗口，重复启动只唤醒已有窗口。该方案对现有代码侵入最小，最符合零依赖、单窗口、动态端口和配置安全四个核心要求。
