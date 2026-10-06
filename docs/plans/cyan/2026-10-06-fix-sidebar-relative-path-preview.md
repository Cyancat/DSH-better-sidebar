# 修复规划：dsh-better-sidebar 相对路径 HTML 预览报错

- **创建时间**：2026-10-06 08:35
- **状态**：已实施（分支 `fix/relative-path-preview`，方案 A 修复点 1 落在 `src/client/native/index.ts` 的 `fileParamsOf`——deliverables 卡片实际走的是 native `openResource` 而非 `openSidebarFile`；修复点 2 兜底在 `src/client/EditorHost.tsx`；回归测试 `tests/editor-relative-path.spec.tsx` + `tests/native-surface.spec.ts` 新增 describe；版本 0.23.0-myprs.2 已打包并装入 web profile）
- **关联问题**：点击 present 卡片（相对路径文件）时，右侧侧边栏预览报错 `fs-error: cannot resolve target "/workspace/contract/..."`

## 1. 问题背景

在 DSH Web GUI（http://127.0.0.1:3080）中，点击 agent 通过 `present` 工具交付的文件卡片，文件应在右侧侧边栏（dsh-better-sidebar 插件）中预览。当卡片携带**相对路径**时，预览失败，页面显示原始 JSON 错误：

```json
{"ok":false,"error":{"code":"fs-error","message":"cannot resolve target \"/workspace/contract/杭发公司试车服务器升级及台架维修项目合同.html\": ENOENT: no such file or directory, realpath '/workspace/contract/...'"}}
```

真实文件位于 `/home/cyan/workspace/HQF_202608/workspace/contract/...`，文件本身无问题；绝对路径的卡片可正常预览。

## 2. 根因分析（错误链）

| 环节 | 位置 | 行为 |
|------|------|------|
| ① 存储 | DSH 核心 `tool-present`（`packages/deliverables/tool-present/src/index.ts:93`） | `files.push({ ...file })` 按原样存储相对路径，不做绝对化（设计如此，相对路径语义 = 会话工作目录） |
| ② 打开 | DSH 核心 `Deliverables.tsx`（`packages/client/ui-deliverables/src/client/Deliverables.tsx:111`） | `onPreview={() => openFile(file.path)}` 把相对路径传给文件打开器 |
| ③ 标签页 | dsh-better-sidebar 客户端 | 编辑器 tab 以相对路径打开（面包屑 `workspace/contract/...` 无前导 `/` 可证实）；`openSidebarFile`（`src/client/sidebar-file.ts:26`）本可用 `summary?.cwd` 解析为绝对路径，但未生效或未走到 |
| ④ 编码 | dsh-better-sidebar `encodeHtmlUrl()`（`src/html-route.ts:50`） | `.html` 匹配内置 HTML 预览器；该函数**假定输入必为绝对路径**，相对输入 `workspace/contract/x.html` 被照样编码为 `/sidebar/html/<sid>/workspace/contract/x.html` |
| ⑤ 解码 | dsh-better-sidebar `decodeHtmlUrl()`（`src/html-route.ts:103`） | 非 UNC、非盘符分支无条件补前导 `/`：`path = \`/${tail.join('/')}\``，相对路径被静默改写为根目录下的绝对路径 `/workspace/contract/...` |
| ⑥ 报错 | dsh-better-sidebar `ensureWorkspacePath()`（`src/path-security.ts:35`） | `requireAbsolute` 通过（已是绝对形式）→ `realpath('/workspace/contract/...')` → ENOENT → 抛出 `fs-error` |

**核心缺陷**：`encodeHtmlUrl`/`decodeHtmlUrl` 对相对路径不具备往返一致性（round-trip），相对路径在④→⑤之间被静默转换为以 `/` 开头的错误绝对路径。

**插件位置**：
- 已安装版本：`dsh-better-sidebar@0.23.0-myprs.1`，安装于 `~/.dsh/profiles/web/node_modules/dsh-better-sidebar/`（tgz 解包）
- 源码项目：`/home/cyan/agentdev/dsh/DSH-better-sidebar/`（修复应改源码后重新打包安装，**不要直接改 node_modules**）

## 3. 修复方案

### 方案 A：打开 tab 时统一绝对化（推荐）

在路径进入编辑器 tab 之前，确保相对路径已按会话 cwd 解析为绝对路径。

- 修复点 1：`src/client/sidebar-file.ts` 的 `openSidebarFile()`——确认 `summary?.cwd` 为何未生效（会话 summary 未挂载？cwd 字段为空？），必要时增加从 `session.cwd` API 回退获取的逻辑。
- 修复点 2（兜底）：`src/client/EditorHost.tsx` 打开/加载 tab 时，对非绝对路径调用 `resolveSidebarPath(scope.cwd, path)` 再使用。
- 优点：一处修复，所有 viewer（html/pdf/media 等基于 URL 路由的预览）同时受益；符合"host 是路径语义权威"的既有设计。
- 风险：低。`resolveSidebarPath` 已是现成工具函数，`DiffPane.tsx:259` 有正确用法可参照。

### 方案 B：viewer 层防御

在生成 `htmlUrl` 前做绝对化（`builtins/viewers.tsx`、`TextEditor.tsx:560` 等处）。

- 优点：改动面小、定位精确。
- 缺点：同类隐患仍存在于其他 URL 路由 viewer；属于治标。

### 方案 C：服务端兼容（不建议单独采用）

让 `/sidebar/html` 路由对解码出的路径再做一次会话 cwd 相对解析。

- 缺点：编码时"相对 vs 绝对"信息已丢失，服务端无法区分 `/workspace/...` 是用户本意还是相对路径被错误升格，无法安全实现。**排除**。

### 建议组合

**方案 A（修复点 1 + 修复点 2 兜底）为主**，方案 B 可选作为额外防御。

## 4. 实施步骤

1. 阅读 `/home/cyan/agentdev/dsh/DSH-better-sidebar/` 项目的构建/打包/安装流程（package.json scripts、output/ 下的 tgz 产物命名）。
2. 定位 `openFile` 从核心 `Deliverables` 到侧边栏 tab 的实际调用链，确认相对路径在哪一步本应被解析（重点排查 `openSidebarFile` 的 `summary?.cwd` 为空的原因）。
3. 按方案 A 修改源码。
4. 构建并打包新版本 tgz（版本号按项目惯例递增，如 `0.23.0-myprs.2`）。
5. 更新 `~/.dsh/profiles/web/package.json` 中的 tgz 引用并重装插件（按插件既有安装方式；必要时重启 `dsh web`）。
6. 回归验证：
   - 用相对路径 present 一个 `.html` 文件 → 点击卡片 → 侧边栏正常预览；
   - 用绝对路径 present → 正常预览（不回归）；
   - 普通文件树打开 html、markdown 预览、pdf 预览不回归；
   - 工作区围栏（workspaceFence）行为不变：工作区外路径仍被拒绝。

## 5. 临时绕过（已实施）

在插件修复前，agent 侧 `present` 时传**绝对路径**即可正常预览。已于 2026-10-06 对 `杭发公司试车服务器升级及台架维修项目合同.html` 用绝对路径重新 present 验证可行。

## 6. 备注

- DSH 核心侧（`tool-present` 存相对路径、`Deliverables` 原样传递）属于既定语义，不在本次修复范围内。
- 禁止直接修改 `~/.dsh/profiles/web/node_modules/` 下的已安装文件，改动会在下次安装时被覆盖。
