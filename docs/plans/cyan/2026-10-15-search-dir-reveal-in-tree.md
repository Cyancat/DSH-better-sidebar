# 改进规划：文件树搜索结果中的目录点击改为树内揭示（而非当文件打开）

- **创建时间**：2026-10-15
- **状态**：已实施 / 已并入 `local/my-prs-0.23`（`2943780`，fast-forward；开发分支 `fix/search-dir-reveal` 已推 origin）
- **关联问题**：文件面板搜索框命中目录时，点击结果报 `"/xxx/xxx/xxx" is a directory`；期望点击目录直接在文件树中展开并定位该目录

## 1. 问题背景

文件面板（`files` kind，含 merged 模式右侧停靠树与 split/folder 模式整页树）顶部的全局文件名搜索框（`src/client/TreePanel.tsx`）由宿主路由 `fs.search`（`src/index.ts:326` → `src/fs-search.ts`）供给。`searchFiles` 的契约**故意把目录也计入匹配**（`fs-search.ts:18-19`：「dirs included so the client can hint where matches live」），但客户端结果行不分文件/目录，一律走文件打开路径：

```tsx
// src/client/TreePanel.tsx:268-278（现状）
{results.matches.map(rel => (
  <button ... onClick={() => { onOpenFile(resolveSidebarPath(cwd, rel)) }}>
```

`onOpenFile` → `EditorHost.openFile`（`EditorHost.tsx:210-216`）→ merged 模式 `updateTab({path})` / split 模式 `openSidebarFile` → editor tab 加载走 `fs.read` → `readText` 对目录抛 `SidebarError('fs-error', '"..." is a directory', 400)`（`src/index.ts:213-215`）→ 用户看到错误条。

同类缺陷的历史先例：PR #94（`1ca4d4e`）修过「Show in folder」把目录当文件开进编辑器的同款报错，当时的解法是**树内揭示**（reveal）而不是打开。本次缺陷是同一模式在搜索入口的残留。

## 2. 根因分析

| 环节 | 位置 | 行为 |
|------|------|------|
| ① 服务端不区分类型 | `src/fs-search.ts:95-101` | 遍历时 `dirent.isDirectory()` 已知，但只 push 路径字符串，`FsSearchResult.matches: string[]` 把目录/文件压成同一形状 |
| ② 客户端无分支 | `src/client/TreePanel.tsx:268-278` | 结果行 onClick 无条件 `onOpenFile`，目录命中必然走到 `fs.read` 的目录拒绝分支 |
| ③ 揭示能力半成品 | `src/client/state.ts:521` `revealPaths` / `src/client/FileTree.tsx:759-778` 滚动定位 / `sidebar.module.css` `.explorerRowRevealed` 高亮 | PR #94 的 reveal 链路在 `58ba17d`（turn-tail 契约变更移除拦截点）后**失去唯一调用方**：store 世界的 reducer 还在（仅测试引用），native 世界 `NativeTabRecords.View.revealed` 字段还在（`tab-adapter.tsx:83`）但**没有任何 mutator 能写入**——`toggleExpanded` 是唯一改 `expanded` 的方法 |

**结论：纯插件侧缺陷。** 修法 = 服务端给结果带 `isDir` + 客户端按类型分支 + 把 reveal 链路在两个世界（自有布局 store / 原生 tab records）都补回可写路径。

## 3. 方案权衡

### 目录点击的目标行为

| | A：树内揭示（reveal） | B：打开 folder window（`meta.dir` tab） |
|---|---|---|
| 语义 | 清空搜索 → 树重新上屏 → 展开祖先 + 目标目录本身 → 高亮 + 平滑滚动到行 | 新开一个以该目录为根的 editor/folder tab |
| 与用户期望（「直接用文件树打开该目录」） | ✅ 完全吻合 | 偏离——用户想留在当前树上下文 |
| 实现成本 | 复用 #94 遗留的 reveal 基础设施（高亮 CSS / 滚动 effect / revealPaths 路径算法），补两处 mutator | 零新基础设施（`meta.dir` 已存在），但每次点击多开一个 tab |
| 先例 | PR #94 同款手势的既定语义 | 模型 `sidebar_open` 工具的语义 |

**采用 A**；B 可作为后续右键菜单项，不在本次范围。

### 服务端结果形状

| | A：`matches` 改结构化 `{path, isDir}[]` | B：保留 `matches: string[]`，平行加 `dirs: string[]` |
|---|---|---|
| 消费方 | 唯一消费方是 TreePanel（`api.fsSearch`），插件私有路由，无外部兼容负担 | 同左 |
| 数据一致性 | 单一事实源 | 两处事实源，客户端要做集合成员判定 |
| 测试改动面 | `tests/fs-search.spec.ts` 全部断言改形状 | 断言追加即可 |

**采用 A**（结构化）。路由形状变更同步点：`src/fs-search.ts`（`FsSearchResult`）、`src/index.ts:326-333`（纯透传，仅注释）、`src/client/api.ts:293-296`（类型）、`tests/fs-search.spec.ts`。

## 4. 实施内容

### 4.1 服务端：`src/fs-search.ts`

- `FsSearchResult.matches` 改为 `{ path: string; isDir: boolean }[]`（路径仍为 root 相对、`/` 分隔、排序不变）。
- walk 内 push 处携带 `dirent.isDirectory()`；排序键仍取 `path`。
- 文件头注释更新：目录计入匹配的用途从「hint where matches live」改为「客户端可揭示目录」。

### 4.2 共享纯函数：`src/client/state.ts`

从 `revealPaths` 抽出不依赖 `SidebarState` 的路径计算核：

```ts
computeReveal(cwd, targets: readonly {path: string; expandSelf: boolean}[], baseExpanded: readonly string[])
  → { expanded: string[], revealed: string[] }
```

- 复用现有分隔符/前缀逻辑（POSIX 前导 `/`、UNC `\\`、`\` 分隔符保留，`state.ts:528-537`）。
- `expandSelf: true`（目录目标）时把目标自身也加入 `expanded`——这是「打开该目录」与「揭示文件」的唯一算法差异；文件路径走 `expandSelf: false`，行为与现 `revealPaths` 逐字一致。
- `revealPaths` 改为薄封装（签名与语义不变，`tests/state.spec.ts:702-725` 现有断言不动）；新增 `revealDirectories(state, cwd, dirs)` reducer 走 `expandSelf: true`。

### 4.3 reveal 写路径补回（两个世界）

- **自有布局世界**（`src/client/sidebar/TabContent.tsx` ← `Sidebar.tsx`）：新增 prop `onRevealDir`，实现为 `store.reduce(s => revealDirectories(s, cwd, [path]))`。`TabContent` 是 memo 组件，该回调按 `onToggleDir` 同款先例放运行时 props（不进 memo key，`tab-content-memo.ts` 注释同步一句）。
- **原生 tab 世界**（`src/client/native/tab-adapter.tsx`）：
  - `NativeTabRecords` 新增 `revealDirs(id, cwd, paths)`：对 `View` 用同一 `computeReveal` 核更新 `expanded`/`revealed` 并 `put`（bump version + notify，订阅链路现成）。
  - `NativeTabBody` 把 `onRevealDir: (path) => records.revealDirs(nativeTab.id, cwd, [path])` 注入 `descriptor.component` props。
- **`TabComponentProps`**（`src/client/service.ts:142-159`）新增可选 `onRevealDir?: (path: string) => void`。这是对外 API 面变更 → **同步 `docs/external-plugin-guide.md` §4**（AGENTS「接入 API 即文档」规则）。
- **`src/client/builtins/tabs.tsx:88-100`**：`editor` 内嵌组件把 `onRevealDir`（`??` no-op 兜底，与 `onToggleDir` 同款）透传给 `EditorHost`。

### 4.4 客户端分支：`src/client/TreePanel.tsx` + `EditorHost.tsx`

- `TreePanel` 新增可选 prop `onRevealDir?: (path: string) => void`；`results` state 类型随 api 改。
- 结果行渲染：
  - 目录行加文件夹 glyph（`IconFolderRegular`，与树行同源图标体系，不新增颜色字面量——皮肤契约）+ 修饰 class（`sidebar.module.css` 追加一条，仅排版不动色板）。
  - 点击分支：`isDir` → `onRevealDir?.(resolveSidebarPath(cwd, rel))` + `setQuery('')`（**必须清空查询**：结果面板与树是 park 关系，不清空树不上屏，reveal 不可见；`hidden={searching}` 随同一批 state 更新翻回 false，FileTree 既有滚动 effect（`FileTree.tsx:767-778`，deps `[revealed, data]`）在层级数据到达后自动把行滚入视野）；文件 → `onOpenFile` 现状不动。
  - `onRevealDir` 缺省时目录行退化为 disabled 或回退 `onOpenFile`？——取**缺省即不渲染分支差异**（所有内置调用点都会传，该 prop 只为防御外部 descriptor 复用 TreePanel；TreePanel 是内部组件，文档注明必填倾向即可）。
- `EditorHost` 两个 `TreePanel` 渲染点（split/folder 整页 `:481`、merged 停靠 `:636`）透传 `onRevealDir`（来源为组件 props）。
-  merged 模式（编辑器右侧停靠树）下点击目录结果：树在同一 tab 内揭示，编辑器内容不动——无需额外处理。

### 4.5 i18n

目录行 `title` 想加「在文件树中打开」提示时新增 key `revealInFileTree`：**zh（locales.ts）+ en（locales.ts 英文段）+ ja（locales-ja.ts）三份必填**（AGENTS 规则：新增 zh key 必须同步 ja，否则 ja 回退 en）；其余 17 份词典可后续补，缺省回退 en。若最终决定不加提示文案则零词典改动。

## 5. 测试计划

| 测试 | 文件 | 内容 |
|------|------|------|
| 搜索形状 | `tests/fs-search.spec.ts` | 全部断言改 `{path, isDir}` 形状；「目录名也匹配」用例（`:71-73`）追加 `isDir: true` 断言；新增「同目录下文件与目录混合命中」用例 |
| reducer | `tests/state.spec.ts` | `revealPaths` 现有断言保持绿（回归）；新增 `revealDirectories`：祖先 + 目标自身入 `expanded`、目标入 `revealed`、重复调用幂等、POSIX/UNC 前缀保留 |
| records mutator | `tests/native-surface.spec.ts` | `revealDirs` 写入 View 的 `expanded`/`revealed`、version bump、不存在的 id 静默忽略（对齐 `toggleExpanded` 语义） |
| 点击分支 | `tests/file-tree-search-persist.spec.tsx`（扩建，harness 现成） | mock `fsSearch` 返回文件 + 目录混合结果：点文件行 → `onOpenFile` 收到绝对路径；点目录行 → `onRevealDir` 收到绝对路径且搜索框被清空（树解除 parked，结果面板重新 parked） |
| e2e（可选） | `tests/e2e/mount.e2e.ts` | 不在本次门禁加新断言；现有「经插件文件树打开 seed 文件」链路不受影响。如需真机验证，手工 lane 即可 |

## 6. 影响面与风险

- **路由形状变更**：`fs.search` 是插件私有 `/sidebar/*` 路由，无外部消费方；`SidebarError` 目录拒绝分支（`src/index.ts:213-215`）保留不动——它仍是「目录被误当文件读」的正确兜底。
- **皮肤契约**：目录行 glyph 颜色只许 `--dsw-alias-*` 令牌；`tests/theme.spec.ts` 会守。
- **构建纯度**：无新依赖、无新 chunk，8 处 chunk 镜像不动。
- **对外文档**：`TabComponentProps.onRevealDir` 进 `docs/external-plugin-guide.md` §4。
- **行为边界**：文件点击行为逐字不变；`truncated` 提示、300ms 防抖、AbortController 链路不动。

## 7. 实施顺序

1. `src/fs-search.ts` + `tests/fs-search.spec.ts`（服务端形状先行，此时客户端编译断——同分支内连续提交）。
2. `src/client/api.ts` 类型 + `state.ts` 纯函数抽取/`revealDirectories` + `tests/state.spec.ts`。
3. `tab-adapter.tsx` records 方法 + `service.ts` prop + `TabContent.tsx`/`Sidebar.tsx`/`builtins/tabs.tsx` 透传 + `tests/native-surface.spec.ts`。
4. `TreePanel.tsx` / `EditorHost.tsx` 分支与渲染 + `tests/file-tree-search-persist.spec.tsx` 扩建。
5. 词典（若加 key）+ `docs/external-plugin-guide.md` 同步。
6. `pnpm test` / `typecheck` 全绿 → 分支 `fix/search-dir-reveal` → PR（仓库硬约束：非文档改动必须走 PR）。

## 8. 实施偏差记录（相对 §4/§5 计划）

1. **词典必须全量补齐**：§4.5 原计划「其余 17 份词典可后续补」不成立——`tests/locales.spec.ts:117-119` 要求所有已发词典的键集与 zh **逐一相等**，所以 `openSearchDirInTree` 实际加进了全部 20 份词典（zh/en/ja + 17 份第三语言）。
2. **`onRevealDir` 必填化**：在内部组件 `TreePanel` / `EditorHost` 上做成必填 prop（所有内置调用点都传），只有对外的 `TabComponentProps` 保持可选（`builtins/tabs.tsx` 用 `??` no-op 兜底，与 `onToggleDir` 同款）。
3. **顺手修了一处前存在的字符腐败**：`state.ts` 旧 `revealPaths` 注释里的箭头 `→` 已损坏为 U+FFFD + `W`，重写为 `computeReveal` 时一并恢复。
4. **目录行视觉**：图标选 `IconFolderCloseRegular`（ui-primitives 现成导出）；flex 布局下路径文本需包 `<span>` 才有省略号截断（`.editorSearchResultDir > span`），CSS 零颜色字面量，`tests/theme.spec.ts` 绿。
5. **`fs-search.spec.ts` 混合命中用例的 fixture 教训**：顶层 `app` 目录自身也命中查询 'app'，首轮断言漏了它——目录命中不仅是叶子，任何层级都可能命中。

## 9. 验证记录

- `pnpm vitest run tests/fs-search.spec.ts`：10 passed（含新增混合命中用例）。
- `pnpm vitest run tests/state.spec.ts`：50 passed（`revealPaths` 旧断言全绿 + `revealDirectories` 4 个新用例）。
- `pnpm vitest run tests/native-surface.spec.ts`：28 passed（含 `revealDirs` 记录 mutator 用例）。
- `pnpm vitest run tests/file-tree-search-persist.spec.tsx`：5 passed（含文件/目录点击分支两个新用例）。
- `pnpm test`：139 文件 / 1499 passed / 9 skipped，全绿。
- `pnpm typecheck`（tsc --noEmit）：通过。
- `pnpm lint`（eslint .）：通过。
- `pnpm build`：通过（构建纯度门未触发，无新 chunk）。
- e2e mount lane 未跑（计划内可选项，改动面为插件私有路由 + 客户端分支，宿主契约零接触）。
