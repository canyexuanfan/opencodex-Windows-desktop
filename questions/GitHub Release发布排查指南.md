# GitHub Release 发布排查指南

## 问题描述

创建 GitHub Release 时，`gh release create v2.10.0 ... --target f1eb07c` 返回：

`HTTP 422: Validation Failed`

具体字段为：

`Release.target_commitish is invalid`

## 已尝试的修复方法及失败原因

- ❌ 2026-08-04：使用短 SHA `f1eb07c` 作为 `--target` 创建 Release。失败原因是 GitHub Release API 对 `target_commitish` 校验更严格，短 SHA 在当前请求中未被接受。
- ❌ 2026-08-04：使用完整 SHA 重新执行 `gh release create` 时命令超过 300 秒被截断，远端生成了 draft Release，但只上传了 `.blockmap`，安装包 `.exe` 未出现；本地残留的 `gh` 进程无明显 CPU 活动。下一步停止卡住进程，改用 `gh release upload` 对 draft 补传安装包。
- ❌ 2026-08-04：第一次后台 `gh api` 直传安装包时，`Start-Process -ArgumentList` 数组参数把 `Content-Type: application/octet-stream` 拆坏，日志报 `accepts 1 arg(s), received 2`。下一步改用带引号的单个参数字符串启动。
- ❌ 2026-08-04：第二次后台 `gh api` 使用单字符串参数后进程存在但无 TCP 连接、日志为空，远端资产仍未出现。下一步改用 PowerShell `Invoke-RestMethod -InFile` 调用 GitHub Upload API，token 从 `gh auth token` 动态读取，不写入文件。
- ✅ 2026-08-04：前台执行 PowerShell `Invoke-RestMethod -InFile` 直传成功，GitHub 返回安装包 asset，digest 为 `sha256:74197d3e2594651bcccd461ac2b6d44885e3b7334484d5901e9b500b85e5ce88`。随后 `gh release edit v2.10.0 --draft=false --latest` 成功发布正式 Release。
- ❌ 2026-08-04：发布后检查发现推送 `v2.10.0` tag 触发了 `Service lifecycle` 与 `Issue quality tests` 两个 tag push 工作流。失败原因是只检查了 `ci.yml` 的分支触发，漏查其它 workflow 的 tag push 行为。后续发布若要完全避免 Actions，应先审计所有 `.github/workflows/*.yml` 的 `on.push.tags` 或泛化 `push` 触发，再决定是否推 tag。

## 深层问题分析

`git push origin HEAD:refs/heads/codex/sync-upstream-v2.10.0` 已将提交推送到远端，`v2.10.0` tag 也已推送。Release 创建失败不是 tag 或资产不存在，而是 `--target` 参数格式不满足 API 校验。

## 下一步排查策略

1. 用 `git rev-parse HEAD` 获取完整 40 位 SHA。
2. 重新执行 `gh release create`，将 `--target` 改为完整 SHA。
3. 创建后用 `gh release view` 核验 tag、URL 和资产列表。
4. 如果 Release 已处于 draft 且缺少资产，使用 `gh release upload <tag> <asset> --clobber` 补传缺失资产，再发布 draft。

## 调试工具

- `git rev-parse HEAD`
- `gh release create`
- `gh release view`

## 注意事项

不要覆盖已有 Release 或移动已有 tag。若 Release 已创建但资产未上传，应改用 `gh release upload` 补传资产。

## 更新记录

- ❌ 2026-08-04：记录短 SHA 作为 Release target 被 GitHub API 拒绝，下一步使用完整 SHA。
- ❌ 2026-08-04：记录完整 SHA 创建 Release 超时导致 draft 资产不完整，下一步补传缺失安装包。
- ❌ 2026-08-04：记录 `Start-Process` 数组参数拆坏 `gh api` header，下一步使用单字符串参数。
- ❌ 2026-08-04：记录 `gh api` 单字符串后台进程无网络活动，下一步换 PowerShell 直传。
- ✅ 2026-08-04：PowerShell 直传安装包成功，v2.10.0 Release 已正式发布，包含 exe 与 blockmap 两个资产。
- ❌ 2026-08-04：记录 tag push 意外触发两个工作流，后续发布前必须全量审计所有 workflow 的 push/tag 触发。

- ✅ 2026-08-19：v2.22.0 发布全程顺利，此前记录的坑均未复现：
  - 分支 `codex/sync-upstream-v2.10.0` 推送（e922b69 → 5f88af1，fast-forward）；
  - tag v2.22.0 重建指向本 fork 构建提交 5f88af1（本地旧 v2.22.0 tag 是 fetch 上游时
    带入的 d9de895 指针，未推送过，直接删除重建，遵循 fork 惯例：版本 tag 指向
    本仓库构建提交）；
  - `gh release create --draft --target <完整SHA>` 一次成功；`gh release upload`
    121MB 安装包未超时（本次未拆 blockmap，差分索引已禁用）；
  - `gh release edit --draft=false --latest` 发布成功。
  - 注意：`gh release view --json` 无 isLatest 字段，验证 latest 要用
    `gh api repos/<repo>/releases/latest`。
  - 端到端验证：GitHub releases API latest=v2.22.0，资产名
    OpenCodex-Setup-2.22.0-x64.exe 精确匹配 desktopSetupAssetName()，
    大小 121354017 与本地一致，下载域名为 github.com（在安装器 URL 白名单内）。
  - 本次 tag/branch push 触发的 Service lifecycle 与 Issue quality tests
    均 completed success（v2.10.0 时代曾被视为噪音，现已无失败）。

- ✅ 2026-08-19：main 强推同步 v2.22.0 代码。
  - origin/main 原为孤儿压缩线（c859510e5，2.8.1 时代），与功能分支无共同祖先，
    需 `git push --force origin HEAD:refs/heads/main`。
  - 触发影响评估：fork 未启用 Pages（API 404、无 gh-pages 分支），deploy-docs
    若触发必失败；cleanup-orphaned-workflows 带 actions:write 会删运行历史。
  - 实际结果：强推仅触发 React Doctor（success），所有带 paths 过滤的工作流
    （ci/deploy-docs/cleanup/service-lifecycle/issue-quality）均未触发 ——
    无共同祖先的强推使 push 事件的 paths 匹配落空。
  - 经验：以后普通 fast-forward 推 main 时这些 paths 工作流会正常触发；
    若届时不想部署文档站（fork 未开 Pages），需在推送后取消 deploy-docs 运行，
    或提前在 fork 中禁用该 workflow。

- ✅ 2026-08-23：v2.31.0 发布全程顺利（复用 v2.22.0 流程）：
  - tag 重建：本地 v2.31.0 又是 fetch 上游带入的指针（6ae83b1f1），删除重建指向
    本 fork 构建提交 fe8c28654 后推送 —— 此坑已成惯例，每次同步后发布都会遇到；
  - draft + 上传（119MB，网络慢但未超时）+ --draft=false --latest 一次通过；
  - 端到端验证用运行中的 2.31.0 实例 /api/update/check：installer=desktop、
    asset 精确匹配、大小一致、当前/最新 buildRevision 均为 1 → 正确判定已是最新；
  - main 同步：这次是 fast-forward（08773f4 → fe8c286），正常触发 5 个 paths
    工作流；Deploy Docs 因 fork 未启用 Pages 必失败，推送后立即取消（run
    32611791861）；cleanup-orphaned 本次未触发（其 paths 未变）；
    Cross-platform CI / React Doctor / Service lifecycle / Issue quality 放行，
    作为合并的真实 CI 验证。

- ✅ 2026-08-23：v2.31.0 Build 2 发布（同版本构建更新首次实战）。新坑与经验：
  - ❌ `gh release create --target a1c4035de`（短 SHA）再次被拒（Release.target_commitish
    is invalid）——老坑重现，必须用完整 40 位 SHA。
  - ❌ 同版本构建 tag 打成 `v2.31.0+2`：desktopReleaseIdentityFromTag 的约定后缀是
    `-build.N`（正则 `(?:-build\.(\d+))?`），`+2` 无法匹配，buildRevision 静默落回
    默认值 1 —— 已装 Build 1 的用户会被判定"已是最新"，永远收不到更新。
    ✅ 修正：gh release delete + 删远端/本地 tag，按约定重建 v2.31.0-build.2。
    经验：发布同版本构建前必须先跑
    `desktopReleaseIdentityFromTag(tag)` 验证解析结果与预期一致。
  - ❌ 网络抖动期 `gh release upload` 报 exit=0 但资产实际未上传（TLS 超时被吞）。
    ✅ 上传后必须验证资产：draft 无法按 tag 查询（by-tag 对 draft 返回 404 ≠ 不存在），
    要用 release ID（上传 URL 里的数字）走 /releases/<id> 查 assets。
  - ⚠️ 更新器 fetchDesktopInstallerRelease 用匿名 GitHub API（60 次/小时/IP）。
    代理共享出口 IP（本轮 134.195.101.180）极易 403 → 更新检查报
    desktop_release_unavailable。改进方向（未做）：改走 github.com HTML 重定向
    解析 latest tag（不受 API 限流），或本地缓存上次结果。验证期可用
    gh auth token 注入 Authorization 模拟更新器逻辑。
  - ✅ Cross-platform CI 首跑暴露 6 类失败（详见上游v2.22.0同步合并排查指南附录），
    修复后 Build 2 重打包（desktop/package.json buildRevision 1→2 为构建号来源）。

- ✅ 2026-08-23：Build 2 → Build 3 收敛过程（CI 从红到绿的三轮）：
  - CI 第二轮 4 类失败全部为 fork/upstream 混搭或丢失防线：
    * Provider 工作台：v2.22.0 同步留下了 fork Shell + 上游 ProviderRail 的混搭
      （默认星标重复渲染）。✅ 三件套（Shell/测试/CSS）整体采纳上游自洽设计，
      DOM 测试取上游版；再按用户级交互偏好补回三条 hover 规则
      （.pws-filter-btn / .pws-sort-btn / .pws-model-expand）。
    * init.ts 注入健康门（ad9d1682a，防死路由）在 v2.22.0 同步取上游时丢失，
      ✅ 重放。
    * windows-deploy 测试：OCX_BAKE_PORT 块取上游演进版；localhost 断言按
      deps.hostname 契约微调。
  - ✅ 第三轮 Cross-platform CI 全绿（run 32624158200）——本 fork 首次全平台
    矩阵通过。经验：CI 是唯一能暴露"fork 契约测试长期没机会执行"的机制，
    main 必须保持可触发 CI 的推送路径。
  - ✅ Build 3 发布：buildRevision 3，tag v2.31.0-build.3，latest 已指向，
    更新器模拟解析正确（2.31.0 build 3，资产精确匹配）。
  - 残余风险：匿名 API 限流窗口内（共享代理 IP 403），运行实例的更新检查会
    报 unavailable，限流重置后自愈；改进方向已在上一条记录。
