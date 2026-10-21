# 「在浏览器中打开」移植记录（0.28 / DSH 0.2.1-rc.1）

- 日期：2026-10-21（实施 2026-10-22）
- 基线：v0.28.0，DSH 0.2.1-rc.1
- 源实现：`feat/open-in-browser` / `local/my-prs`（0.18.0 线）的 `18d9b2f`、`4ae61f0`、`c470eb5`、`3285112`；0.24 线移植 `d7cb134`、`6a36422`；0.23 线移植 `3ae1c3b`、`38602c0`
- 规划：[../cyan/2026-10-21-open-in-browser-port-plan.md](../cyan/2026-10-21-open-in-browser-port-plan.md)（下称「规划」；§10 是 PDF 追加需求）
- 关联规划：[../cyan/2026-10-22-search-results-context-menu-plan.md](../cyan/2026-10-22-search-results-context-menu-plan.md) §4.1（共享 helper；搜索菜单本身不在本次范围）

## 功能

### 编辑器 header（html viewer）

- `FileViewerDescriptor.browserUrl?: (scope, path) => string` 为可选、纯增量的公开字段（外部 viewer 同享）。
- 内置只有 **html** 声明它：`(scope, path) => htmlUrl(scope, path)`，即带 CSP sandbox 的 `/sidebar/html` URL。markdown / jsonl / code 不声明，按钮不出现——浏览器对文本/代码只能 plain text 显示，没有价值（0.18 旧方案已因此被 reset）。
- 按钮位置在刷新按钮与文件树按钮之间，图标 `VscLinkExternal`（14px），文案复用 `browserOpenExternal`（无新增按钮文案）。
- 点击：`window.open(url, '_blank', 'noopener')` → `service.closeTab(tab.id, scope)`。关 tab 走既有统一入口，原生右侧栏与底部工作台两种承载面都成立。
- 脏草稿：`toolbar?.dirty === true` 时先 `window.confirm(t('openBrowserCloseConfirm'))`；取消则既不开也不关，`window.confirm` 不可用时按拒绝处理（不静默丢草稿）。**不**复用 `confirmDiscardDraft()`：那是侧边栏关闭路径的守卫，文案与判据都不同。
- 桌面壳门控：`canOpenInBrowser()` 只在页面基址协议是 `http:` / `https:` 时为 true。`dsh-app://app/` 下按钮隐藏——Electron 主窗口只把 http(s) 交给 `shell.openExternal`，其余一律 deny；手工拼 `http://127.0.0.1:<port>` 也没有壳进程的登录 cookie，会 401。

### 文件树右键（PDF）

- PDF 在 `HOST_OWNED_EXTS` 中，插件的 `EditorHost` 永远收不到它，所以不能靠 header 的 `browserUrl`。入口是文件树行菜单，仅对扩展名大小写不敏感的 `.pdf` 文件出现（目录、其他文件不出现），位置在「在侧边打开」之后、「下载」之前。
- URL 用 `mediaUrl(scope, path)`（inline `/sidebar/file`，**不是** `downloadUrl`），`window.open(url, '_blank', 'noopener')`。
- 不确认、不关 tab：PDF 只读；宿主 PDF 预览 tab 属于宿主，插件无权关闭。
- 桌面壳同样隐藏。`window.open` 抛错时走文件树既有的 `reportOpenFailure(path)` 错误条；被弹窗拦截器返回 null 无法与成功区分（`noopener` 下成功也返回 null），保持已知限制。

### 共享 helper

`src/client/open-in-browser.ts`：`BROWSER_OPENABLE_EXTS` / `isBrowserOpenablePath` / `browserOpenUrl` / `openBrowserTab`。文件树 PDF 入口使用它；未来的搜索结果右键菜单按关联规划复用同一套判定与 URL，不复制。

### 媒体路由加固（与按钮同批，必须）

`/sidebar/file` 的 inline 响应此前只对 SVG 加 `sandbox; object-src 'none'`，`.html` 仍以 `text/html` 顶层可导航且无 CSP，工作区脚本可与 GUI 同源执行。现在抽出 `mediaHeadersFor(path, download)`：

- 所有非 `download=1` 响应：`content-security-policy: sandbox allow-scripts allow-downloads; object-src 'none'`、`x-content-type-options: nosniff`、`referrer-policy: no-referrer`；
- `download=1`：仍是 attachment（RFC 5987 文件名），不带上述三个头；
- 流式语义不变：helper 只产生头，`streamFileToResponse` 继续负责 `content-length` 与打开失败的错误信封。

**有意的行为变化**：SVG 的旧 CSP（禁脚本）被统一策略替换——脚本仍可运行，但文档处于 opaque origin，拿不到 GUI 源。测试钉住新策略，不再断言旧的 no-scripts 头。

## 相对源实现 / 规划的偏差

| 项 | 处理 | 原因 |
|---|---|---|
| image / pdf viewer 声明 `browserUrl` | 不恢复 | 宿主 `ui-sidebar-documentpreview` 接管，插件编辑器看不到这些文件；恢复 viewer 与「只读预览让给宿主」契约冲突 |
| PDF 的浏览器入口 | 放到文件树右键（规划 §10） | header 没有 ready 状态可挂按钮；文件树持有 session/cwd/path |
| 图片的浏览器入口 | 本期不做 | 规划 §D2 / §10.6；`BROWSER_OPENABLE_EXTS` 很容易扩成图片集合，但产品上未确认 |
| 桌面壳 | 隐藏按钮/菜单项，不做降级 | 无带登录态的系统浏览器 URL；`file://` 或裸 host URL 都会失败或丢失 CSP |
| `window.confirm` 不可用 | 拒绝（不开不关） | 与 `refreshFile` 的 fail-closed 范式一致 |
| 新 e2e（新 Tab / CSP） | 本次未加入 `test:mount` lane | 规划 §5.6 / §9 建议但非验收硬要求；已由组件测试、路由 header 测试与真实 Chromium 手测覆盖，PR 需注明未自动化 |
| 版本号 | 词典新增 key 已进 21 份；`CHANGELOG` 先加 `### Unreleased` | 规划 §5.5 二选一 |

## 测试

- `tests/builtins.spec.ts`：只有 html 声明 `browserUrl`，且 URL 与 `htmlUrl()` 的绝对形式逐字符一致（含相对路径按 cwd 解析）。
- `tests/editor-host.spec.tsx`：按钮有无、`window.open` 参数、关 tab（含 scope）、脏草稿取消/确认、桌面基址隐藏。
- `tests/file-stream-route.spec.ts`：`mediaHeadersFor` 的 inline / download 两条分支；`.html` / `.svg` 的流式响应头；SVG 期望改为 `MEDIA_INLINE_CSP`。
- `tests/open-in-browser.spec.ts`：PDF 判定（大小写、伪扩展名、目录名里的点）、反代前缀下 URL、`window.open` 参数与异常。
- `tests/file-tree-open-in-browser.spec.tsx`：PDF 行出现菜单项并打开精确 `mediaUrl()`；普通文件 / 目录不出现；桌面基址隐藏。
- `tests/base-path.spec.ts`：`canOpenInBrowser()` 的 http(s) / `dsh-app:` / 空 / 非法基址，以及不因注入的 `streamBaseUrl` 而误开。
- `tests/locales.spec.ts`：21 份词典 key-set（`openBrowserCloseConfirm`，`locales-ja` 有译文）。

## 验证

```bash
pnpm vitest run \
  tests/editor-host.spec.tsx tests/builtins.spec.ts \
  tests/file-stream-route.spec.ts tests/open-in-browser.spec.ts \
  tests/file-tree-open-in-browser.spec.tsx tests/locales.spec.ts \
  tests/base-path.spec.ts
pnpm typecheck
pnpm lint
pnpm check:consumer-types
pnpm build
pnpm pack && pnpm test:mount
```

真实 Chromium 手测（规划 §6.2 的矩阵）：html 新 Tab 渲染、`window.opener === null`、`location.origin === 'null'`；PDF 在 CSP sandbox 下仍由内置查看器渲染；反代前缀；桌面壳不显示入口；markdown / code / jsonl 不显示按钮；dirty 取消/确认；`?download=1` 仍落盘。

> PDF 顶层 CSP 是上线门禁：若 Chromium 内置 PDF 查看器在 `sandbox` 下不渲染，不要静默去掉 CSP，按规划 §10.4 三选一（专用路由 / 退回宿主预览 / 暂缓入口）并记录。

## 回滚

纯增量：移除 `browserUrl` 字段、header 按钮、文件树菜单项与 `openBrowserCloseConfirm` 即可。**媒体路由加固应单独保留**——它修的是既有的顶层 HTML 同源脚本缺口，不依赖按钮。
