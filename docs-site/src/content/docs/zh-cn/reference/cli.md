---
title: CLI 参考
description: 所有 ocx 命令与参数。
---

opencodex 的命令行工具是 `ocx`。运行 `ocx help`（或 `--help` / `-h`）可查看顶层用法。
对帮助表中注册的命令，可运行 `ocx help <command>` 查看命令专属帮助。帮助和版本命令均为只读，
不会启动、停止、安装、卸载或改写 Codex/opencodex 状态。

## 安装与生命周期

### `ocx init`

交互式设置向导。它会依次询问 provider（预设或自定义）、API key（字面值或 `${ENV}`）、默认模型
和代理端口，保存 `~/.opencodex/config.json`，并可选择把代理注入
`$CODEX_HOME/config.toml`（默认 `~/.codex/config.toml`），以及安装 Codex 自动启动 shim。

### `ocx start [--port <port>]`

启动代理服务器（首选端口 `10100`）。如果该端口已被占用，opencodex 会选择并记录另一个可用
端口。它会写入 PID/运行时端口状态，并拒绝启动第二个仍存活的实例。启动时会把各 provider 的
模型同步进 Codex 目录。关闭时会恢复原生 Codex，除非它以受管服务运行（`OCX_SERVICE=1`）。

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

按 PID 停止正在运行的代理，删除 PID 文件并恢复原生 Codex。如果已安装受管后台服务，
`ocx stop` 会先停止服务，以免它重新拉起代理。Web 仪表盘的 **Stop** 按钮
（`POST /api/stop`）执行相同操作。

### `ocx restore` &nbsp;·&nbsp; `ocx eject`

在**不停止**代理的情况下恢复原生 Codex。它会删除注入的配置行和路由目录条目，使普通
`codex` 再次按原生方式工作。`eject` 是 `restore` 的别名。

给任一写法加上 `back`，可在不改变代理生命周期的情况下，让普通 `codex` 重新指向已经运行的
代理：

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai`

显式恢复旧开发构建留下的历史记录；这些构建在支持可逆备份前就已重映射 Codex App 历史。
如果历史数据库被锁定，请先关闭 Codex。

### `ocx restart`

依次运行 `stop` 和 `ensure`：停止代理/服务，恢复原生 Codex，在后台启动代理，再把实际端口同步
回 Codex。

### `ocx ensure`

以幂等方式确保后台代理正在运行，然后同步其实时模型目录。如果 `codexAutoStart` 为 `false`，
命令只会提示自动启动已禁用，不执行其他操作。

### `ocx status [--json]`

打印只读诊断摘要：代理 PID、`/healthz` 可达性、仪表盘 URL、配置路径、默认 provider、Codex
自动启动设置、服务状态和 shim 状态。

使用 `--json` 可获得机器可读的只读诊断契约：

```bash
ocx status --json
```

下面是精简后的对象形状：

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

实际对象还包含 `listen`（端口、hostname、运行时/配置来源）、配置加载诊断和内置 Codex plugin
诊断。JSON schema 只允许增加字段：后续版本可能添加字段，但现有字段应保持稳定。它会有意排除
API key、OAuth token、authorization header、请求内容、电子邮件和账号身份信息。

### `ocx health [--json]`

验证当前代理的身份。普通输出报告 PID/端口；`--json` 输出 `{ok, pid, port}`。只有健康时才以
0 退出，否则以 1 退出，因此适合作为服务探针。

### `ocx uninstall` &nbsp;·&nbsp; `ocx remove`

停止服务和代理，移除服务与 Codex shim，恢复原生 Codex；只有所有恢复步骤成功后，才删除
opencodex 本地配置。`remove` 是 `uninstall` 的别名。

## 模型与 Codex

### `ocx sync`

从所有已配置 provider 获取实时模型列表，并把合并后的目录重新注入 Codex。添加 provider 后或
需要刷新可用模型时运行。

### `ocx sync-cache`

使 Codex 的本地模型选择器缓存失效，随后用当前 opencodex 目录重新构建。

### `ocx v2 [subcommand]`

管理 Codex 的 `multi_agent_v2` feature flag 和三态 multi-agent surface mode。

| Subcommand | Action |
| --- | --- |
| `status`（默认） | 报告当前 v2 flag、multi-agent mode 和 thread concurrency。 |
| `on` | 在 `$CODEX_HOME/config.toml` 中启用 `multi_agent_v2` feature，并重新同步目录。 |
| `off` | 禁用 `multi_agent_v2` feature，并重新同步目录。 |
| `mode v1` | 强制所有模型使用 v1 multi-agent surface（覆盖 upstream pin）。 |
| `mode default` | 遵循 upstream model pin（sol/terra=v2，luna=v1，其余模型跟随 Codex flag）。这是安装默认值。 |
| `mode v2` | 强制所有模型使用 v2 multi-agent surface（覆盖 upstream pin）。 |
| `threads <n>` | 设置 `max_concurrent_threads_per_session`（大于等于 1 的整数，仅限 v2）。 |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

`mode` subcommand 会把 `multiAgentMode` 写入 opencodex 配置并重新同步 Codex 目录。
`on`/`off` 会用 `codex features enable|disable` 切换 codex-rs feature flag。变更从新的 Codex
session 开始生效，正在运行的 session 保持已固定的 surface。

### `ocx models [--provider <name>] [--json]`

列出已配置 provider 中静态 seed 的模型。`--provider` 只筛选一个已配置 provider；`--json` 返回
模型 metadata，并提醒 `liveModels` 可能加入仅在运行时存在的条目。此命令不会获取实时目录；
需要实时刷新时请使用 `ocx sync` 或仪表盘。

### `ocx provider <subcommand>`

非交互式 provider 管理。注册表条目只需名称即可 seed；自定义名称必须同时提供 `--adapter` 和
`--base-url`。

| Subcommand | 支持的参数 | 操作 |
| --- | --- | --- |
| `list` | `--json` | 列出已配置 provider 和尚未添加的注册表条目。 |
| `add <name>` | `--adapter <adapter>`、`--base-url <url>`、`--api-key <key>`、`--default-model <model>`、`--set-default`、`--force`、`--json`、`--sync` | 添加注册表或自定义 provider。`--force` 会覆盖；在普通输出模式下，`--sync` 会刷新正在运行的代理。 |
| `show <name>` | `--json` | 显示配置并遮盖 API key。 |
| `remove <name>` | `--json` | 删除非默认 provider；不能删除最后一个 provider。 |
| `set-default <name>` | `--json` | 把已有 provider 设为默认值。 |

```bash
ocx provider list --json
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
```

## 认证

### `ocx login <provider>`

启动 provider 注册的登录流程。OAuth provider 会打开浏览器，并把可自动刷新的 credential 存入
`~/.opencodex/`；API-key 登录 provider 会打开 key 仪表盘，提示输入 key，在条件允许时进行
验证，再保存生成的 provider 配置。如果名称缺失或未知，命令会打印当前接受的 OAuth 和 API-key
provider id。

```bash
ocx login xai
```

### `ocx logout <provider>`

移除 provider 已存储的 OAuth credential。

## 仪表盘

### `ocx gui`

在 `http://localhost:<port>` 打开 [Web 仪表盘](/opencodex/zh-cn/guides/web-dashboard/)。如果代理
尚未运行，会自动启动。

## 后台服务

### `ocx service [subcommand]`

把 opencodex 作为登录管理的后台服务运行（macOS **launchd**、Linux **systemd user unit**、
Windows **Task Scheduler**），登录时自动启动，崩溃后自动重启。服务进程会设置
`OCX_SERVICE=1`，因此重启不会反复改动 Codex 配置。

| Subcommand | Action |
| --- | --- |
| 无 | 创建/更新并启动服务。 |
| `install` | 创建并启动服务。 |
| `start` | 启动已安装的服务。 |
| `stop` | 停止服务并恢复原生 Codex。 |
| `status` | 报告服务是否正在运行。 |
| `uninstall` | 移除服务并恢复原生 Codex。 |
| `remove` | `uninstall` 的别名。 |

```bash
ocx service
ocx service install
ocx service status
ocx service uninstall
```

### `ocx codex-shim <subcommand>`

把 PATH 上基于脚本的 `codex` launcher 包装成轻量自动启动脚本。真实 `codex.exe` 目标保持不变，
避免破坏精确的可执行文件调用。

如果 Codex 更新覆盖了 wrapper，下一次调用 `install` 时 shim 会自动修复：先备份新 binary，再写入
新的 wrapper。

| Subcommand | Action |
| --- | --- |
| `install` | 安装 shim（过期时会修复）。 |
| `uninstall` | 移除 shim 并恢复原始 Codex binary。 |
| `remove` | `uninstall` 的别名。 |
| `status` | 报告 shim 状态（已安装 / 过期 / 缺失）。 |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Service 与 Shim]
常驻代理请使用 `ocx service`（推荐）。需要无 daemon 的轻量按需启动时，请使用
`ocx codex-shim`；只有运行 `codex` 时才会启动代理。
:::

## 诊断

### `ocx doctor`

运行只读的环境与连接诊断：状态路径和文件系统类型、WSL 双重安装、代理环境/配置、ChatGPT
可达性、Codex plugin 与项目配置警告，以及待处理的历史迁移。它会打印修复建议，但不会执行。

### `ocx debug [provider|usage …]`

经正在运行的代理管理 API 读取或修改运行时 debug override。

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

不指定范围时，`ocx debug` 会打印用法；代理停止时，还会显示下次启动采用的环境变量默认值。
provider debug 默认读取 `OCX_DEBUG=1`（旧的 `OCX_DEBUG_FRAMES=1` 仍可用），usage debug 默认读取
`OPENCODEX_USAGE_DEBUG=1`。

## 更新

### `ocx update`

从 npm 自助更新 opencodex。稳定版安装使用 `@latest`，preview 安装继续使用 `@preview`，除非传入
`--tag latest|preview`。在源码 checkout 中，它会改为提示 `git pull && bun install`；如果已经是
相应 tag 的最新版，则不执行任何操作。替换文件前会停止正在运行的代理；已安装的服务会自动重建
并启动，而前台安装会把 `ocx start` 显示为下一步。

```bash
ocx update
ocx update --tag preview
```

[Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml) 发布到 npm
后，新版本会立即可用。

## 帮助

`ocx help`、`ocx --help`、`ocx -h` —— 打印顶层用法和示例。

`ocx help <command>`、`ocx <command> --help`、`ocx <command> -h` —— 打印
`src/cli/help.ts` 中注册命令的专属用法。`provider`、`debug` 和 `v2` 的完整 subcommand 契约已在
上文列出。

即使带有帮助参数，未知命令仍会报错，因此脚本可以依赖退出码，无需解析文本输出。

## 版本

`ocx --version`、`ocx -v`、`ocx version` —— 打印一行适合脚本读取的版本信息并退出。

## 内部命令

两个 dispatch 目标会刻意从普通帮助中隐藏：`__refresh-version [preview]` 在 detached process 中
刷新更新通知缓存；`__gui-update-worker <job-id> [latest|preview] [restart]` 执行仪表盘更新任务。
它们属于实现细节，不是稳定的用户命令。
