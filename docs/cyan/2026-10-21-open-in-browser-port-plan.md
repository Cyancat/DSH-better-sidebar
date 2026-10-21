# 「在浏览器中打开」移植规划（my-prs → 0.28 / DSH 0.2.1-rc.1）

- 日期：2026-10-21
- 状态：已实施（2026-10-22；实施记录见 [2026-10-21-open-in-browser-port-record.md](2026-10-21-open-in-browser-port-record.md)）
- 目标分支：`local/my-prs-0.28`（v0.28.0，DSH 0.2.1-rc.1）
- 源实现：`local/my-prs`（0.18.0 线）的 `feat/open-in-browser`
- 关联源设计：`docs/plans/2026-08-31-open-in-browser-design.md`（该文件在当前分支尚不存在，位于 `local/my-prs`）

---

## 0. 结论摘要

**可以移植，机制几乎可以原样复用；但可见范围必须收窄。**

三句话概括：

1. **功能本体**：给 `FileViewerDescriptor` 增加可选的 `browserUrl`，在编辑器 header 增加一个「在浏览器中打开」按钮；点击后用 `window.open(url, '_blank', 'noopener')` 打开真实新 Tab，并关闭侧边栏里的这个 tab（脏草稿先确认）。
2. **当前分支只剩一个内置声明点**：内置 viewer 只有 markdown / html / jsonl / code；图片、PDF、Office 已让给宿主的 `ui-sidebar-documentpreview`，插件编辑器根本看不到这些文件。因此本次只给 **html viewer** 接 `browserUrl`（走已经带 CSP sandbox 的 `/sidebar/html`），不会恢复源码里的 image / pdf 按钮。**PDF 另走文件树右键「在浏览器中打开」（§10）**，不经过 viewer；图片仍不做。
3. **两件必须同批做的事**：
   - **媒体路由安全加固**：当前 `/sidebar/file` 只对 SVG 加了 CSP；`.html` 仍以 `text/html` 顶层可导航、无 CSP，存在同源执行工作区脚本的缺口。移植时把源码的 `mediaHeadersFor()` 按当前流式路由重写，所有 **inline** 响应统一加 sandbox 边界。
   - **桌面壳门控**：当前桌面壳页面是 `dsh-app://app/`，`htmlUrl()` 在桌面下会产出 `dsh-app://...`；Electron 主窗口的 `setWindowOpenHandler` 只把 http/https 交给 `shell.openExternal`，其余一律 deny。桌面下按钮会变成无声的空操作。建议本期在桌面壳隐藏该按钮并记录为后续能力，而不是交付一个点不动的按钮。

**不包含**：图片的「在浏览器中打开」、恢复 image/pdf viewer、DSH 源码改动、服务端新增鉴权或 token 机制。**PDF 已追加为文件树右键入口（§10）**，不走 viewer。

---

## 1. 源实现盘点

### 1.1 分支与提交

按当前 checkout 核对，仓库里**没有**名为 `0.17` 的 my-prs 分支；`v0.17.1` 也不含该功能。完整功能实际在 `local/my-prs`（0.18.0 线），随后已经有人把它移植到 0.23 / 0.24 线：

| 线 | 提交 | 内容 |
|---|---|---|
| `feat/open-in-browser`（基于 0.18.0-alpha.0） | `18d9b2b` + `4ae61f0` | 原始实现：image/pdf/html 三个 `browserUrl`、媒体路由加固、点击后关闭 tab、脏草稿确认 |
| `local/my-prs`（0.18.0） | `c470eb5` + `3285112` | 上述两提交合入本地 my-prs 线 |
| `my-prs2`（0.24.1） | `d7cb134` + `6a36422` | 0.2.0 基线移植：收窄为只有 html；媒体加固保留；关闭 tab 与词典补齐 |
| `local/my-prs-0.23`（0.23.0） | `3ae1c3b` + `38602c0` | 0.1.7 基线移植，结论与 0.24 相同 |
| `local/my-prs-0.28`（当前） | — | **没有** `browserUrl` / `openBrowserCloseConfirm`，只有既有的 `browserOpenExternal` 文案 |

> 如果你说的「0.17 的 myprs」是另一个本地分支，请以 `c470eb5` + `3285112` 对应的**行为**为准；下面的适配结论不受分支名影响。

### 1.2 源行为定义

- **入口**：编辑器 header，按钮顺序为 保存 / 刷新 / **在浏览器中打开** / 文件树面板。
- **显示条件**：`load.status === 'ready'` 且命中 viewer 声明了 `browserUrl`。
- **URL**：image/pdf → `/sidebar/file` 媒体 URL；html → `/sidebar/html` 路径编码 URL。
- **点击**：`window.open(url, '_blank', 'noopener')`；随后 `closeTab(tab.id, scope)` 关闭侧边栏 tab。
- **脏草稿**：html viewer 可编辑；`toolbar.dirty === true` 时先 `window.confirm(t('openBrowserCloseConfirm'))`，取消则不开也不关。
- **文案**：按钮复用既有 `browserOpenExternal`（无新增 key）；只新增确认文案 `openBrowserCloseConfirm`（源 PR 同步了当时全部词典；当前分支是 21 份）。
- **不提供**：markdown / code / binary 等浏览器无法有意义渲染的类型，按钮不出现。源码已经验证过：文本/代码在浏览器里只有无高亮的 plain text，体验不如侧边栏，所以「预览 + 下载」方案被放弃，入口收窄到浏览器原生可渲染的类型。

### 1.3 源改动面

| 文件 | 源改动 |
|---|---|
| `src/client/service.ts` | `FileViewerDescriptor.browserUrl?` |
| `src/client/builtins/viewers.tsx` | image/pdf/html 三个声明（0.23/0.24 只剩 html） |
| `src/client/EditorHost.tsx` | header 按钮、`window.open`、`closeTab`、脏草稿确认 |
| `src/index.ts` | `MEDIA_INLINE_CSP` / `mediaHeadersFor()` + 媒体路由改用 |
| 全部 locale 文件（当前 21 份词典） | `openBrowserCloseConfirm` |
| `tests/builtins.spec.ts` | 哪些 viewer 声明 `browserUrl`、URL 形状 |
| `tests/editor-host.spec.tsx` | 按钮有无、`window.open` 参数、关闭 tab、脏草稿取消/确认 |
| `tests/file-route.spec.ts`（源） | `mediaHeadersFor` 的 inline / download 头契约 |
| `tests/consumer-types.ts` | 外部 viewer 类型夹具 |
| `docs/external-plugin-guide.md` | §5.1 字段、§5.4 内置 viewer、§6 媒体路由 inline 安全契约 |

### 1.4 0.23 / 0.24 移植已经替我们踩过的坑

- **范围收窄**：0.1.7 起 image/pdf/binary-download viewer 删除，内置只剩 html 声明 `browserUrl`；媒体路由加固仍然保留（源码注释写明：顶层导航风险与按钮是否存在无关）。
- **`closeTab` 跨承载面**：0.24 移植确认 `service.closeTab()` 会先走原生右侧栏、再回落底部工作台；`tab.id` 对两套承载面都成立。当前 0.28 的 `closeTab` 结构一致（`src/client/service.ts:1293`），可以沿用。
- **i18n 门禁**：新增 zh key 必须同步 19 份第三语言（含 `locales-ja.ts`），否则 `locales.spec` 直接红。
- **媒体头**：`MEDIA_INLINE_CSP` 的确切值是 `sandbox allow-scripts allow-downloads; object-src 'none'`，`download=1` 分支不带 CSP。

---

## 2. 当前分支现状（0.28）

### 2.1 Viewer 集合：只剩 html 一个可声明点

`src/client/builtins/viewers.tsx` 当前注册 4 个 viewer：

| id | exts | 是否可由插件编辑器承载 |
|---|---|---|
| `markdown` | md / markdown | 是 |
| `html` | html / htm | **是，本次唯一接入点** |
| `jsonl` | jsonl / ndjson | 是 |
| `code` | `[]` catch-all | 是 |

图片 / PDF / Office / 表格由宿主原生预览接管：`src/client/native/index.ts:65` 的 `HOST_OWNED_EXTS` 明确包含 `xlsx/xls/csv/tsv/fods/pdf/png/jpg/jpeg/gif/webp/svg/bmp/ico/doc/docx/ppt/pptx`，插件的 `editor.canOpen` 对这些扩展名返回 false，地址在进入本插件 `EditorHost` 之前就交给了宿主。宿主 documentpreview 当前源码里也没有「在浏览器中打开」动作（已核对 DSH checkout 的 `packages/client/ui-sidebar-documentpreview/src`）。

**结论**：源码里 image / pdf 的两个 `browserUrl` 在当前架构下没有落点；硬要恢复只能重新注册这两个 viewer，与「把只读预览让给宿主」的现行契约冲突，不建议。**PDF 已按 §10 追加为文件树右键入口**，不经过 viewer；图片仍不做。若以后也要覆盖图片，复用同一入口即可。

### 2.2 EditorHost header：结构相同，插入点明确

`src/client/EditorHost.tsx`：

- `const service = ctx.get('betterSidebar')`（`:197`），已有服务句柄。
- `refreshFile`（`:164`）已经是「dirty 时 `window.confirm(t('refreshUnsavedConfirm'))`，取消则不刷新」的范式。
- 脏状态发布到 `editor-dirty` 的 effect 在 `:347`；tab 卸载时会 `clearEditorDirty`。
- header 的刷新按钮在 `:629-637`，文件树按钮在 `:641-646`；新按钮插在这两者之间即可。
- 当前 header 的按钮全部是 14px 图标 + `css.iconButton`，新按钮复用同一形状（`VscLinkExternal` 已在 `FileTree.tsx` 使用，`react-icons` 已是依赖）。

### 2.3 URL 与路由：比源码更成熟，直接复用

- `htmlUrl(scope, path)`（`src/client/api.ts:742`）已经是**页面前缀安全**的：内部走 `hostRouteUrl()` + `encodeHtmlUrl()`，反代子路径、UNC、Windows 盘符、`~` 都由既有契约处理。源码 0.18 的 `htmlUrl` 还是相对路径，当前版本不能照抄字符串拼接。
- `/sidebar/html` 已经带 CSP：`sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'`（`src/index.ts:1726`），顶层打开仍是 opaque origin。
- `/sidebar/file` 当前是**流式**路由（`src/index.ts:1614` 起），头部计算在 `:1645-1663`，只对 `image/svg+xml` 加了：
  - `content-security-policy: sandbox; object-src 'none'`
  - `x-content-type-options: nosniff`
  - `referrer-policy: no-referrer`

目标调用链（本次移植后）：

```text
header button
  → viewer.browserUrl(scope, path)          // builtin html → htmlUrl()
  → hostRouteUrl(encodeHtmlUrl(...))        // 页面前缀安全；不手拼 URL
  → window.open(url, '_blank', 'noopener')
  → GET /sidebar/html/<session>/<path>      // fence → 路径解析 → 流式响应 + CSP sandbox
  → service.closeTab(tab.id, scope)         // 原生承载面优先，底部工作台回落
```

**当前缺口（重要）**：`MEDIA_TYPES` 把 `.html` / `.htm` 映射为 `text/html`，但媒体路由没有给它们加 CSP。工作区里的恶意 `.html` 被顶层导航到 `/sidebar/file?...` 时会以 GUI 同源执行脚本，能读 localStorage / 调 `/sidebar/api/*`。这不是本特性引入的新问题，但「在浏览器中打开」把媒体 URL 正式暴露为顶层导航入口，源码因此把加固放在同一个 PR。**本次必须一起修**。

### 2.4 关闭与草稿：已有统一守卫，但不能重复弹两次

- `service.closeTab`（`src/client/service.ts:1293`）先尝试原生承载面 `surface.close()`，再回落底部 reducer；两套承载面都能关。
- `editor-dirty.ts` 用 `sessionId::tabId` 记账；`confirmDiscardDraft()`（`:125`）是侧边栏 X / 中键 / 右键菜单 / 树改名删除共用的关闭守卫。
- **从 header 按钮关闭时走的是 `service.closeTab` 直调，不会经过 `Sidebar.tsx` 的 `closeTab` action，因此不会自动弹 `closeUnsavedConfirm`。** 这正是源码要自己加 `openBrowserCloseConfirm` 的原因。
- 草稿确认采用 `toolbar?.dirty`（当前 header 已经持有即时状态），沿用 `refreshFile` 的「`window.confirm` 不可用则拒绝」写法；确认后关闭，tab 卸载 effect 会清掉 dirty 记录。**不要**在同一个点击里再调 `confirmDiscardDraft`，否则会多弹一次或使用不同文案。

### 2.5 i18n / 测试 / 文档

- 词典：`src/client/locales.ts`（zh + en）+ `src/client/locales-*.ts` 19 份 = **21 份词典**；`browserOpenExternal` 已全量存在，`openBrowserCloseConfirm` 全量缺席。
- `tests/locales.spec.ts` 的 key-set 门禁要求 zh / en / 19 份第三语言完全同键。
- 现有测试落点：
  - `tests/builtins.spec.ts:234` 的 `built-in file viewer registrations`；
  - `tests/editor-host.spec.tsx:528` 的 header toolbar 用例；
  - `tests/file-stream-route.spec.ts` 已有流式媒体路由/头部/`download=1`/SVG CSP 用例；
  - `tests/consumer-types.ts:87` 的外部 viewer 类型夹具；
  - `tests/base-path.spec.ts` 已有 `htmlUrl` 前缀用例。
- 文档：`docs/external-plugin-guide.md` 的 §5.1 字段表在 `:487`，`load?` 在 `:504`；§5.4 内置 viewer 说明在 `:568`；§6 媒体路由段在 `:704`。当前没有 `browserUrl`，也没有 inline 安全契约。
- `CHANGELOG.md` 当前顶部是 `### v0.28.0`，没有 Unreleased 段；用户可见条目按仓库惯例在发版时落版（或实施 PR 先加下一版小节，二者择一，保持一致）。

### 2.6 桌面壳：这是本分支相对 0.18 新增的真实约束

- `desktop-env.ts:53` 的 `hostHttpBase()` 在桌面下返回 `document.baseURI`，即 `dsh-app://app/`；`htmlUrl()` 因此产出 `dsh-app://app/sidebar/html/...`。
- DSH checkout 的 `apps/desktop/lib/main.js:11971` 主窗口 `setWindowOpenHandler`：只有 `http:` / `https:` 会 `shell.openExternal(url)`，其余 `{ action: 'deny' }`。`dsh-app://` 的新窗口被直接拒绝，用户看不到任何反应。
- 桌面壳对 `dsh-app://app/*` 的请求走 `forwardWebRequest`（同文件 `main.js:8268`），认证 cookie 由**壳进程持有**并注入；系统浏览器没有这个 cookie，所以即使改用手工拼的 `http://127.0.0.1:<port>/sidebar/html/...`，新 Tab 也会被 `ctx.connection.requestRejection()` 判 401。
- **结论**：在当前 DSH 能力下，桌面壳没有「打开到系统浏览器且仍带登录态」的公开路径。本期应在桌面壳隐藏按钮；不要用 `file://` 或裸 host URL 作为静默降级。

---

## 3. 差异矩阵

| 源实现 | 当前 0.28 | 适配动作 |
|---|---|---|
| `FileViewerDescriptor.browserUrl` 不存在 | 无该字段 | 纯增量可选字段，加在 `load?` 之后 |
| image/pdf/html 三个声明 | 只剩 html viewer | 只给 html 加 `browserUrl: htmlUrl` |
| `htmlUrl` 是相对路径 | `htmlUrl` 已前缀安全 | 原样复用，不手拼 URL |
| `window.open` + `closeTab` | `closeTab` 支持原生 + 底部 | 原样调用；补两套承载面的测试/手测 |
| `toolbar.dirty` + `window.confirm` | 已有 `refreshFile` 同款范式 + dirty 注册表 | 沿用 `refreshFile` 的安全 confirm；不要重复走 `confirmDiscardDraft` |
| `mediaHeadersFor` 加在所有 inline 响应 | 流式路由 + 仅 SVG CSP | 抽 helper，替换 SVG 分支，统一所有 inline；保留 streaming |
| 源按当时词典数同步 | 21 份（zh/en + 19） | 新增 key 到全部 21 份；译文可直接取 `38602c0` |
| 无桌面壳考虑 | `dsh-app://` 新窗口被 deny | 增加 http(s) 页面门控；桌面隐藏；文档记录 |
| `tests/file-route.spec.ts` | 已有 `tests/file-stream-route.spec.ts` | 在现有 spec 增补，不另起重复路由测试 |
| 0.18 的 image/pdf 按钮 | 宿主 documentpreview 接管 | PDF 走文件树右键（§10）；image 不做 |

---

## 4. 设计决策

### D1. API：`browserUrl` 是可选、纯增量、无 feature flag

```ts
// src/client/service.ts（FileViewerDescriptor，load 之后）
/**
 * Browser-renderable URL for the editor header's "open in browser" button
 * (a REAL new browser tab). Declare it only when the browser can natively
 * render the type; absent = the button stays hidden.
 */
browserUrl?: (scope: SessionScope, path: string) => string
```

- 不加 `features` 串：外部消费者直接看 descriptor 字段即可；现有 `features` 是**服务能力**开关，不是字段清单。
- 不抬 `SIDEBAR_SERVICE_VERSION`：该常量跟 `package.json` 版本走，发版时统一抬；本特性没有运行时协商需求。
- 不改 `FileFetchStrategy`、不改 `download` / `mediaUrl` 语义。

### D2. 可见范围：内置 html 走 header；PDF 走文件树；image 不做

- 当前 `EditorHost` 看不到 host-owned 扩展名（§2.1），所以 image/pdf 没有挂 header 按钮的位置。
- **PDF**：既然 `EditorHost` 收不到 PDF，就不能靠 `browserUrl`。追加**文件树右键「在浏览器中打开」**（§10），用 `mediaUrl()` 生成 URL；不恢复 PDF viewer，也不碰宿主 documentpreview。
- 外部插件仍可为自己的 viewer 声明 `browserUrl`，前提是该 viewer **仍能收到文件**（图片/PDF 已被宿主 `HOST_OWNED_EXTS` 接管，经本服务注册的图片/PDF viewer 不会进入 `EditorHost`）。URL 必须是浏览器可渲染的 http(s) 地址；按 §6 的 `hostRouteUrl()` 规则生成，不要 value-import 内部 `api.ts`。
- **图片**：本期不做；如果后续要做，复用 §10 的文件树入口即可。

### D3. URL：复用 `htmlUrl()`，不手拼

- `browserUrl: (scope, path) => htmlUrl(scope, path)`。
- `htmlUrl` 已经处理：相对路径按 session cwd 解析、反代前缀、UNC、盘符、`~`。
- 顶层打开 `/sidebar/html` 的 CSP 已存在，不需要为按钮新增路由或头部。
- 不要在 `browserUrl` 里返回 `file://` 或 `dsh-app://`；按钮契约只接受真实浏览器可访问的 http(s) URL。

### D4. 按钮：位置、图标、条件、点击

- 位置：刷新按钮与文件树按钮之间（源码顺序；当前 header 的 `toolbar` 条件按钮之后）。
- 图标：`VscLinkExternal`，`size={14}`（与现有 header 图标一致；宿主 icon 默认 16，这里显式 14 是既有惯例）。
- 文案：复用 `t('browserOpenExternal')`（aria-label + title），零新增按钮文案。
- 显示条件：`load.status === 'ready' && load.viewer.browserUrl !== undefined && canOpenInBrowser()`。
  - `canOpenInBrowser()` 建议放 `desktop-env.ts`：`hostHttpBase()` 的协议为 `http:` / `https:` 才为 true；空值 / 解析失败 / `dsh-app:` 都是 false。
  - 这样桌面壳不渲染按钮，而不是渲染一个空操作。
- 点击：
  1. 再次收窄 `load.status` / `browserUrl`（TypeScript 窄化 + 防御）；
  2. `toolbar?.dirty === true` 时 confirm（`typeof window.confirm === 'function'` 才可用，不可用则拒绝）；
  3. `window.open(load.viewer.browserUrl(scope, path), '_blank', 'noopener')`；
  4. `service?.closeTab(tab.id, scope)`。
- 不缓存 URL：每次点击按当前 `path` / `scope` 计算，避免 in-place 换文件后拿旧地址。

### D5. 关闭与草稿：一次确认，绝不静默丢

- 新 key `openBrowserCloseConfirm`，文案照抄 0.23/0.24 的 zh / en：
  - zh：`在浏览器中打开并关闭此标签页，将丢弃未保存的编辑。继续吗？`
  - en：`Open in browser and close this tab? Unsaved edits will be discarded.`
- 使用 `toolbar?.dirty` 作为即时判据；确认后直接 `closeTab`。tab 卸载时 `clearEditorDirty` 会清账。
- `confirm` 不可用时，与 `refreshFile` 一致：**不继续**（宁可少开一次，也不静默丢草稿）。
- 不调用 `confirmDiscardDraft`：那是侧边栏关闭路径的守卫，走它需要 dirty 注册表已同步，且文案是通用的 `closeUnsavedConfirm`；本入口需要专用文案与即时 `toolbar.dirty`。
- 关闭用 `scope`（含 cwd）传给 `service.closeTab`，与源码/0.24 移植一致。

### D6. 媒体路由：所有 inline 响应统一 sandbox

- 新增常量与纯函数（位置放在 `mediaTypeForPath` 之后，`src/index.ts:131` 附近）：

```ts
export const MEDIA_INLINE_CSP = "sandbox allow-scripts allow-downloads; object-src 'none'"

export function mediaHeadersFor(path: string, download: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': mediaTypeForPath(path),
    'cache-control': 'no-cache',
  }
  if (download) {
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`
  } else {
    headers['x-content-type-options'] = 'nosniff'
    headers['referrer-policy'] = 'no-referrer'
    headers['content-security-policy'] = MEDIA_INLINE_CSP
  }
  return headers
}
```

- 路由改为：
```ts
const headers = mediaHeadersFor(path, url.searchParams.get('download') === '1')
await streamFileToResponse(path, info.size, res, headers)
```
- 删除 `const type` 与 `if (type === 'image/svg+xml')` 分支；**不要**在 helper 之外再叠一份 SVG 头，避免重复/漂移。
- 为什么包含 `.html` 和所有类型：`.html` 是 `text/html`，顶层导航会执行脚本；`.svg` 在 `image` 扩展名集合里且可脚本化；未知类型也可能被浏览器 sniff。`sandbox` 让顶层文档处于 opaque origin，`allow-scripts` 让页面自身的脚本仍可运行（但拿不到 GUI 的源），`allow-downloads` 保留浏览器保存能力，`object-src 'none'` 禁插件嵌入。**不能**加 `allow-same-origin`。
- **有意的行为变化**：当前 SVG 的 CSP 是 `sandbox; object-src 'none'`（禁脚本）；替换后 SVG 文档允许脚本运行，但仍在 opaque origin，拿不到 GUI 源。测试要把这条新契约钉住，不再断言旧的 no-scripts 头。
- `download=1` 分支保持现状：attachment、无 CSP、无 nosniff/referrer。
- 流式语义不变：helper 只产生头，`streamFileToResponse` 仍负责 `content-length` 与打开失败的错误信封。

### D7. 桌面壳：本期隐藏，后续单独做能力

- 门控实现：`canOpenInBrowser()` 读 `hostHttpBase()` 的协议；桌面返回 false。
- 文档写明：`browserUrl` 是 Web 部署能力；桌面壳的 `dsh-app://` 页面不提供该按钮。
- 后续可选路径（均需 DSH 侧能力或单独评审，不在本 PR）：
  1. 宿主签发一次性登录 URL，插件通过 `open.external` 交给系统浏览器；
  2. 桌面本地文件用 `file://` 经 `open.external` 打开（会失去 `/sidebar/html` 的 CSP 与相对资源路由，且不适用于远程 host，需安全评审）；
  3. 使用桌面壳内置的 browser tab（不是系统浏览器，语义不同）。
- 不要在没有 cookie 的情况下把 `http://127.0.0.1:<port>/sidebar/html/...` 交给系统浏览器：会 401，比隐藏更差。

### D8. 不做的事

- 不恢复 image / pdf / binary-download viewer；
- 不给 markdown / code / jsonl 加 `browserUrl`；
- 不新增按钮文案（只新增确认文案）；
- 不改 DSH 源码、不改宿主 documentpreview；
- **PDF 的文件树右键入口是本次追加需求（§10）**，不属于「不加」；图片仍不加；
- 不新增轮询、不新增 socket、不改变 tab 生命周期。

---

## 5. 实施计划

### 5.1 客户端 API 与内置 viewer

1. `src/client/service.ts:385` 的 `FileViewerDescriptor`，在 `load?`（`:404`）之后加 `browserUrl?`。
2. `src/client/builtins/viewers.tsx`：从 `../api.ts` 引入 `htmlUrl`；在 html descriptor（`:66`）的 `fetchStrategy: 'fsRead'` 之后加：
   ```ts
   browserUrl: (scope, path) => htmlUrl(scope, path),
   ```
   注释说明：走 sandboxed `/sidebar/html`；`htmlViewerNoSandbox` 只管编辑器内 iframe 的 sandbox 属性，不影响顶层 URL 的 CSP。
3. `tests/consumer-types.ts:87` 的 `viewer` 夹具加 `browserUrl`，保证外部插件类型面被 `pnpm check:consumer-types` 覆盖。
4. 不新增依赖 / chunk：`htmlUrl` 与 `react-icons/vsc` 都已在客户端核心图里（`EditorHost` 已 import `api.ts` 与 `FileTree.tsx`）；不改 `CHUNK_NAMES`、不改 `package.json`。

### 5.2 EditorHost 按钮、关闭、桌面门控

1. `src/client/desktop-env.ts` 加 `canOpenInBrowser()`（或同义命名）：
   ```ts
   export function canOpenInBrowser(): boolean {
     const base = hostHttpBase()
     if (base === '') return false
     try {
       const protocol = new URL(base).protocol
       return protocol === 'http:' || protocol === 'https:'
     } catch {
       return false
     }
   }
   ```
2. `src/client/EditorHost.tsx`：
   - import `VscLinkExternal`（`react-icons/vsc`）、`canOpenInBrowser`；
   - 在刷新按钮与文件树按钮之间插入条件按钮（§D4 的点击逻辑）；
   - 用已有的 `service` 变量关 tab（`:197`），不要新增 `ctx.get` 调用。

   代码骨架（仅为形状示意，最终以现有 header 的 class/aria 写法为准）：

   ```tsx
   {load.status === 'ready' && load.viewer.browserUrl !== undefined && canOpenInBrowser() && (
     <button
       type="button"
       className={css.iconButton}
       aria-label={t('browserOpenExternal')}
       title={t('browserOpenExternal')}
       onClick={() => {
         if (load.status !== 'ready' || load.viewer.browserUrl === undefined) return
         if (toolbar?.dirty === true) {
           const confirmed = typeof window.confirm === 'function'
             ? window.confirm(t('openBrowserCloseConfirm'))
             : false
           if (!confirmed) return
         }
         window.open(load.viewer.browserUrl(scope, path), '_blank', 'noopener')
         service?.closeTab(tab.id, scope)
       }}
     >
       <VscLinkExternal size={14} />
     </button>
   )}
   ```

3. 视觉检查：窄侧栏（240px 左右）下 header 的路径输入仍可收缩；若图标按钮 + 模式切换拥挤，优先保持 icon-only，不引入长文案按钮。

### 5.3 媒体路由加固

1. `src/index.ts` 加 `MEDIA_INLINE_CSP` + `mediaHeadersFor`（§D6）。
2. `/sidebar/file` 路由改用 helper，删除 SVG 特判；保持 `streamFileToResponse`。
3. 复查 `src/index.ts` 顶部 `basename` 已在导入列表中（当前已有），不需要新增 import。
4. 复查 `tests/smoke.spec.ts` 的 SVG 安全用例：它只断言 `contains('sandbox')` / `nosniff`，新头仍通过；`download` 用例断言 CSP 为 undefined，仍通过。

### 5.4 i18n

在以下 20 个文件的 `browserOpenExternal` 之后插入 `openBrowserCloseConfirm`（zh / en 在 `locales.ts`，其余各自一份）：

```
src/client/locales.ts            // zh + en
src/client/locales-ar.ts         src/client/locales-de.ts
src/client/locales-fr.ts         src/client/locales-hi.ts
src/client/locales-id.ts         src/client/locales-it.ts
src/client/locales-ja.ts         src/client/locales-ko.ts
src/client/locales-nl.ts         src/client/locales-pl.ts
src/client/locales-pt.ts         src/client/locales-ru.ts
src/client/locales-sv.ts         src/client/locales-th.ts
src/client/locales-tr.ts         src/client/locales-vi.ts
src/client/locales-zh-HK.ts      src/client/locales-zh-MO.ts
src/client/locales-zh-TW.ts
```

- 19 份第三语言可直接取 `38602c0` / `6a36422` 的译文；`locales-ja.ts` 必须同步（AGENTS §5）。
- `locales.spec.ts` 的 key-set 门禁会兜底；不需要为它新增用例。

### 5.5 文档与变更记录

- `docs/external-plugin-guide.md`：
  - §5.1 字段表（`:487-506`）加 `browserUrl?` 一行；
  - §5.4 内置 viewer 说明（`:568`）加一句：内置只有 html 声明；image/pdf 的预览由宿主接管，其中 PDF 另有文件树右键入口（§10，不经过 viewer）；
  - §6 媒体路由段（`:704`）加 inline 安全契约 blockquote（所有非 `download=1` 响应带 CSP sandbox / nosniff / no-referrer；`download=1` 不带）；同时提醒外部 viewer 用 `hostRouteUrl()` 生成 URL，不要 value-import 内部 `api.ts`。
- `CHANGELOG.md`：用户可见条目（「编辑器 header 增加在浏览器中打开（html viewer）；点击后关闭侧边栏 tab；文件树右键 PDF 在浏览器中打开；媒体路由 inline 响应统一 sandbox」）。按仓库惯例在下一版小节落版，或先加 `### Unreleased`（二者择一，不要同时存在两套写法）。
- 实施 PR 同时在 `docs/cyan/2026-10-21-open-in-browser-port-record.md` 留一份设计/偏差记录（可从源设计文档 `2026-08-31-open-in-browser-design.md` 改写）；本文件是移植规划，实施记录是另一份文档。

### 5.6 测试清单

| 文件 | 新增/修改用例 |
|---|---|
| `tests/builtins.spec.ts` | html 的 `browserUrl` 存在且返回 `htmlUrl()` 的绝对 URL；markdown / code / jsonl 均为 `undefined`；期望值需按当前 `hostRouteUrl` 写绝对形式（`browser-globals.ts` 的 `document.baseURI` 桩是 `http://localhost/`，期望 `http://localhost/sidebar/html/...`），不能照抄 0.23 的相对路径断言 |
| `tests/editor-host.spec.tsx` | 注册带 `browserUrl` 的 fake viewer → 按钮出现；点击后 `window.open` 收到 `(url, '_blank', 'noopener')` 且底部 tab 被移除；无 `browserUrl` → 按钮缺席；脏 viewer + confirm 取消 → 不开不关；confirm 接受 → 开且关；用 mock/开关让 `canOpenInBrowser()` 返回 false → 按钮缺席 |
| `tests/file-stream-route.spec.ts` | `mediaHeadersFor` 的 inline 分支对 `.html` / `.svg` / `.txt` / `.png` 都给 CSP + nosniff + no-referrer；`download=1` 无 CSP 且有 RFC 5987 disposition；流式字节/大文件/错误信封用例保持通过；SVG 的期望 CSP 从 `"sandbox; object-src 'none'"` 改为 `MEDIA_INLINE_CSP` |
| `tests/consumer-types.ts` | 加 `browserUrl`，`pnpm check:consumer-types` 通过 |
| `tests/base-path.spec.ts` | 直接测 `canOpenInBrowser()`：`https://host/...` / `http://...` 为 true，`dsh-app://app/` 为 false（`withPageBase` 已有）；可选：反代前缀下断言内置 `browserUrl` 仍带前缀 |
| `tests/e2e/mount.e2e.ts` 或新 `tests/e2e/open-in-browser.e2e.ts` | 建议：seed 一个带脚本/相对资源的 `.html`；点击按钮后用 `page.context().waitForEvent('page')` 接住新 Tab；断言新 Tab URL 是 `/sidebar/html/`、正文渲染、`window.opener === null`，且脚本拿不到 GUI 源（`location.origin === 'null'`）。这是唯一能证明 top-level 导航不被 401 挡住的部署级用例 |
| `tests/locales.spec.ts` | 不新增用例；跑一遍确认 21 份 key-set 通过 |

> `tests/editor-host.spec.tsx` 顶部 mock 了 `../src/client/api.ts`（只导出 `api` / `mediaUrl` / `downloadUrl` 等，不含 `htmlUrl`）。本用例用 fake viewer 返回字面 URL 即可；不要在该文件里 import 内置 html viewer，否则要同步扩 mock。

### 5.7 建议的提交拆分

1. `fix(media): sandbox every inline /sidebar/file response`——只含 `src/index.ts` + `file-stream-route.spec.ts`。这是独立的安全修复，可先合。
2. `feat(editor): open-in-browser header button for the html viewer`——`service.ts` + `viewers.tsx` + `EditorHost.tsx` + `desktop-env.ts` + 词典 + builtins/editor-host/consumer-types 测试。
3. `feat(files): open PDF rows in the browser`——`open-in-browser.ts` + `FileTree.tsx` + 新 `file-tree-open-in-browser.spec.tsx` / `open-in-browser.spec.ts` + 指南/CHANGELOG 的 PDF 说明（依赖第 1 笔的 CSP 与第 2 笔的 `canOpenInBrowser`）。
4. `docs: open-in-browser port record`——指南、CHANGELOG、`docs/plans`（如采用）。

四笔可同 PR，也可先合第 1 笔降低风险；但**第 2、3 笔都不应在没有第 1 笔的情况下上线**（至少在同一个 PR 里）。

---

## 6. 验证与验收

### 6.1 命令

```bash
pnpm vitest run \
  tests/editor-host.spec.tsx \
  tests/builtins.spec.ts \
  tests/file-stream-route.spec.ts \
  tests/file-tree-open-in-browser.spec.tsx \
  tests/open-in-browser.spec.ts \
  tests/locales.spec.ts \
  tests/base-path.spec.ts

pnpm typecheck
pnpm lint
pnpm check:consumer-types
pnpm build
pnpm pack && pnpm test:mount
```

- `test:mount` 需要 `NODE_OPTIONS=--max-old-space-size=4096`；不要加 `--legacy-peer-deps`（AGENTS §2）。
- 完整 `pnpm test` 在合入 `dev` 前跑一遍；Windows lane 用 `pnpm test:windows`。

### 6.2 真实浏览器手测矩阵

| 场景 | 期望 |
|---|---|
| Web / 正常 origin 打开 `.html` | header 出现按钮；新 Tab 渲染页面、相对 CSS/图片加载；`window.opener === null`；`location.origin === 'null'` |
| 反代子路径 | 新 Tab URL 带前缀；页面与资源都 200 |
| 桌面壳（`dsh-app://app/`） | 按钮不显示（若按 D7 门控）；控制台无 `window.open` 报错 |
| 未保存草稿 | 点击先 confirm；取消 → 不开、不关；确认 → 开、关 |
| markdown / code / jsonl | 按钮不出现 |
| 文件树右键 PDF | 出现「在浏览器中打开」；新 Tab 打开 `/sidebar/file` 的 PDF，浏览器 PDF 查看器正常渲染 |
| 文件树右键非 PDF / 目录 | 不出现该菜单项 |
| 桌面壳 | PDF 菜单项也不显示（同一 `canOpenInBrowser` 门控） |
| 外部 viewer 声明 `browserUrl` | 按钮出现，URL 为声明的 http(s) 地址 |
| 侧边栏 tab 在原生右栏 / 底部工作台 | 两种承载面点击后都能关闭对应 tab |
| 直接顶层打开 `/sidebar/file?...html` | 响应带 CSP sandbox / nosniff / no-referrer；脚本无法读 GUI localStorage；`<img>` 嵌入不受影响 |
| `?download=1` | 仍为 attachment，带 UTF-8 文件名，无 CSP |
| 弹窗拦截器开启 | 点击仍是用户手势；若被拦截，保持已知限制（不做自动降级） |

### 6.3 验收清单

- [ ] `browserUrl` 只出现在 html 内置 viewer；markdown / code / jsonl 无。
- [ ] 按钮只在 ready + 声明了 `browserUrl` + Web 页面时显示。
- [ ] 点击 URL 与 `htmlUrl()` 逐字符一致；`_blank` + `noopener`。
- [ ] 关闭调用带 `scope`，原生 / 底部两种承载面都验证。
- [ ] dirty 取消不产生任何副作用；确认才开 + 关。
- [ ] 所有 inline `/sidebar/file` 响应有 CSP / nosniff / no-referrer；download 分支没有。
- [ ] 21 份词典 key-set 通过；`locales-ja` 有译文。
- [ ] 指南 §5.1 / §5.4 / §6 同步；CHANGELOG 有条目。
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm check:consumer-types` / `pnpm build` / `pnpm test` / `pnpm test:mount` 通过。
- [ ] 桌面壳行为有明确记录（隐藏），没有静默坏按钮。
- [ ] 文件树右键 PDF 显示「在浏览器中打开」，非 PDF / 目录不显示；点击 URL 与 `mediaUrl()` 一致。
- [ ] PDF 在 Chromium 顶层可渲染（CSP sandbox 不阻断 PDF 查看器）；若阻断，已按 §10.4 决策并记录，不是静默去掉 CSP。

---

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 桌面壳按钮无效 | 用户点了没反应 | D7 门控隐藏；文档写明；后续另做宿主签发 URL |
| 媒体 CSP 影响 PDF/HTML 顶层渲染 | 外部 viewer/用户直接打开异常 | 用真实 Chromium 验证 `.pdf` / `.html` / `.svg`；PDF 是新增入口，必须作为上线门禁；必要时只对 `application/pdf` 做经过评审的类型特例 |
| CSP 影响 `<img>` 嵌入 | markdown 图片空白 | CSP 只作用于文档响应，`<img>` 不执行该文档的 CSP；手测 markdown 图片 |
| 脏草稿被静默丢弃 | 数据丢失 | `toolbar.dirty` + confirm；confirm 不可用则拒绝；tab 卸载清账 |
| 原生 / 底部关闭路径不一致 | 关不掉或关错 tab | `service.closeTab(tab.id, scope)` 是既有统一入口；两套承载面各测一次 |
| 窄侧栏 header 过挤 | 路径输入不可用 | 240px 手测；保持 icon-only；必要时调整顺序/间距 |
| i18n 漏 key | `locales.spec` 红 / ja 回退 en | 21 份同批改，key 紧跟 `browserOpenExternal` |
| 反代/UNC/Windows 路径 | 新 Tab 404 | 直接复用 `htmlUrl()`；`base-path.spec` + `paths.spec` 已覆盖 |
| `browserUrl` 返回非 http(s) | `window.open` 行为不可控 | 文档约定 http(s)；可选在 EditorHost 做协议校验（viewer 本身已是可信代码，非必须） |
| e2e 新 Tab 拿不到 cookie | 401 | 复用 `tests/e2e/host.ts` 的 cookie seeding；`window.open` 与页面同上下文 |

**回滚**：本特性是纯增量。回滚时移除 `browserUrl` 字段/按钮/词典 key 即可；媒体路由加固应**单独保留**（它修的是既有的顶层 HTML 同源脚本缺口，不依赖按钮）。

---

## 8. 任务拆分与顺序

| 任务 | 内容 | 依赖 | 规模 |
|---|---|---|---|
| T1 | `mediaHeadersFor` + 路由改造 + 头测试 | 无 | 小 |
| T2 | `browserUrl` 字段 + html viewer 接线 + consumer-types | 无 | 小 |
| T3 | EditorHost 按钮 / confirm / closeTab / 桌面门控 | T2 | 中 |
| T4 | 21 份词典 | T3 | 小 |
| T5 | builtins / editor-host / file-stream 测试补齐 | T1-T4 | 中 |
| T6 | 指南 / CHANGELOG / docs/plans（可选） | T2-T5 | 小 |
| T7 | PDF 文件树右键入口（§10） | T1、T2、T3 | 中 |
| T8 | 全量门禁 + 真机浏览器 + mount smoke | T1-T7 | 中 |

建议顺序：**T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8**。T1 可以先独立合入；T2/T3/T4/T5/T7 同一 PR。

流程上按 AGENTS §0：非文档改动从 `dev` 切 `feat/open-in-browser-0.28`，合回 `dev`；本地 `local/my-prs-0.28` 可用于先验证，最终以 `dev` 为集成目标。纯文档（本文件）可直接提交。

---

## 9. 待确认问题

1. **源分支名**：你说的「0.17 的 myprs」是否就是当前 checkout 的 `local/my-prs`（0.18.0 线）？如果不是，请给出分支/提交，我按同一行为重新核对。
2. **桌面壳**：接受「本期隐藏」吗？还是要求本期就做系统浏览器打开（需要先有 DSH 侧的 token 化 URL 能力）？
3. **图片 / PDF**：PDF 已按 §10 追加为文件树右键入口；图片是否也要复用同一入口？
4. **自动关闭 tab**：确认要保留 0.18 的行为（点击即关）吗？如果希望保留侧边栏 tab，应去掉 `closeTab` 与 `openBrowserCloseConfirm`。
5. **媒体 CSP 的 `allow-scripts`**：按源码使用 `sandbox allow-scripts allow-downloads; object-src 'none'`，还是对 PDF/SVG 改用更窄的策略？建议先按源码实现，再用真实 Chromium 验证 PDF/HTML/SVG 三类。
6. **e2e**：是否把新 Tab 用例加进 `test:mount` lane？建议加；如果只想先手工验证，需在 PR 里写明未自动化。

---

## 10. 追加需求：PDF 的「在浏览器中打开」

> 本节是 2026-10-21 追加的需求，优先于前文关于 PDF 的排除表述。结论：**PDF 不恢复 viewer，也不进 `browserUrl`；入口放在文件树右键菜单**。

### 10.1 为什么不能复用 header 按钮

- PDF 在 `HOST_OWNED_EXTS` 里（`src/client/native/index.ts:65`），插件的 `editor.canOpen` 对 `.pdf` 返回 false；宿主 documentpreview 直接接管，文件**永远不会进入本插件的 `EditorHost`**，所以 header 上没有可以挂按钮的 ready 状态。
- 重新注册一个插件 PDF viewer 来拿 header 按钮，等于把宿主已有的 PDF 预览（分页 / 缩放）复制一份，和「只读预览让给宿主」的现行契约冲突；不采用。如果产品坚持 header 按钮，唯一办法是把 `pdf` 从 `HOST_OWNED_EXTS` 移除并重新注册 viewer——那是另一个架构决定，需要单独评审，不建议夹在本次移植里。
- 文件树是插件自己的 UI，持有 `sessionId` / `cwd` / 行路径，已经用 `downloadUrl()` 做过下载；因此 PDF 的浏览器入口放在**文件树右键**，不需要碰 viewer 注册表。

### 10.2 行为定义

- **入口**：文件树中右键一个 `.pdf` 文件行 → 菜单出现「在浏览器中打开」（复用 `browserOpenExternal`，无需新文案）→ 点击在新 Tab 打开 `/sidebar/file` 的 inline PDF URL。
- **范围**：只对扩展名大小写不敏感的 `.pdf` 文件；目录、其他扩展名不出该项。文件夹窗口复用同一个 `FileTree`，会自动获得该项；搜索结果面板的右键菜单由[单独规划](2026-10-22-search-results-context-menu-plan.md)处理，PDF 项与本节共用 `open-in-browser.ts`。
- **门控**：与 header 按钮共用 `canOpenInBrowser()`；桌面壳（`dsh-app://`）隐藏，不交付空操作。
- **不确认、不关 tab**：PDF 是只读的，没有草稿；宿主 PDF 预览 tab 属于宿主，插件不能通过 `service.closeTab` 关闭，也不应越权操作，打开浏览器后保持原样。
- **URL**：`mediaUrl({ sessionId, cwd }, path)` → `GET /sidebar/file?sessionId=…&path=…&cwd=…`；不使用 `downloadUrl()`（那会强制落盘）。
- **失败**：`window.open` 抛错时走 `reportOpenFailure(path)` 的既有错误条；被弹窗拦截器返回 null 时无法与成功区分（`noopener` 下返回值本就是 null），保持已知限制，不自动降级。

### 10.3 实现

`src/client/FileTree.tsx`：

1. 先新增共享 helper `src/client/open-in-browser.ts`（`BROWSER_OPENABLE_EXTS` / `isBrowserOpenablePath` / `browserOpenUrl` / `openBrowserTab`，详见 [搜索结果右键菜单规划](2026-10-22-search-results-context-menu-plan.md) §4.1）。两个入口共用，避免文件树与搜索结果各写一份 PDF 判定/URL。
2. `FileTree.tsx` 导入：
   - 从 `./open-in-browser.ts` 加 `isBrowserOpenablePath` / `browserOpenUrl` / `openBrowserTab`；
   - 从 `./desktop-env.ts` 加 `canOpenInBrowser`；
   - `VscLinkExternal` 已在 `:55` 导入，直接复用；`MenuEntry` 已在 primitives 导入里。
3. 在 `downloadFile()`（`:1701`）旁边加：
   ```ts
   const openPdfInBrowser = (path: string): void => {
     if (!openBrowserTab(browserOpenUrl({ sessionId, cwd }, path))) reportOpenFailure(path)
   }
   ```
4. 在 `zipEntries()` 附近加一个只产出 0/1 项的 helper，避免把条件塞进 JSX：
   ```ts
   const openInBrowserEntries = (target: { path: string; isDir: boolean }): MenuEntry[] => {
     if (target.isDir || !isBrowserOpenablePath(target.path) || !canOpenInBrowser()) return []
     return [{
       id: 'open-in-browser',
       label: t('browserOpenExternal'),
       icon: <VscLinkExternal size={14} />,
     }]
   }
   ```
5. 菜单 `items`（`:2307` 附近）在「在侧边打开」之后、「下载」之前插入：
   ```tsx
   ...(rowMenu === null ? [] : openInBrowserEntries(rowMenu)),
   ```
6. `onSelect`（`:2385` 附近）在 `download` 分支之前加：
   ```ts
   if (id === 'open-in-browser') {
     openPdfInBrowser(target.path)
     return
   }
   ```
7. 不新增宿主路由、不改 `/sidebar/file`、不新增词典 key；复用 §D6 的 inline CSP。

文档侧：在 `docs/external-plugin-guide.md` §5.4 的「让给宿主的格式」附近加一句：**PDF 的「在浏览器中打开」在文件树右键，不经过 `browserUrl`**；§6 的媒体路由契约已覆盖 PDF 的顶层 CSP。`CHANGELOG.md` 的用户可见条目加「文件树右键 PDF 在浏览器中打开」。

### 10.4 安全与边界

- **PDF 顶层 CSP 是上线门禁**：PDF 走 §D6 的 inline 头 `sandbox allow-scripts allow-downloads; object-src 'none'`。必须在真实 Chromium 验证内置 PDF 查看器在该 CSP 下仍能渲染；若不能，**不要静默去掉 CSP**，而是三选一并记录：① 单独的、经评审的 PDF 路由/头部策略；② 退回宿主 PDF 预览（就不是“浏览器”了）；③ 暂缓 PDF 入口。不要把 `?download=1` 当作打开。
- **认证**：与所有 `/sidebar/*` 路由相同，顶层新 Tab 依赖浏览器已登录的 cookie；反代前缀由 `mediaUrl()` 的 `hostRouteUrl()` 处理；桌面壳隐藏（§D7）。
- **宿主 tab 不关**：PDF 的宿主预览 tab 不是插件 tab；打开浏览器后它仍在，这是有意的。
- **多选**：右键菜单总是作用于被右键的那一行；即使多选里还有别的 PDF，也只打开当前行，避免一次点击打开多个新 Tab。
- **文件夹窗口 / 搜索结果**：文件夹窗口复用同一个 `FileTree`，自动获得；搜索结果面板由单独规划加行级菜单，PDF 项共用同一 helper。
- **路径**：`mediaUrl()` 已处理相对路径、UNC、盘符、`~`；不新增路径逻辑。
- **可发现性**：菜单项只在 PDF 行出现；非 PDF 行不出现，避免让用户以为所有文件都能在浏览器里打开。

### 10.5 测试与验收

| 文件 | 用例 |
|---|---|
| `tests/file-tree-open-in-browser.spec.tsx`（新建，jsdom） | `api.ts` mock 补 `mediaUrl`（返回可断言的 URL）；树里有 `report.pdf` / `a.ts` / 目录 `sub`；右键 PDF → 菜单出现「Open in browser」；stub `window.open` → 点击后参数为 `(url, '_blank', 'noopener')`；右键 `.ts` / 目录 → 不出现该项 |
| `tests/open-in-browser.spec.ts`（新建） | 共享 helper：`isBrowserOpenablePath` 的大小写/非 PDF；`browserOpenUrl` 的前缀安全；`openBrowserTab` 的 `window.open` 参数与异常返回 |
| `tests/base-path.spec.ts` | `canOpenInBrowser()` 的 true/false 用例（与 §5.6 共用） |
| 既有 FileTree specs | 不点击 PDF 的用例不受影响；若某个 mock 需要 `mediaUrl`，只补该 mock，不批量改 36 份 api mock |
| 手工 | Web 正常 origin 与反代前缀下，PDF 新 Tab 正常渲染；桌面壳不显示菜单项；PDF 未登录/401 时不误报成功；`?download=1` 仍走下载 |

验收补充：

- [ ] 文件树右键 `.pdf` 出现「在浏览器中打开」；`.ts` / 目录 / 非 PDF 不出现。
- [ ] 点击后新 Tab URL 与 `mediaUrl()` 一致，`_blank` + `noopener`。
- [ ] PDF 在 Chromium 的 CSP sandbox 下可渲染；不可渲染时已有明确决策，不是静默移除 CSP。
- [ ] 桌面壳不显示该菜单项；宿主 PDF 预览 tab 不被误关。

### 10.6 本节的待确认

1. **图片**是否也要复用同一个文件树入口？本期只做 PDF；代码上的 `BROWSER_OPENABLE_EXTS` 很容易扩成图片集合。
2. **PDF CSP 失败的兜底**：如果 Chromium 的内置 PDF 查看器在 `sandbox` 下不渲染，是接受“暂缓 PDF”还是新开一个经评审的 PDF 专用路由？
3. **宿主预览 tab**：是否需要在打开浏览器后提示“侧边栏预览仍开着”，还是保持无提示？

---

## 附录：关键代码位置（当前分支）

| 位置 | 说明 |
|---|---|
| `src/client/service.ts:385` / `:404` | `FileViewerDescriptor` / `load` 字段，`browserUrl` 插在其后 |
| `src/client/builtins/viewers.tsx:66` | html viewer |
| `src/client/EditorHost.tsx:164` | `refreshFile` 的 confirm 范式 |
| `src/client/EditorHost.tsx:197` | `service` 句柄 |
| `src/client/EditorHost.tsx:347` | dirty 注册 / 卸载清理 |
| `src/client/EditorHost.tsx:629-646` | 刷新 + 文件树按钮，新按钮插在中间 |
| `src/client/api.ts:742` | `htmlUrl()` |
| `src/client/desktop-env.ts:53` | `hostHttpBase()` |
| `src/client/native/index.ts:65` | `HOST_OWNED_EXTS` |
| `src/index.ts:131` | `mediaTypeForPath()` |
| `src/index.ts:1614` | `/sidebar/file` 路由 |
| `src/index.ts:1645-1663` | 当前媒体头 / SVG 特判 |
| `src/index.ts:1726` | `/sidebar/html` 的 CSP |
| `src/client/editor-dirty.ts:125` | `confirmDiscardDraft()`（本入口不复用） |
| `src/client/service.ts:1293` | `closeTab()` 原生 + 底部 |
| `docs/external-plugin-guide.md:504` / `:568` / `:704` | 字段表 / 内置 viewer / 媒体路由 |
| `tests/builtins.spec.ts:234` | viewer 注册测试组 |
| `tests/editor-host.spec.tsx:528` | header toolbar 测试范式 |
| `tests/file-stream-route.spec.ts:125` / `:157` | 流式头 / SVG CSP |
| `tests/consumer-types.ts:87` | 外部 viewer 类型夹具 |
| `src/client/FileTree.tsx:1701` | `downloadFile()`，PDF 的 `openPdfInBrowser()` 放它旁边 |
| `src/client/FileTree.tsx:2307` / `:2385` | 菜单项数组 / `onSelect`，PDF 项与处理插在这里 |
| `src/client/paths.ts:104` | `extOf()`，判断 `.pdf` |
| `src/client/api.ts:674` | `mediaUrl()` |
| `CHANGELOG.md:5` | 当前版本小节 |
