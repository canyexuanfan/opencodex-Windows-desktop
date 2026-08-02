# Provider 获取地址与模型排查指南

## 问题描述

Dashboard 添加 Provider 时展示的“获取 API 密钥”链接可能过期，静态默认模型/候选模型也可能落后于平台当前文档。用户已发现 `Zhipu AI — BigModel` 的旧 API Key 链接打开 404，默认模型 `glm-4.6` 也已过时。

## 已尝试的修复方法及失败原因

- ❌ 2026-08-02：直接用 PowerShell 执行 `rg` 正则扫描 URL 时，命令字符串同时包含单引号和反引号，触发 `字符串缺少终止符` 解析错误。下一步改用更简单的脚本/文本解析方式提取 URL，避免 PowerShell 引号转义干扰。
- ❌ 2026-08-02：改用 `node -e` 内联脚本后，JS 正则和数组下标仍被 PowerShell 提前解析，触发 `[`/`)` 等语法错误。下一步改用 PowerShell 原生 `Select-String` 和简单分组，避免跨语言命令嵌套。
- ❌ 2026-08-02：对 50 个唯一 `dashboardUrl` 使用 `Invoke-WebRequest` 顺序探活，单 URL 15 秒、总 180 秒超时退出，无法得到完整清单。下一步改用并发短超时，只抓 404/410/DNS/连接失败，不等待慢登录页完整加载。
- ❌ 2026-08-02：将并发探活写成 `node -e` 单行后，当前 PowerShell/命令调用层仍吃掉 JS 字符串双引号，代码变成 `require(fs)` 并失败。下一步用 `apply_patch` 创建仓库内临时 `.tmp` 脚本，跑完删除，避免内联转义风险。
- ❌ 2026-08-02：查看 `registry.ts` 局部内容时使用 `Select-Object -Index 860..925`，Windows PowerShell 未自动展开 range，报参数转换失败。下一步改用 `-Skip/-First`。
- ❌ 2026-08-02：用 `rg` 混合搜索 `modelInputModalities` 与数组字面量时正则括号/引号转义不完整，报 `unclosed group`。下一步拆成固定字符串搜索。
- ❌ 2026-08-02：并行验证里用一条 `rg` 同时扫描多个带引号的旧值，PowerShell 再次报 `字符串缺少终止符`。下一步继续采用固定字符串分条扫描，避免复合正则。
- ❌ 2026-08-02：首轮全量 `dashboardUrl` 探活使用 Windows `curl.exe`，大量登录控制台因 Schannel 证书吊销检查、特殊 URL 参数或超时返回 `network-unknown`，不能作为死链结论。下一步改用 Node `fetch` 的 HEAD/GET 双阶段复核。
- ❌ 2026-08-02：修复 Fireworks 后再次用复合 `rg` 同时扫描旧 Fireworks/Xiaomi URL，PowerShell 再次触发 `字符串缺少终止符`。下一步继续固定字符串分条扫描。

## 深层问题分析

- Provider 的展示入口由 `src/providers/registry.ts` 和 `src/providers/free-directory.ts` 派生，桌面端只是复用 Dashboard；修复必须落在 canonical registry/free directory，而不是只改桌面 UI。
- 控制台/API Key 页面多数需要登录或 JavaScript，HTTP 状态不能简单要求全部 `200`；`302/401/403` 通常仍表示入口存在，`404/410/DNS/连接失败` 才应视为死链。
- 静态模型列表应优先引用官方文档或平台模型接口；无法确认的模型不能冒充“最新”。

## 下一步排查策略

1. 提取所有 `dashboardUrl`，批量检查是否为 404/410 或无法解析。
2. 优先修复确认失效的入口，特别是添加 Provider 模态框会直接展示的 key-provider 链接。
3. 对用户截图中的 BigModel 模型按官方文档更新默认模型和静态列表。
4. 补充回归测试锁定新链接、新模型和死链检查策略。

## 调试工具

- `bun test tests/zhipu-bigmodel-provider.test.ts tests/provider-registry-parity.test.ts`
- `bun run typecheck`
- `rg "dashboardUrl|zhipu-bigmodel|glm-4.6|glm-5.2" src tests gui`

## 注意事项

- 不要把需要登录的 `401/403` 误判成死链。
- 不要把第三方教程当成模型事实来源；模型默认值优先以官方文档为准。
- 不要在测试中请求或暴露用户 API Key。

## 更新记录

- ❌ 2026-08-02：初次 URL 正则扫描因 PowerShell 引号解析失败，已切换排查策略。
- ❌ 2026-08-02：`node -e` 内联提取仍被 PowerShell 解析干扰，已切换为 PowerShell 原生扫描。
- ❌ 2026-08-02：顺序 HTTP 探活 50 个入口超时，需改成并发短超时。
- ❌ 2026-08-02：并发 HTTP 探活的 `node -e` 版本被 shell 吞引号，改用临时脚本执行。
- ❌ 2026-08-02：PowerShell `Select-Object -Index` range 写法失败，改用 `-Skip/-First`。
- ❌ 2026-08-02：复杂 `rg` 正则转义失败，改为固定字符串分次搜索。
- ❌ 2026-08-02：旧值复合扫描再次触发 PowerShell 引号解析失败，改为固定字符串分条扫描。
- ❌ 2026-08-02：Windows `curl.exe` 全量 URL 探活对 35/50 个 URL 返回 TLS/超时/参数类未知结果，不能据此宣称“全部链接正常”；已切换 Node `fetch` 复核。
- ❌ 2026-08-02：复合 `rg` 同时搜索旧 Fireworks/Xiaomi URL 再次被 PowerShell 引号解析打断，后续使用固定字符串逐条扫描。
- ✅ 2026-08-02：修复 BigModel 确认失效入口：`zhipu-bigmodel` 与免费目录 `glm-cn` 的 API Key 入口统一为 `https://bigmodel.cn/apikey/platform`；旧 `https://bigmodel.cn/console/usercenter/apikeys` 和 `https://open.bigmodel.cn/usercenter/apikeys` 在源码、测试、GUI、docs、README 扫描中均无命中。
- ✅ 2026-08-02：按官方文档更新 BigModel 静态模型：默认模型改为 `glm-5.2`，补入 `glm-5.2`、`glm-5-turbo`、`glm-5v-turbo`、`glm-4.7-flashx`，保留兼容旧模型 `glm-4.6`/`glm-4.6v`；`glm-5.2` 上下文显式设为 1M，`glm-5v-turbo` 标记文本+图像输入。
- ✅ 2026-08-02：验证通过：`bun test tests\zhipu-bigmodel-provider.test.ts tests\provider-registry-parity.test.ts` 35/35、565 个断言；`bun run typecheck`；`cd desktop && bun run build`；重新生成桌面资源树并只重打 NSIS 安装版。最终 Setup SHA-256=`D49E64B1265966B15DB0FABB5A8CB2CC08E24E8D02802612BC93A05F0CFFE446`。
- ✅ 2026-08-02：对 50 个唯一 `dashboardUrl` 改用 Node `fetch` 复核，确认 Fireworks 旧入口 `https://fireworks.ai/account/api-keys` 跳转后 404；修复 registry 与 free-directory 的 Fireworks/Fire Pass 入口为 `https://app.fireworks.ai/settings/users/api-keys`。
- ✅ 2026-08-02：将 Xiaomi MiMo 与 MiMo Free 的控制台入口从主页 `https://xiaomimimo.com` 改为可达控制台 `https://platform.xiaomimimo.com`；旧 Fireworks 与旧 Xiaomi URL 固定字符串扫描均无命中。
- ✅ 2026-08-02：补充 provider 回归：已知旧 dashboard URL 禁止回归；手写 `models` 且设置 `defaultModel` 的 registry 条目必须保证默认模型在候选列表中。

## 2026-08-02 本轮补充记录

- ❌ Provider 回归初跑失败：`bun test tests\provider-registry-parity.test.ts tests\zhipu-bigmodel-provider.test.ts` 中 3 个断言仍按旧模型合同检查。DeepSeek 仍期待已退役 `deepseek-chat` / `deepseek-reasoner`；Kimi coding 仍期待旧 K3 列表；`glm-cn` free-directory 仍期待单一 `glm-4.7-flash`。实际 registry/free-directory 已刷新为 DeepSeek V4、Kimi K3 `k3-256k`/`k3`/`k3[1m]` 兼容族、GLM 5.2/5.1/5。
- ✅ 已将测试合同对齐当前模型刷新：DeepSeek 只保留 `deepseek-v4-pro` / `deepseek-v4-flash`；Kimi coding 检查 `k3-256k` 默认值、`k3`/`k3[1m]` 1M 上下文和 `kimi-for-coding-highspeed`；BigModel CN free-directory 检查 `glm-5.2`、`glm-5.1`、`glm-5`、`glm-4.7-flash`。复跑 `bun test tests\provider-registry-parity.test.ts tests\zhipu-bigmodel-provider.test.ts`：37/37、624 个断言通过。
