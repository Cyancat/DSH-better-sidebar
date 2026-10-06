# 修复规划：editor tab 切走再切回不再自动刷新（重挂载恢复）

- **创建时间**：2026-10-06 17:30（实施后补记）
- **状态**：已实施（`fix/editor-tab-remount-restore` 分支）
- **关联问题**：原生右侧栏中已打开的文件（editor tab），切去文件树再切回会自动重新拉取一次文件——页面上已有手动刷新按钮，用户不需要每次切换都自动刷新
- **前序文档**：[2026-10-06-fix-native-tab-view-lifetime.md](2026-10-06-fix-native-tab-view-lifetime.md)（record 生命周期修复；其 §6 预留了本条路线）

## 1. 根因

不是插件主动写的「切回刷新」，而是宿主挂载策略的连带效果：

| 环节 | 位置 | 行为 |
|------|------|------|
| ① 宿主策略 | DSH `ui-dockkit` `TabLayout.tsx` | 未声明 `keepMounted` 的 tab 类型是 **visibility-mounted**：tab 未选中即卸载 body，切回重挂载。editor kind 刻意不声明（每个打开的文件是一个 CodeMirror 实例，全量常驻不可扩展——前序文档 §3 的取舍，本方案不改） |
| ② 状态随 body 销毁 | `src/client/EditorHost.tsx` | `load`（useState）随卸载丢失，重挂载从 `loading` 重新开始 → 重新 `fsRead` → viewer 重建 = 用户看到的「自动刷新」 |
| ③ 连带数据丢失 | `src/client/TextEditor.tsx` | 未保存草稿只活在 CodeMirror view 里。手动刷新按钮丢弃草稿前会弹确认，而 **tab 切换触发的卸载没有任何确认**——脏草稿、光标、撤销历史被静默丢弃 |

前序文档 §6 已预言此需求并指定路线：「状态入 record + 重挂载恢复」，而不是给 editor kind 开 `keepMounted`。

## 2. 方案

新增 `src/client/remount-cache.ts`：**按 tab 实例键**（`${sessionId}::${tabId}`，不按路径——同一文件可开两个 tab）的两座模块级 LRU（上限 16）：

- **load 缓存**：一个 tab 最近一次 ready 加载（命中的 viewer + 拉取到的 payload + 所属 path）。`EditorHost` 重挂载时 `reloadSeq === 0` 且 path 匹配 → 直接恢复（useState 初始化即 ready，无 loading 闪烁、无 refetch）；手动刷新按钮 bump `reloadSeq` 永远绕缓存走文件系统。
- **draft 记忆**：TextEditor 的 CodeMirror view 销毁时若 dirty，捕获 `{base, text, mode}`；重挂载时 **base 仍等于当前 content 才恢复**（doc/脏标记/预览或编辑模式一并回来）。base 不匹配（文件被手动刷新过、被外部改动后重新拉取）绝不恢复——与刷新按钮的「确认丢弃」语义一致。

宿主没有「tab 隐藏」钩子（只有关闭时的 occurrence signal，已被 records 注册表消费），所以用 LRU 逐出而不是精确生命周期来界内存；关闭的 tab 条目自然老化出局。

### 关键边角（都是实现中真实踩到/推演过的）

1. **确认刷新不能被草稿记忆复活**：`refreshFile` 确认后先调 viewer 的 `discardDraft()`（`EditorToolbarControls` 新增的内部可选方法，清 dirty）并无条件 `dropRemountDraft`——否则卸载清理会在确认之后又把草稿写回记忆，文件内容没变时 base 相等，草稿当场复活。
2. **干净卸载只清同 base 的草稿**：`dropRemountDraftIfBase`——merged 模式原地切换 A→B 时 A 的脏草稿已在记忆里，B 的干净卸载不得把它带走（于是 A 切回来草稿还在）。
3. **toolbar 上报顺序**：恢复路径不能 `setToolbar(null)`——重挂载时 viewer 与首个 commit 同帧挂载，子组件 effect 先于父组件 load effect 运行，父级再清会抹掉刚上报的 toolbar（刷新按钮消失，单测真实捕获）。
4. **错误/二进制不缓存**：只写 ready 条目；手动刷新失败保留旧缓存，下次重挂载显示旧内容，符合「不自动刷新」语义。

## 3. 契约改动（内部字段，均向后兼容）

- `FileViewerProps.remountKey?: string`——EditorHost 传的 tab 实例键，外部 viewer 忽略无任何影响。
- `EditorToolbarControls.discardDraft?(): void`——内部可选方法。
- 已同步 [docs/external-plugin-guide.md](../external-plugin-guide.md) §5.2。

## 4. 测试

- `tests/remount-cache.spec.ts`（新）：LRU 上限、base 守卫、两种 drop 语义。
- `tests/text-editor-draft-remount.spec.tsx`（新）：真实 CodeMirror（jsdom 可挂载，首个真挂载 CM 的 spec）——脏草稿跨卸载/重挂载恢复（含 dirty 与 edit 模式）、base 变化不恢复、干净卸载不捕获、`discardDraft` 后不复活、同文件另一个 tab 不串草稿。
- `tests/editor-refresh.spec.tsx`：新增「visibility remount」组——重挂载零 refetch（且无 loading 闪烁）、重挂载后手动刷新仍 refetch、同 tab 换 path 仍 refetch；既有 4 个渲染 EditorHost 的 spec 一律在钩子中 `clearRemountCachesForTests()`（模块级缓存跨用例隔离）。

## 5. 验证记录

- `pnpm lint` / `pnpm typecheck`：干净。
- `pnpm test`：1498 绿 / 2 红——两红为 **base 分支既有**（`bc3e43d` 把 package.json 推到 `0.23.0-myprs.2` 但没同步 `SIDEBAR_SERVICE_VERSION` 与 `dsh.plugin.json` 两个镜像点，`git stash` 后在 base 上复现同样的 2 红），与本改动无关，未夹带修。
- e2e 挂载 lane 未跑（本改动不涉及挂载面/打包面；如合并前需要可补 `pnpm test:mount`）。

## 6. 遗留与边界

- **撤销历史与光标位置不保**：CodeMirror 实例仍重建（draft 只带文本与模式）。预览滚动位本就有模块级记忆（`previewScrollMemory`），不受影响。
- **缓存即陈旧**：切回显示的是缓存内容，磁盘上的外部改动要按手动刷新才进来——这正是需求本身（与 markdown-manual-refresh 既定的「不轮询」语义一致）。
- **viewer 在隐藏期间被禁用**：缓存的 descriptor 对象仍可渲染（引用仍在），不崩；下次手动刷新按新注册表重新匹配。
- 页面整刷后记忆不持久（纯内存结构），与前序文档 §6 的同一边界。
