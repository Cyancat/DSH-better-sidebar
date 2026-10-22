# 搜索结果右键菜单规划（含 PDF 在浏览器中打开）

- 日期：2026-10-22
- 状态：已实施（`feat/search-result-context-menu`；实施记录见 §10）
- 目标分支：`local/my-prs-0.28`（v0.28.0，DSH 0.2.1-rc.1）
- 关联规划：[2026-10-21-open-in-browser-port-plan.md](2026-10-21-open-in-browser-port-plan.md)（下称「Plan A」；PDF 的 CSP / 桌面门控以该文 §D6 / §D7 为准）

---

## 0. 结论摘要

**现状**：`TreePanel` 的搜索结果是一排普通 `<button>`，只有左键动作（文件打开、目录在树内揭示），没有 `onContextMenu`；右键只会弹出浏览器菜单。文件树的富右键菜单在 `FileTree` 内部，搜索面板拿不到。

**建议**：给搜索结果行加一个**专用的、只读动作集**的右键菜单（不复用 FileTree 的全量菜单），并让它和文件树 PDF 入口共用同一套 `open-in-browser` helper。这样：

1. 搜索结果右键可用：打开 / 新 Tab / 侧边 / **PDF 在浏览器中打开** / 下载 / 在文件管理器中显示 / 在文件树中显示 / 复制路径；
2. **不**在扁平搜索结果上暴露改名 / 删除 / 上传 / 新建 / 打包这类会改盘的动作；
3. 不触碰 FileTree 的选中集、虚拟行和隐藏错误条，避免「右键一个搜索命中，文件树选中集被改」和「错误显示在隐藏的树里」；
4. PDF 的 URL、CSP、桌面门控与 Plan A 完全一致，不会出现两个入口行为不同。

---

## 1. 现状探索

### 1.1 搜索结果的渲染与动作

`src/client/TreePanel.tsx`：

- 搜索状态：`results: { matches: string[]; dirs: string[]; truncated: boolean } | null`（`:105`）；查询去抖 300ms（`:188-216`）。
- 结果行（`:349-366`）是 `<button className={css.editorSearchResult}>`，没有 `onContextMenu`：
  - 文件命中：`onOpenFile(resolveSidebarPath(cwd, rel))`；
  - 目录命中：`openSearchDir(rel)`（`:238`），展开祖先后清空查询，让树接管；
  - 目录判定来自 `dirHits = new Set(results.dirs)`（`:223`），不能靠路径后缀猜。
- 目录命中可能在 **cwd 之外**（#879 的粘贴绝对路径直开分支）：`openSearchDir` 会检测 `isWithinWorkspace`，越界时只清查询、不调用 `onToggle`（现有测试 `tests/file-tree-search-persist.spec.tsx:257` 钉住）。
- 搜索结果面板与树同时挂载：查询非空时树 `hidden`，结果面板可见；清空查询恢复同一棵树和缓存。**文件树菜单因此仍在 DOM 里，但视觉上被隐藏。**

### 1.2 FileTree 的现有菜单为什么不能直接搬

`src/client/FileTree.tsx` 的右键菜单是组件内部状态与动作的集合：

- `handleContextMenu`（`:1250`）会 `preventDefault`、**改写选中集**、记录 `rowMenu`；
- `openWithSection`（`:1662`）+ `appsCacheRef` 负责宿主应用探测、插件 targets、pin；
- `zipEntries`（`:1685`）依赖 `selected` 与 `cwd`；
- `downloadFile`（`:1701`）、`downloadArchive`、`startNewFolder` / `startNewFile` / `setRenaming` / `setConfirmDelete` 等写操作；
- `<Menu>`（`:2300`）用 `getAnchorRect` 定位（`:2420`），错误落在 FileTree 自己的 `actionError` 条（`:637`）。

如果让搜索结果直接复用这套菜单：

- 右键一个搜索命中会**改写 FileTree 的选中集**，清空搜索后可能看到一条不可见的选中行；
- 会暴露**改名 / 删除 / 上传 / 新建 / 打包**；搜索结果可能来自 cwd 之外，这些动作不该在扁平结果上提供；
- 写操作失败时，错误条在 `hidden` 的 FileTree 里，用户看不到；
- 需要给 FileTree 增加 external-menu / source 过滤等机制，改动面远大于本次需求。

**因此本规划选择「专用、只读」的搜索结果菜单**；FileTree 菜单和它的写操作保持原样。未来若两个菜单的动作集持续收敛，再考虑抽取共享菜单核心（见 §3 的选项 C）。

### 1.3 PDF 的既有基础

Plan A 已经确定：

- PDF 是宿主 `HOST_OWNED_EXTS`，不会进入插件 `EditorHost`，所以 PDF 的入口在文件树右键，不在 header；
- 媒体路由统一 inline CSP（`sandbox allow-scripts allow-downloads; object-src 'none'`）；
- 桌面壳用 `canOpenInBrowser()` 门控，`dsh-app://` 下隐藏；
- PDF 的「在浏览器中打开」使用 `mediaUrl()` + `window.open(url, '_blank', 'noopener')`。

本规划只新增「搜索结果」这一入口，**不新增路由、不改 CSP、不恢复 PDF viewer**。

---

## 2. 目标与范围

### 2.1 目标

1. 搜索结果的文件行与目录行支持右键菜单；
2. 菜单里的 PDF 项复用 Plan A 的 `open-in-browser` 逻辑；
3. 菜单关闭/查询变化/结果刷新时状态干净；
4. 不改变左键行为，不影响现有 FileTree 菜单和选中集。

### 2.2 动作矩阵（v1）

| 目标 | 动作 |
|---|---|
| 文件（cwd 内） | 打开、在新 Tab 中打开（若回调存在）、在侧边打开（若回调存在）、**在浏览器中打开**（仅 PDF 且 Web）、下载、在文件管理器中显示（若宿主可用）、在文件树中显示、复制相对地址、复制绝对地址 |
| 文件（cwd 外） | 打开、在新 Tab 中打开（若回调存在）、在侧边打开（若回调存在）、**在浏览器中打开**（仅 PDF 且 Web）、下载、在文件管理器中显示（若宿主可用）、复制绝对地址 |
| 目录（cwd 内） | 在文件树中显示、在文件管理器中显示（若宿主可用）、复制相对地址、复制绝对地址 |
| 目录（cwd 外） | 在文件管理器中显示（若宿主可用）、复制绝对地址 |

说明：

- 「在新 Tab / 在侧边」只在 `TreePanel` 收到对应回调时出现；与 FileTree 的显示条件一致。
- 「在文件管理器中显示」只在 `openInApp` 可用时出现；失败时用搜索面板自己的提示条报错（见 §4.5）。
- **不提供**：改名、删除、上传、新建文件夹/文件、打包下载、多选、拖拽。搜索结果不是文件树的选中集，写操作仍走文件树/原地操作。
- 「在浏览器中打开」**只对 PDF**（`BROWSER_OPENABLE_EXTS = ['pdf']`），且仅在 Web 页面（`canOpenInBrowser()`）出现；图片仍不做，未来扩集合即可。
- PDF 的「在新 Tab 中打开」仍是宿主 PDF 预览；「在浏览器中打开」才是系统浏览器，两个动作的文案与语义要分开。

---

## 3. 方案比较

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. 专用搜索结果菜单（推荐）** | 在 `TreePanel` 内加一个 `SearchResultMenu`，动作集按 §2.2 收敛 | 改动局部、风险低；不碰 FileTree 选中/写操作；错误提示就在搜索面板；PDF 逻辑可共享 | 与 FileTree 菜单有少量动作重复；v1 无「打开方式」子菜单 | **采用** |
| B. 复用 FileTree 的 `<Menu>` | 给 FileTree 加 external target / source 过滤，把搜索结果右键转给它 | 菜单天然一致；PDF 自动可用 | 会改选中集；要过滤写操作；错误落在隐藏的树；FileTree 改动大 | 不采用 |
| C. 抽取共享菜单核心 | 把 `openWithSection` / 动作执行器抽成 hook，两处共用 | 长期最整洁 | 2.5k 行组件的重构，回归面大，超出本次需求 | 留作后续 |

**推荐 A**：先把用户要的「搜索结果右键 + PDF 在浏览器中打开」以最小面交付；共享只发生在**纯 helper** 层（PDF 判定、URL、`window.open`），而不是整个菜单。

---

## 4. 详细设计

### 4.1 共享 `open-in-browser` helper

新增 `src/client/open-in-browser.ts`（Plan A 的 FileTree PDF 入口也改为用它）：

```ts
import { mediaUrl, type SessionScope } from './api.ts'
import { extOf } from './paths.ts'

/** Types a browser can render natively; PDF is the first entry. */
export const BROWSER_OPENABLE_EXTS: ReadonlySet<string> = new Set(['pdf'])

/** Case-insensitive, dot-safe extension check. */
export function isBrowserOpenablePath(path: string): boolean {
  return BROWSER_OPENABLE_EXTS.has(extOf(path))
}

/** Authenticated inline media URL for a real browser tab. */
export function browserOpenUrl(scope: SessionScope, path: string): string {
  return mediaUrl(scope, path)
}

/** Open a real browser tab; false means the caller should report failure. */
export function openBrowserTab(url: string): boolean {
  try {
    window.open(url, '_blank', 'noopener')
    return true
  } catch {
    return false
  }
}
```

- `canOpenInBrowser()` 仍在 `src/client/desktop-env.ts`（Plan A §5.2）；本 helper 不做环境门控，由两个菜单入口各自判断。
- 不把 `window.open` 的 popup-blocked 返回值当失败：`noopener` 下成功也返回 null，现有行为一致。
- 不新增依赖；`mediaUrl` / `extOf` 都已在核心 bundle。

### 4.2 `SearchResultMenu` 组件

新增 `src/client/SearchResultMenu.tsx`（名称可同义），把菜单的项目构建与动作分派收在一个可测组件里：

```ts
export interface SearchResultMenuTarget {
  /** The result row's RELATIVE spelling (used by openSearchDir). */
  rel: string
  /** Absolute path after resolveSidebarPath (used by every action). */
  path: string
  isDir: boolean
  x: number
  y: number
}

export interface SearchResultMenuProps {
  target: SearchResultMenuTarget | null
  scope: SessionScope
  cwd: string | undefined
  onClose: () => void
  /** Left-click semantics: file → onOpenFile; dir → openSearchDir. */
  onActivate: (target: SearchResultMenuTarget) => void
  /** Expand ancestors and clear the query; file or dir inside cwd only. */
  onRevealInTree: (target: SearchResultMenuTarget) => void
  onOpenNewTab?: (path: string) => void
  onOpenSide?: (path: string) => void
  onRevealInFileManager?: (path: string) => Promise<boolean> | boolean
  /** Transient hint (copy success) or sticky error (open failure). */
  onNotify: (message: string, failed?: boolean) => void
}
```

内部：

- `inWorkspace = cwd !== undefined && isWithinWorkspace(cwd, target.path)`；`isDir` 来自 `dirHits`，不要用后缀猜。
- `isPdf = !target.isDir && isBrowserOpenablePath(target.path)`；`showPdf = isPdf && canOpenInBrowser()`。
- 菜单项按 §2.2 生成；分隔线按视觉分组：
  - 主动作（打开 / 在树中显示）→ 新 Tab / 侧边 / PDF → 下载 → 文件管理器 / 在树中显示 → 复制。
- `Menu` 使用 `portal`、`compact`、`align="start"`、`getAnchorRect={() => target === null ? null : new DOMRect(target.x, target.y, 0, 0)}`、`anchor={<span />}`，与 FileTree 的用法一致。
- `onSelect`：**先 `onClose()`**（与 FileTree 的 `setRowMenu(null)` 一致），再执行动作；不要依赖 primitive 自动关闭。
  - `search-open` → `onActivate`；`search-reveal-tree` → `onRevealInTree`（目录的主项与文件的可选揭示项都走它）；
  - `search-new-tab` / `search-side` → 对应回调；
  - `search-pdf-browser` → `openBrowserTab(browserOpenUrl(scope, target.path))`；失败 `onNotify(t('openInAppFailed', { path: target.path }), true)`；
  - `search-download` → `downloadUrl(scope, target.path)` + 临时 `<a download>`（与 FileTree `downloadFile` 同形）；
  - `search-reveal-file-manager` → `onRevealInFileManager`；返回 false 时 `onNotify(t('openInAppFailed', { path }), true)`；
  - `search-copy-relative` / `search-copy-absolute` → `writeClipboard(...)`；成功 `onNotify(t('copied'))`，失败静默（与 FileTree 行为一致）。
- 菜单项一律使用新 id 命名空间（`search-*`），避免和 FileTree 的 `open-*` / `download` / `relative` / `absolute` 冲突。

### 4.3 TreePanel 接线

`src/client/TreePanel.tsx`：

1. 新增状态：
   ```ts
   interface SearchMenuTarget { rel: string; path: string; isDir: boolean; x: number; y: number }
   const [menuTarget, setMenuTarget] = useState<SearchMenuTarget | null>(null)
   const [menuNotice, setMenuNotice] = useState<{ text: string; failed: boolean } | null>(null)
   ```
2. 结果行加右键：
   ```tsx
   onContextMenu={(event) => {
     event.preventDefault()
     event.stopPropagation()
     setMenuTarget({
       rel,
       path: resolveSidebarPath(cwd, rel),
       isDir: isDirHit,
       x: event.clientX,
       y: event.clientY,
     })
   }}
   ```
3. 左键与菜单共用同一个激活函数，避免两套语义：
   ```ts
   const activateSearchHit = (target: { rel: string; path: string; isDir: boolean }): void => {
     if (target.isDir) openSearchDir(target.rel)
     else onOpenFile(target.path)
   }
   ```
   结果行 `onClick` 改为调用它；搜索菜单的 `onActivate` 也调用它。
4. 文件树的「在文件树中显示」：
   ```ts
   const revealSearchHit = (target: { rel: string; path: string; isDir: boolean }): void => {
     // Directory: keep the existing left-click behavior untouched.
     if (target.isDir) { openSearchDir(target.rel); return }
     // File: expand its parent chain, then let the tree take over.
     if (cwd !== undefined && isWithinWorkspace(cwd, target.path)) {
       for (const dir of ancestorDirs(cwd, [target.path])) {
         if (!expanded.includes(dir)) onToggle(dir)
       }
     }
     setQuery('')
   }
   ```
   目录仍走已有的 `openSearchDir`（含 cwd 外只清查询的语义）；文件只做父级链展开，不新增高亮/滚动。
5. 菜单关闭：
   - 查询变化、结果刷新、离开搜索态时关闭：`useEffect(() => { setMenuTarget(null) }, [needle, results])`；
   - **tab 不可见时也要关闭**（native tab body `keepMounted`，不能把菜单留在后台）：`useEffect(() => { if (visible === false) setMenuTarget(null) }, [visible])`；
   - `Menu` 自身的 `onClose` 置空；
   - 菜单动作执行后由 `Menu` 关闭。
6. 提示条：
   - `menuNotice` 渲染在搜索行下方（复用 `css.editorSearchHint`；失败加 `css.editorError`）；
   - 成功提示 2s 后自动消失；失败保留到下一次动作/查询；成功计时器只保留一个（下一次 notice 或卸载时清掉），不要在每次渲染新建；
   - 与 `uploadStatus` 同时存在时，上传状态优先（两者都很短，不叠两层也可）。
7. 菜单渲染位置：放在 `TreePanel` 根节点、结果面板条件之外，传 `target={menuTarget}`；不要放在 `{searching && ...}` 内，避免清查询时组件连同菜单一起消失。

### 4.4 目录 / 越界 / 边界行为

- **目录命中**：菜单主项是「在文件树中显示」，调用 `openSearchDir(rel)`（已有：展开祖先 + 目标，清空查询）；不提供「在新 Tab 打开」（文件夹窗口入口不在这里扩展）。
- **cwd 外的目录**：不出现「在文件树中显示」和「复制相对地址」；保留「在文件管理器中显示」「复制绝对地址」。`openSearchDir` 原本对越界目录只清查询，不做动画/展开，菜单沿用同一语义。
- **cwd 外的文件**：保留打开 / 新 Tab / 侧边 / PDF / 下载 / 文件管理器 / 绝对路径复制；不出现「在文件树中显示」「复制相对地址」。这保持现有左键「直接打开绝对路径」的行为。
- **PDF 越界**：`mediaUrl` 仍可服务；与现有打开行为一致，不额外限制。
- **多选**：搜索结果没有多选，菜单只作用于被右键的那一行；不要把它接到 FileTree 的 `selected`。
- **截断**：`results.truncated` 只影响列表底部提示，不影响右键。

### 4.5 错误与提示

- 搜索结果面板在树之外，FileTree 的 `actionError` 条在搜索时是隐藏的；**不能**依赖 `reportOpenFailure`。
- `openInApp.reveal` 返回 false 或 reject → `onNotify(t('openInAppFailed', { path }), true)`；
- `openBrowserTab` 返回 false → 同一提示（它自己捕获 `window.open` 的异常，不向外抛）；
- 复制成功 → `onNotify(t('copied'))`；复制失败沿用 FileTree 的静默行为（`writeClipboard` 返回 false 时不弹错）；
- 下载的 `<a>` 点击失败没有可靠的同步错误，保持现有 FileTree 的静默行为。

### 4.6 i18n

新增 2 个 key（21 份词典，`locales-ja` 必须同步）：

| key | zh | en |
|---|---|---|
| `searchOpen` | 打开 | Open |
| `searchRevealInTree` | 在文件树中显示 | Reveal in Tree |

其余动作复用现有 key：`openFileNewTab` / `openFileSide` / `download` / `revealInFileManager` / `copyRelative` / `copyAbsolute` / `browserOpenExternal` / `copied` / `openInAppFailed`。

- 20 个文件：`src/client/locales.ts`（zh + en）+ 19 份 `locales-*.ts`。
- `tests/locales.spec.ts` 的 key-set 门禁会自动兜底；`locales-ja` 必须有人工译文（AGENTS §5）。
- 不新增 `aria-label` 或按钮文案；菜单项标签就是上述 key。

### 4.7 键盘与可访问性

- 右键菜单由 `Menu` primitive 负责键盘导航 / Escape / 焦点。
- 搜索结果行本身是 `<button>`；如果只加 `onContextMenu`，键盘用户没有等价入口。建议顺手加：
  ```tsx
  onKeyDown={(event) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      setMenuTarget({ rel, path, isDir: isDirHit, x: rect.left, y: rect.bottom })
    }
  }}
  ```
  这是可选增强；如果本期不做，PR 里要写明「键盘用户暂只能左键打开」，不要静默留缺口。

---

## 5. 实施步骤

1. **共享 helper**：新增 `src/client/open-in-browser.ts`（§4.1）；把 Plan A §10.3 的 FileTree PDF 判定/URL/`window.open` 改为使用它。
2. **菜单组件**：新增 `src/client/SearchResultMenu.tsx`（§4.2）；纯展示 + 动作回调，不直接依赖 TreePanel 状态。
3. **TreePanel 接线**：结果行 `onContextMenu`、`menuTarget`、`menuNotice`、`activateSearchHit`、`revealSearchHit`、`SearchResultMenu` 渲染（§4.3）。
4. **i18n**：2 个 key × 21 份（§4.6）。
5. **测试**：扩展 `tests/file-tree-search-persist.spec.tsx`，新增 `tests/open-in-browser.spec.ts`（§6）。
6. **文档**：`CHANGELOG.md` 用户可见条目；本规划可在实施 PR 里作为设计记录。无外部插件 API 变化，`docs/external-plugin-guide.md` 不需要改（搜索 UI 不是接入面）；Plan A 的 PDF 说明仍适用。
7. **门禁**：typecheck / lint / test / build / mount smoke；真实浏览器手测。

**提交拆分建议**：

1. `feat(files): add a read-only context menu to search results`——`SearchResultMenu.tsx` + `TreePanel.tsx` + i18n + 测试；
2. `refactor(editor): share the PDF open-in-browser helper`——`open-in-browser.ts` + FileTree/Plan A 接线（如果 Plan A 尚未落地，可与 1 合并）；
3. `docs: search results context menu`——CHANGELOG / 设计记录。

---

## 6. 测试计划

### 6.1 单测 / 组件测试

| 文件 | 用例 |
|---|---|
| `tests/file-tree-search-persist.spec.tsx`（扩展） | 搜索结果右键出现菜单；文件命中含 Open / New Tab / Side / Download / Reveal in File Manager / Reveal in Tree / Copy relative / Copy absolute；目录命中含 Reveal in Tree / File Manager / Copy，且无 New Tab / PDF；`.pdf` 命中出现「Open in browser」，点击 `window.open` 收到 `(mediaUrl(...), '_blank', 'noopener')`；非 PDF 无该项；cwd 外命中无 Reveal in Tree / Copy relative；查询变化时菜单关闭；菜单不触发 FileTree 选中集（可断言树行的选中 class 不变） |
| `tests/file-tree-search-persist.spec.tsx`（现有） | 左键文件打开 / 目录揭示 / 越界目录只清查询的既有 4 例保持通过；右键不改变左键行为 |
| `tests/open-in-browser.spec.ts`（新增） | `isBrowserOpenablePath`：`.pdf` / `.PDF` 为 true，`.ts` / `a.pdfx` / 无扩展名为 false；`browserOpenUrl` 在反代前缀下仍带前缀；`openBrowserTab` 调 `window.open(url, '_blank', 'noopener')`，抛错返回 false |
| `tests/locales.spec.ts` | 现有 key-set 门禁；确认 21 份都有 `searchOpen` / `searchRevealInTree` |
| `tests/theme.spec.ts` | 不新增视觉 token；菜单用现有 primitives / CSS 变量，应保持通过 |

- `tests/file-tree-search-persist.spec.tsx` 的 `api.ts` mock 需要补 `mediaUrl`（当前只有 `fsTrees` / `fsSearch` / `gitStatus` / `downloadUrl`）；这是新增 PDF 用例的唯一 mock 变更。
- 需要 `openInApp` 的用例传一个最小 fake（`reveal: vi.fn(async () => true)` 等），不需要真实宿主。
- `window.open` 用 `vi.stubGlobal('open', openSpy)`，结束后 `vi.unstubAllGlobals()`。

### 6.2 真实浏览器手测矩阵

| 场景 | 期望 |
|---|---|
| Web 搜索一个 `.ts` 文件 | 右键菜单出现；Open 打开编辑器；New Tab / Side 按现有行为；无 PDF 项；无改名/删除/上传 |
| Web 搜索一个 `.pdf` | 右键出现「在浏览器中打开」；新 Tab 正常渲染 PDF；`_blank` + `noopener`；无侧边栏 tab 被关 |
| Web 搜索一个目录（cwd 内） | 右键「在文件树中显示」；树展开该目录、查询清空；不当作文件打开 |
| 反代子路径 | PDF 新 Tab URL 带前缀；菜单动作正常 |
| 桌面壳（`dsh-app://app/`） | PDF 项隐藏；其他动作正常 |
| 搜索 cwd 外路径（粘贴绝对路径） | 无「在文件树中显示」/「复制相对地址」；绝对路径动作仍可用；不弹写操作 |
| 查询变化 / 清空 | 菜单关闭；不残留旧 target |
| 键盘（若实现） | ContextMenu / Shift+F10 打开菜单；Escape 关闭 |

### 6.3 验收清单

- [x] 搜索结果文件行右键出现菜单；目录行右键出现菜单。
- [x] 菜单动作与 §2.2 一致；没有改名/删除/上传/新建/打包/多选。
- [x] PDF 行出现「在浏览器中打开」，URL 与 `browserOpenUrl()` 一致，`_blank` + `noopener`；非 PDF 无该项。
- [x] 桌面壳隐藏 PDF 项；Web 显示。
- [x] cwd 外命中隐藏「在文件树中显示」与「复制相对地址」。
- [x] 右键不改变 FileTree 选中集；菜单错误显示在搜索面板。
- [x] 查询变化/清空时菜单关闭。
- [x] 21 份词典 key-set 通过；`locales-ja` 有译文。
- [x] `pnpm typecheck` / `pnpm lint`（改动文件）/ `pnpm test` / `pnpm build` / `pnpm test:mount` 通过；真实浏览器里的 PDF 渲染（CSP 手测）未在本轮复核，仍按 Plan A §10.4 的决策门处理。

---

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 两套菜单动作漂移 | 搜索结果与文件树行为不一致 | v1 只读、动作集小；PDF 逻辑共享；后续可抽共享菜单（选项 C） |
| 搜索结果路径在 cwd 外 | 写操作/树揭示越界 | 不提供写操作；`isWithinWorkspace` 隐藏 Reveal in Tree / Copy relative |
| 右键改到 FileTree 选中集 | 清空搜索后出现不可见选中行 | 搜索菜单完全独立，不调用 `handleContextMenu` / `setSelection` |
| 错误落在隐藏的 FileTree | 用户看不到失败 | 搜索面板自己的 `menuNotice`；不复用 FileTree `actionError` |
| 菜单在查询变化后仍指向旧结果 | 点到过期路径 | `useEffect` 在 `needle`/`results` 变化时关闭 |
| `Menu` 定位/portal 问题 | 菜单位置错误或被裁剪 | 复用 FileTree 的 `portal` + `getAnchorRect` 模式；手测 |
| PDF 在 CSP sandbox 下不渲染 | PDF 入口不可用 | 与 Plan A 同一门禁；不静默去 CSP，走 §10.4 决策 |
| 桌面壳 PDF 项可见但无效 | 点了没反应 | 共用 `canOpenInBrowser()`，桌面隐藏 |
| 复制无反馈 / 失败静默 | 用户不确定 | 成功显示 `copied`；失败沿用 FileTree 静默，可后续补 |
| i18n 漏 key | `locales.spec` 红 / ja 回退 | 21 份同批；`locales-ja` 人工翻译 |
| 键盘用户无入口 | 可访问性缺口 | 可选加 ContextMenu / Shift+F10；不做则在 PR 说明 |
| 搜索结果含目录/文件歧义 | 右键动作错 | 用 `dirHits` 判定，不用后缀猜；`path` 与 `rel` 分开保存 |

**回滚**：移除 `SearchResultMenu` 的渲染与结果行 `onContextMenu`，删除两个 i18n key 即可；`open-in-browser.ts` 可保留（Plan A 的 FileTree PDF 入口仍在使用），不依赖搜索菜单。

---

## 8. 任务拆分与顺序

| 任务 | 内容 | 依赖 | 规模 |
|---|---|---|---|
| S1 | `open-in-browser.ts` + 单测；FileTree（Plan A）改用它 | Plan A 的 PDF 行为 | 小 |
| S2 | `SearchResultMenu.tsx`（动作、菜单项、错误/复制） | S1 | 中 |
| S3 | `TreePanel` 接线（右键、target、notice、关闭、`revealSearchHit`） | S2 | 中 |
| S4 | 2 个 i18n key × 21 份 | 无 | 小 |
| S5 | 扩展搜索 spec + `open-in-browser` spec | S1-S4 | 中 |
| S6 | CHANGELOG / 设计记录 | S2-S5 | 小 |
| S7 | 全量门禁 + 真机手测 + mount smoke | S1-S6 | 中 |

推荐顺序：**S1 → S2 → S3 → S4 → S5 → S6 → S7**。如果 Plan A 的 FileTree PDF 入口尚未实现，S1 可以独立先落（只新增 helper + 单测），S2/S3 不依赖 FileTree 的菜单改动。

流程：非文档改动从 `dev` 切 `feat/search-result-context-menu`，合回 `dev`；纯文档（本文件）可直接提交。

---

## 9. 待确认问题

1. **v1 是否要「打开方式」子菜单**（宿主默认应用 / VS Code / Cursor / Zed / 自定义编辑器）？本规划建议先不做：搜索结果菜单保持只读、动作集小；需要的话第二阶段把 `openWithSection` 抽成共享组件。
2. **目录命中是否要「在新 Tab 中打开」**（文件夹窗口）？本规划只做「在文件树中显示」；如果产品需要，单独加回调与测试。
3. **cwd 外命中**：当前左键可以直接打开绝对路径；菜单是否保留 Open/Download/PDF？本规划保留，只隐藏树内揭示与相对路径复制。若安全口径更严，可以进一步收紧。
4. **「在文件树中显示」对文件**：本规划只展开父级并清查询，不做高亮/滚动。是否要求像 `revealed` 那样高亮？那会牵动 EditorHost 的 `revealed` 状态，建议另开。
5. **键盘入口**：本期是否实现 ContextMenu / Shift+F10？建议实现；不实现需在 PR 说明。
6. **菜单共享**：是否现在就做选项 C（抽共享菜单）？本规划建议先交付 A，等两个菜单的动作集稳定后再抽。

---

## 10. 实施记录（2026-10-22）

- **分支**：`feat/search-result-context-menu`，基于已落地的 Plan A（`feat/open-in-browser-0.28`）。本功能不改 FileTree 菜单、不改 `/sidebar/file` 路由与 CSP、不新增依赖。
- **S1 已由 Plan A 落地**：`src/client/open-in-browser.ts`（`BROWSER_OPENABLE_EXTS` / `isBrowserOpenablePath` / `browserOpenUrl` / `openBrowserTab`）与 `tests/open-in-browser.spec.ts` 先行合入；本功能只消费，不存在第二份 PDF 判定或 URL 拼接。
- **S2/S3**：`src/client/SearchResultMenu.tsx` + `src/client/TreePanel.tsx` 接线；菜单 id 全部使用 `search-*`。动作矩阵、分组、cwd 越界裁剪与 §2.2 一致；「在文件管理器中显示」用与 FileTree 相同的 `available()` / `probe()` 结果门控。提示条复用 `editorSearchHint`（失败加 `editorError`），成功 2s 后消失、失败保留到下一次动作/查询；上传状态优先显示。查询/结果变化、`visible === false` 时关闭菜单。
- **键盘入口**按 §4.7 实现：`ContextMenu` 键与 `Shift+F10` 在结果行上打开同一菜单；Esc / 方向键 / 焦点由 `Menu` primitive 负责。
- **S4**：`searchOpen` / `searchRevealInTree` 进入 21 份词典；`locales-ja` 使用人工日文译文（開く / ファイルツリーで表示）。
- **S5**：`tests/file-tree-search-persist.spec.tsx` 由 7 例扩到 21 例，新增文件/目录菜单内容、PDF 精确 URL、桌面壳隐藏、cwd 越界裁剪、查询变化/页签隐藏关闭、键盘入口、不改 FileTree 选中集、失败与复制提示共 14 例；`api.ts` mock 只补 `mediaUrl`。工厂型 `openInApp` fake 不依赖真实宿主。
- **S6**：`CHANGELOG.md` / `CHANGELOG_EN.md` 的 `Unreleased` 各加一条；本文件随功能一起提交。
- **偏差**：无功能性偏差。文件「在文件树中显示」只展开父级链并清查询，不做高亮/滚动（§4.4 的既定范围）。
- **门禁**：`pnpm typecheck`、`pnpm build`、改动文件 ESLint 通过；全量 `pnpm test` = **223 文件 / 2716 通过 / 17 跳过**；`pnpm test:mount`（真实 DSH 0.2.1-rc.1 scratch profile，tarball 为 `output/dsh-better-sidebar-0.28.0.tgz`）= **14 通过 / 3 跳过**。本机沙箱把 `$HOME` 设为只读，涉及 `pnpm pack` 与写家目录的 3 份既有 spec 需在可写 `HOME` / `PNPM_HOME` 下重跑；重跑后全绿，与本次改动无关。
- **3080 挂载**：新 tarball 经 profile 的 `pnpm remove` + `pnpm add file:…` 装进 `~/.dsh/profiles/web`（旧 `package.json` / lockfile / 安装目录已备份到 `output/profile-backup/20261022-152650-search-menu/`），安装后 `lib/client.js` 与 tarball 内文件 md5 一致。宿主 dev 版的 client-HMR（500 ms stat 轮询）已重建 bundle：`/plugins/events` 给出 `dsh-better-sidebar` 的新 rev `924ff6d08a78`，该 rev 下发的 combo bundle 含 `search-pdf-browser` / `search-reveal-tree` / `search-copy-relative`，根页面引用同一 rev；无需重启宿主。

## 附录：关键代码位置（当前分支）

| 位置 | 说明 |
|---|---|
| `src/client/TreePanel.tsx:109` | `results` 状态 |
| `src/client/TreePanel.tsx:226` | `needle` / `searching` |
| `src/client/TreePanel.tsx:124` | `menuTarget` / `menuNotice` 状态 |
| `src/client/TreePanel.tsx:276` | `openSearchDir()`（目录揭示，越界只清查询） |
| `src/client/TreePanel.tsx:287` / `:299` | `activateSearchHit()` / `revealSearchHit()`（左键与菜单共用） |
| `src/client/TreePanel.tsx:469-491` | 搜索结果行（`onContextMenu` + 键盘入口） |
| `src/client/TreePanel.tsx:535` | `<SearchResultMenu>`（在结果面板之外） |
| `src/client/TreePanel.tsx:504` | 共用的 `FileTree`（搜索时 `hidden`） |
| `src/client/SearchResultMenu.tsx:84` | `menuEntries()`（§2.2 动作矩阵） |
| `src/client/SearchResultMenu.tsx:149` | `SearchResultMenu` 动作分派 |
| `src/client/FileTree.tsx:1250` | `handleContextMenu()`（会改选中集，搜索菜单不复用） |
| `src/client/FileTree.tsx:1662` | `openWithSection()` |
| `src/client/FileTree.tsx:1701` | `downloadFile()` |
| `src/client/FileTree.tsx:2300` / `:2420` | FileTree 的 `<Menu>` / `getAnchorRect` 范式 |
| `src/client/open-in-browser.ts` | 与 FileTree 共用的 PDF 判定 / URL / `window.open` |
| `src/client/paths.ts:42` | `relativeTo()` |
| `src/client/paths.ts:80` | `isWithinWorkspace()` |
| `src/client/paths.ts:104` | `extOf()` |
| `src/client/paths.ts:116` | `resolveSidebarPath()` |
| `src/client/api.ts:453` | `fsSearch()` |
| `src/client/api.ts:674` | `mediaUrl()` |
| `src/client/desktop-env.ts:53` | `hostHttpBase()`（`canOpenInBrowser()` 的基础） |
| `tests/file-tree-search-persist.spec.tsx:47` | `api.ts` mock 的 `mediaUrl` |
| `tests/file-tree-search-persist.spec.tsx:67` | `fakeOpenInApp()` |
| `tests/file-tree-search-persist.spec.tsx:84` / `:132` | `mountPanel()` / `search()` harness |
| `tests/file-tree-search-persist.spec.tsx:293` | 搜索结果右键菜单用例（14 例） |
| `tests/open-in-browser.spec.ts` | helper 单测（Plan A 同批） |
| `docs/cyan/2026-10-21-open-in-browser-port-plan.md` §D6 / §D7 / §10 | PDF CSP / 桌面门控 / 文件树 PDF 入口 |
