# 修复规划：删除文件树的 window focus 自动刷新

- **创建时间**：2026-10-06 22:10
- **状态**：已实施（本分支）
- **关联问题**：文件树打开时，切到别的窗口/浏览器 tab 再切回，整棵树必然全量刷新一次——没有必要

## 1. 问题背景

右侧栏文件树（插件接管的原生 `files` kind）在窗口重新聚焦时必然闪一次：所有已展开层并发重列。用户判断这个自动行为没有必要，要求查明原因。

## 2. 原因分析

- **直接机制**：`src/client/TreePanel.tsx` 在挂载时注册 `window` 的 `focus` 监听，`focus` 一到就 `refreshTick + 1`；`FileTree` 对 tick 变化的响应是**全量缓存清空**（`generationRef` 失效 + abort 在途 + level 缓存清零）后重列根 + 全部展开层。展开态本身不丢（存于 record/store），丢的是全部层级缓存。
- **历史由来**：`f23e40f`（2026-08-30）引入，动机是当时树对外部变更（别的编辑器、同步工具写入）完全无感知，只能等手动刷新——focus 刷新是当时**唯一**的兜底。
- **现已冗余**：`6586e3e`（2026-09-22，DSH 0.1.7 适配）给树加了实时目录 watch（`src/fs-watch.ts` 宿主侧 + `src/client/use-dir-watch.ts` 客户端）：展开目录（**根目录始终在列**）逐个 `fs.watch`、150ms 去抖、折叠即退订，变更通知只丢弃并重列**那一层**。该机制在触发时机（变更即刷新，而非切回才刷新）、粒度（单层 vs 全量）、覆盖（离开窗口期间的变更也已就位）三个维度上严格优于 focus 刷新。折叠目录无缓存可陈旧（展开时现拉并随即加入 watch），无缺口。
- **修复放大浪费**：`6d9e5c3` 给 files kind 上了 `keepMounted` 后，树在 tab 隐藏时保持挂载，focus 监听也随之常驻——files tab 不在前台时，每次切回窗口仍在后台全量重拉一遍（`visible` 门控只管 git 轮询，不管这个 reload）。
- **结论**：focus 监听是 fs-watch 的粗粒度冗余子集，删除。仅存的理论兜底场景（64 句柄上限/围栏/不可读导致 watch 被拒的目录、`fs.watch` 不可靠的文件系统）仍有手动刷新按钮与 `dsh-sidebar:refresh-files` 事件可用。

## 3. 实施内容

- `src/client/TreePanel.tsx`：删除 `window` 的 `focus` 监听（保留 `dsh-sidebar:refresh-files` 事件——那是给集成分发用的显式入口），注释更新为新的因果链。无测试钉住旧行为（已全量 grep 确认）。
- `scripts/e2e-common.sh`：tarball 解析 glob 扩展为 `output/` + 仓库根两处（制品自此统一归置 `output/`，根目录历史遗留按 mtime 兼容）。
- 仓库根两个遗留 tarball 移入 `output/`。

## 4. 验证

- `pnpm lint` / `pnpm typecheck` 干净；`pnpm test` 全绿。
- 全量 suite 过程中发现 **base 分支自带的**版本镜像不一致（`bc3e43d` 把 `package.json` 抬到 `0.23.0-myprs.2` 但未同步 `dsh.plugin.json` 与 `SIDEBAR_SERVICE_VERSION`，两个一致性 spec 红；stash 对照证实与本次改动无关）——按 `be1f009` 先例以独立 chore commit 同步镜像点修复。
- 真机：tarball（`output/dsh-better-sidebar-0.23.0-myprs.2.tgz`）挂载到 `~/.dsh/profiles/web`（3080），由用户验证「切窗再切回不再刷新 + 外部变更仍实时出现」。

## 5. 边界

- watch 被拒目录（句柄上限/围栏/不可读）从此只能手动刷新或靠 `dsh-sidebar:refresh-files`——可接受：这些场景此前 focus 刷新也只是「碰巧切窗才刷新」，语义上本就该是显式动作。
- 若日后要恢复某种自动兜底，正确方向是把 `useDirectoryWatch` 的 refusal 信息透出后按「可见且存在被拒目录」条件触发，而不是无条件全量刷新。
