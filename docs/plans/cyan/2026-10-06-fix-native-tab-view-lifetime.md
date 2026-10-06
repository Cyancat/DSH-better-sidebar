# 修复规划：原生右侧栏文件树展开态随打开文件被重置

- **创建时间**：2026-10-06 10:20（实施后补记）
- **状态**：已实施 / 已并入 `local/my-prs-0.23`（`6d9e5c3` + `c39d096`，fast-forward）
- **关联问题**：右侧目录树左键打开文件后，树重置回项目根目录；不打开文件则展开态一直保留

## 1. 问题背景

在 DSH Web GUI（http://127.0.0.1:3080）的原生右侧栏中，插件接管了内置 `files` kind 的文件树。用户报告：把目录展开到 `/abc/def/` 后左键打开 `hij.txt`，目录树立即回到根目录的折叠状态；期望树停留在 `/abc/def/`。只要不打开任何文件，展开态就一直正常保留。

## 2. 根因分析（错误链）

| 环节 | 位置 | 行为 |
|------|------|------|
| ① 状态归属 | `src/client/FileTree.tsx` / `TreePanel.tsx` | 树是完全受控组件，`expanded: string[]` 由调用方持有；原生路径下持有者是 `src/client/native/tab-adapter.tsx` 的 `NativeTabRecords`（按原生 tab id 存 `View`，含 `expanded`/`revealed`/合成 tab 记录） |
| ② 宿主挂载策略 | DSH `ui-dockkit` `TabLayout.tsx:102`（`{visited && (retained \|\| (active && selected)) ? renderTab(tab) : null}`） | 未声明 `keepMounted` 的 tab 类型是 **visibility-mounted**：tab 在 pane 中变为未选中即卸载 body。0.1.6 时代就只渲染 active tab 的 body（`TabPanel` 的 `renderTab(active)`），属设计如此；0.1.7 `bf712e1404` 新增了 `keepMounted` 逃逸口（`SidebarRightTabDefinition.keepMounted`，默认 false） |
| ③ 触发动作 | 文件树左键 | `openFile` 在同一 pane 唤起 editor tab 并成为 active → files tab 变为未选中 → 宿主卸载 files body |
| ④ 错误假设 | `src/client/native/tab-adapter.tsx`（旧）`useEffect(() => () => { records.drop(nativeTab.id) }, ...)` | 插件把「body 卸载」误当成「tab 关闭」：unmount 清理里 drop 整个 `View`，`expanded` 随之丢弃 |
| ⑤ 重置表现 | 切回 files tab | `records.ensure` 重新 mint `expanded: []` 的全新 `View` → 树回到根 |

**核心缺陷**：record 生命周期挂错了锚点。宿主 occurrence 的 `AbortSignal` 才是 tab 生命周期的权威——经核实 DSH `ui-sidebar-right` `tab-domain.ts` 的 `sync()` 只在 tab 从已提交布局消失（关闭）或包卸载（`dispose()`）时才 `controller.abort()`，隐藏/切选中/dock 移动均不触发。

**不打开文件则正常**的原因：没有 tab 切换就没有 body 卸载，错误路径不会被踩到——与现象完全吻合。

**结论：插件自身缺陷，非 DSH bug**。宿主 visibility-mounted 是文档化默认行为，且 0.1.7 专门提供了 `keepMounted` 机制，插件此前未接入（全仓库 grep 零命中）。

## 3. 方案权衡

| | A：`files` kind 声明 `keepMounted` | B：drop 时机改挂 occurrence signal | A+B |
|---|---|---|---|
| 本问题 | ✅ 修好 | ✅ 修好 | ✅ 修好 |
| 机制 | files body 永不因切换卸载，`View` 不会被 drop | `View` 跨卸载/重挂载存活，树按保留的 `expanded` 重新展开 | 叠加 |
| 切回速度 | 瞬时（层级缓存 + 目录 watcher 不失活） | 需重新 `fs.tree` 拉已展开的层 | 瞬时 |
| 其他 tab 类型 | 无改善（editor 的 `updateTab` 标题改动等仍丢） | 一并治好（同根缺陷） | 一并治好 |
| 内存 | files 常驻（pane 单例 + git 轮询有 `visible` 门控，代价有界） | 不变（editor 的 CodeMirror 实例照常随隐藏卸载，正确） | files 常驻，其余不变 |

前提验证（B 成立的关键）：宿主 occurrence signal 仅在 tab 关闭/包卸载时 abort（`tab-domain.ts:102` / `:148`），且 `keepMounted` 文档明确保留范围覆盖「hiding, Session changes and docking」。三种组合均可行，**采用 A+B**：B 修生命周期假设（治本），A 给 files kind 换瞬时体验与双保险。**A 刻意不扩到 editor kind**——每个打开的文件都是一个 CodeMirror 实例，全量常驻不可扩展。

## 4. 实施内容

### B：`src/client/native/tab-adapter.tsx`

- `records.drop` 从 unmount 清理改为订阅 `nativeTab.signal` 的 `abort`（`{ once: true }`；已 aborted 则立即 drop）；unmount 只摘监听，不 drop。
- 堵住 abort 竞态：drop 的 `notify()` 会让仍挂载的 body 重渲染，render 期对 `signal.aborted` 的 tab 跳过 `records.ensure` 并直接渲染 `null`——否则刚 drop 又被 `ensure` mint 出泄漏的新 `View`（单测真实捕获过这个竞态，不是理论推演）。
- `surface.ts` 的 `close()` 原有提前 drop 保留（`drop` 幂等，两路径不冲突）。

### A：`src/client/native/index.ts`

- `NativeTabRegistry` 接口补 `keepMounted?: boolean`（镜像宿主 `SidebarRightTabDefinition`）。
- `registerFilesKind` 的注册声明 `keepMounted: true`。

### 测试

- `tests/native-surface.spec.ts` 新增「NativeTabBody record lifetime」两组：卸载/重挂载不丢 `View`（`expanded` 与 retitle 存活）、signal abort 才 drop、已 aborted 首渲染即丢；并在注册生命周期用例中钉住 files kind `keepMounted === true`、其余 kind 不声明。
- `tests/e2e/mount.e2e.ts` 两处适配（均为 lane 真机复现驱动）：
  1. sidechat 芯片名匹配放宽：record 跨隐藏存活后，线程持久标题（`New thread`/`新对话`）不再随 body 卸载丢失，芯片正确显示线程标题——旧正则把「修复生效」误判为 tab 不存在。
  2. `'tail text'` 断言改 `visible` 过滤：`TextEditor` 在 preview 模式下仍挂载 `display:none` 的 CodeMirror 宿主，源文本会被 `getByText` 计入；CI 上预览历来先落地赢得竞态，本地热 chunk 下 CM 恒先落地（**A/B 对照**：base 构建同样 `DUPLICATE-COUNT=2`，与本次修复无关，属既有断言缺陷）。

## 5. 验证记录

- `pnpm lint` / `pnpm typecheck`：干净。
- `pnpm test`：136 文件 / 1470 用例全绿。
- `pnpm test:mount`（真实 DSH 0.1.7-rc.1 + Playwright）：**7/7 全绿**（guide 逐个开 tab、文件树开 hello.txt 强制 editor chunk、mermaid/README 预览、sidechat 宿主路由烟测、terminal 恰好 1 条、browser 缺席断言）。
- 真机：tarball 装进 scratch profile（3088）与真实 `~/.dsh/profiles/web`（3080）各验证一轮，用户确认效果。
- 环境备注：本机沙箱下 npm/pnpm 全局缓存与 store 只读，lane 需 `PNPM_HOME` / `npm_config_cache` 指到工作区内；同名同版本 `file:` tarball 重装会被 pnpm 复用旧解包，需换文件名或先删 `node_modules` 下的包目录。

## 6. 遗留与边界

- **整页刷新不持久化**：`View` 是纯内存结构，页面刷新后 `expanded` 仍丢（插件自有布局路径里是存 per-session store 持久化的，原生路径没有）。如需覆盖，方向是把展开态写进原生 tab 的 navigation params 或插件 store 按 tab id 持久化——独立改进项，与本次不冲突。
- `editor` kind 保持 visibility-mounted 是刻意取舍（见 §3），未来若出现「editor tab 切回后滚动位置/光标丢失」类诉求，应走「状态入 record + 重挂载恢复」路线而不是给 editor 开 `keepMounted`。**（已落地：[2026-10-06-editor-tab-remount-restore.md](2026-10-06-editor-tab-remount-restore.md)——重挂载恢复 load 缓存 + 脏草稿记忆，顺带修掉了切 tab 静默丢未保存草稿。）**
