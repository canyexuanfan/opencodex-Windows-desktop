# 桌面架构参考索引

本目录只保留阶段 0 的一次性架构参考记录。参考仓库用于比较 Electron 单实例、资源分发与 Windows 便携/安装包边界，不直接复制实现，也不作为前端视觉参考。

## 参考项目

| 本地路径 | GitHub URL | 主要功能 | 技术栈 | 对本项目的参考价值 |
| --- | --- | --- | --- | --- |
| `reference/electron-builder` | https://github.com/electron-userland/electron-builder | Electron 安装版、便携版、资源与签名构建 | TypeScript、Node.js、Electron 构建工具链 | 阶段 6/7 关注 `extraResources`、`process.resourcesPath`、ASAR 解包、NSIS/portable 产物与代码签名边界。 |
| 未落地（网络连接失败） | https://github.com/electron/packager | 将 Electron 应用打包为平台目录 | TypeScript、Node.js、Electron Packager | 用于对比最小目录打包模型；本次 `git clone --depth 1 --filter=blob:none` 因 SSL 连接失败未成功，不复制其代码。 |

## 本次检查结论

- Electron 单实例由主进程尽早调用 `app.requestSingleInstanceLock()`，拿不到锁的进程立即退出；后续实例通过 `second-instance` 唤醒已有窗口。
- Bun sidecar、GUI 构建产物和需要执行的运行时资源应位于 Electron `resources` 目录之外或通过 `extraResources` 分发，运行时使用 `process.resourcesPath` 定位。
- 安装版与便携版共用同一资源清单，但需要分别验证用户数据目录、卸载边界和签名产物。
- 参考仅用于架构核对；本项目继续复用现有 Dashboard，不引入第二套页面或额外 UI 服务。

## 检查范围

本次只完成一次与 Windows 单实例、sidecar 打包和零依赖分发直接相关的参考检查。后续阶段不重复检索或扩张参考范围。
