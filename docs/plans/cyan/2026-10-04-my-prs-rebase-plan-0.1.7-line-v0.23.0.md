# my-prs 系列 rebase 到 0.1.7 线（v0.23.0）的规划

> 日期：2026-10-04　作者：cyan（agent 辅助分析）
> 状态：**已执行完毕（local/my-prs-0.23，单测 1468 全绿 + 挂载 lane 7/7 通过）**　范围：`my-prs2` 上的 open-in-browser 系列 → 0.1.7 本地维护线
> 文件名标记：本规划对应 **0.1.7 线（v0.23.0）**，随 `local/my-prs-0.23` 维护线分支走；
> 0.2.0 基线（v0.24.1）的对应规划在 `my-prs2` 分支的
> `docs/plans/cyan/2026-09-30-my-prs-rebase-analysis-0.2.0-baseline.md`（已执行完毕，产物即 `my-prs2`）。

---

## 0. 结论摘要（TL;DR）

1. **宿主冻结在 DSH 0.1.7 线，不升级** → 插件不能用 v0.24.x（peer 下限 `^0.2.0-rc.1`，会被宿主启动预检整行禁用，见 AGENTS §3.4 第 12 条），目标基线改为 **0.1.7 线终点 `f29743f`（v0.23.0）**，peer `^0.1.7-rc.1` 与宿主兼容。
2. **搬运源用 `my-prs2` 上的新版提交，不用 `local/my-prs` 的旧版**：0.23.0 与 0.24.1 代码几乎同构（唯一实质差异是 DSH 0.2.0 适配提交），而旧版隔着 0.16→0.21 的四轮硬破坏（settings 重写、图标改名、会话 v4、快照字段更换）。
3. **冲突预演（`git merge-tree`，不落盘）**：`d7cb134` cherry-pick 到 `f29743f` **完全干净**；`6a36422` 仅 2 个 docs 文件（`external-plugin-guide.md` + 设计文档）有上下文冲突，**代码零冲突**。
4. **tarball 输出到仓库内 `output/`（gitignore）**，经 `dsh plugin --profile web add file:<绝对路径>` 安装；版本号每次迭代 bump `-myprs.N`，保证「路径即内容」，被清理后重 pack 同名文件即可原地复活。
5. 产物是**纯本地维护线**（`local/` 前缀分支，不合 main，不适用 AGENTS §1 的 PR 门禁）；0.2.0 线的 `my-prs2` 原样保留，将来升级 DSH 时直接可用。

---

## 1. 背景与约束

- 本机 `~/.dsh/profiles/web` 当前安装 `dsh-better-sidebar@0.21.1`（registry 范围 `^0.21.1`），落后 0.1.7 线终点两个 minor；`headless` profile 未装此插件。
- 用户决定：**DSH 留在 0.1.7 线**，因此 v0.24.x 系列不可用，需要一个「0.1.7 线最新代码 + my-prs 系列改动」的本地构建来替换 0.21.1。
- my-prs 系列在两个分支上：
  - `local/my-prs`（基线 `a5c52b3`，0.16 时代）：文件树 rename/delete 已作为 PR #550 合入上游，**独有改动只剩 open-in-browser 系列**；
  - `my-prs2`（基线 `1499502`，0.24.1 之后）：`d7cb134`（编辑器头部「在浏览器打开」按钮）+ `6a36422`（移交浏览器后关闭侧栏 tab），另有 2 个规划文档提交（`1ca4994` / `222144e`，内容恰是「rebase 到 0.2.0 基线」的分析——方向已被本规划取代）。

## 2. 目标基线：`f29743f`（v0.23.0）

- `f29743f chore(release): v0.23.0` 是 main 历史上 0.1.7 线的最后一个提交（无 git tag；AGENTS 记载「0.1.7 线停留在 v0.23.0」）。
- peerDependencies 全部为 `^0.1.7-rc.1`（已核实），通过宿主 rc.1 起的启动期 peer 硬约束。
- 相对 0.21.1 多 46 个提交，含文件页/文件变动页重构、菜单层级与性能、ZIP 进度、「在侧边打开」修复等。
- 该基线的 e2e 挂载 lane 钉的宿主就是 0.1.7-rc.1，与本机环境天然匹配。

### 为什么从 `my-prs2`（0.24 形态）搬而不是从 `local/my-prs`（0.16 形态）搬

0.23.0 → 0.24.1 在 my-prs 触及文件上的全部差异：

| 文件 | 0.23.0→0.24.1 差异 |
|---|---|
| `src/client/builtins/viewers.tsx` / `tests/file-route.spec.ts` / `tests/consumer-types.ts` | **零变化** |
| `src/client/service.ts` | +1/-1 |
| `src/client/EditorHost.tsx` | +2/-7 |
| `tests/builtins.spec.ts` | +2/-4 |
| `docs/external-plugin-guide.md` | +17/-10 |
| `src/index.ts` | +57/-37（0.2.0 适配主战场，但与 open-in-browser 的 hunk 不重叠——已被预演证实） |

而 0.16 → 0.23 在同批文件上是 +442/-104（`service.ts`）、+452/-565（`index.ts`）、每份词典 +141/-63 量级。**新版提交离 0.23.0 远比旧版近。**

### 冲突预演记录（git 2.47.3 `merge-tree --write-tree`，不落盘）

```
git merge-tree --write-tree --merge-base=d7cb134^ f29743f d7cb134
→ 干净（输出仅 tree oid，无冲突条目）

git merge-tree --write-tree --merge-base=6a36422^ f29743f 6a36422
→ 仅 docs/external-plugin-guide.md 与 docs/plans/2026-08-31-open-in-browser-design.md
  出现 3-way 条目（0.24 改过 guide 上下文）；代码、测试、词典全部干净
```

## 3. 执行计划

```bash
# 1. 建本地维护分支（local/ 前缀沿用仓库先例）
git checkout -b local/my-prs-0.23 f29743f

# 2. 顺序 cherry-pick 两个 feature 提交
git cherry-pick d7cb134   # 预期干净
git cherry-pick 6a36422   # 只解 2 个 docs 文件的上下文冲突

# 3. 规划文档提交（本文件）：从 my-prs2 cherry-pick 或重提；
#    不搬 1ca4994/222144e（内容是已废弃的 0.2.0 方向）

# 4. package.json 版本改为 0.23.0-myprs.1；.gitignore 加 output/

# 5. 验证（该基线脚本钉 0.1.7-rc.1，与本机匹配）
pnpm install            # npmmirror 缺包时 --registry https://registry.npmjs.org
pnpm build && pnpm typecheck && pnpm test
TARBALL=$PWD/output/dsh-better-sidebar-0.23.0-myprs.1.tgz pnpm test:mount

# 6. 打包 + 安装
pnpm build && pnpm pack --pack-destination output
dsh plugin --profile web add "file:$PWD/output/dsh-better-sidebar-0.23.0-myprs.1.tgz"
```

## 4. tarball 存放决策（已讨论定案）

安装机制事实（扒 `@deepseek-ai/dsh-plugin-manager@0.1.7-rc.2` 产物确认）：`dsh plugin add file:<tarball>` 委托 **pnpm** 安装，profile 的 `package.json` 留下指向 **tarball 原始绝对路径** 的 `file:` 依赖。日常运行不依赖原文件（内容已入 pnpm store），但重新解析（重装 / lockfile 再生 / 迁移）要回该路径读它。

候选与取舍：

| 位置 | 结论 |
|---|---|
| 仓库根（pnpm pack 缺省） | `*.tgz` 已 gitignore，但构建产物混在源码树，易被 `git clean -fdx` 误清 |
| `~/.dsh/tarballs/` | **否决**：`~/.dsh` 是 DSH 自维护的运行时目录，升级时清理/重构/迁移都说得过去，用户长期制品不该放进去 |
| `~/agentdev/dsh/plugin-tarballs/`（仓库外开发区） | 最稳但割裂：制品生命周期其实跟着这个仓库走 |
| **仓库内 `output/` + gitignore（选定）** | 可控、一眼可见；代价是不保证永远在——靠「版本号不复用 + 重 pack 同名文件原地复活」对冲 |

配套纪律：

- `.gitignore` 显式加 `output/`（现有 `*.tgz` 已兜住 tarball 本身，目录级规则罩住将来其他本地制品）。
- **版本号不复用**：每次迭代 bump `-myprs.N`，让「路径即内容」始终成立；`output/` 被清后重 pack 同名 tarball 即可修复 profile 的 `file:` 引用。
- e2e lane 缺省只找仓库根的 `dsh-better-sidebar-*.tgz`，在 `output/` 下跑挂载冒烟时用 `TARBALL=...` 显式指定。

## 5. 后续维护模型

- **0.1.7 线**：`local/my-prs-0.23`（基线冻结在 `f29743f`，上游不再动这条线，基本零维护；有改动就 bump `-myprs.N` 重 pack 重装）。
- **0.2.0 线**：`my-prs2` 原样保留（`d7cb134` / `6a36422` 在其上），将来升级 DSH 时直接可用。两边 feature 提交内容同源，对应关系由本文档记录。
- 回退路径：profile `package.json` 里的 `file:` 依赖改回 `^0.21.1`（registry）即还原到当前状态。

---

## 6. 执行记录（2026-10-04，实际落地）

分支形状（`f29743f` 之上）：

```
be1f009 chore: 版本镜像点同步 0.23.0-myprs.1（dsh.plugin.json + SIDEBAR_SERVICE_VERSION）
cab89e0 chore: 本地维护线版本 0.23.0-myprs.1 + gitignore output/ 制品区
38602c0 feat(editor): close the sidebar tab after handing the file to the browser
3ae1c3b feat(editor): open-in-browser header button for browser-renderable viewers
54ff76f docs(plans): my-prs rebase 到 0.1.7 线（v0.23.0）的规划
```

与规划的偏差 / 执行中新发现：

1. **第二个 cherry-pick 也零冲突**：预演时 `6a36422` 直接叠 `f29743f` 有 2 个 docs 冲突，但按顺序先落 `d7cb134` 后上下文齐备，实际干净落地。
2. **`f29743f` 基线自带 2 个红测试**（本次顺带修复）：v0.23.0 的 release 提交只 bump 了 `package.json`，`dsh.plugin.json` 与 `SIDEBAR_SERVICE_VERSION` 遗留在 0.22.0——`manifest-consistency` / `service` 两个 spec 在裸基线上即红。已在 `be1f009` 同步到 `0.23.0-myprs.1`，本分支比基线更绿。
3. **沙箱环境的 pnpm store 绕行**：本机 agent 沙箱把全局 pnpm store（`~/.local/share/pnpm/store`）挡为只读。`pnpm install --store-dir .pnpm-store` 可解仓库内安装；但挂载 lane 内部由 dsh spawn 的 pnpm **不吃** `npm_config_store_dir`（npm 会对未认识的 `npm_config_*` 发出警告并丢弃，不透传给子进程）也**不吃** `XDG_DATA_HOME`（pnpm 对已有的 `~/.local/share/pnpm/store` 有向后兼容探测，存在即优先），最终靠提升执行权限写全局 store 跑通。本机缓存目录（`.pnpm-store/` 等）记入 `.git/info/exclude`，不进提交的 `.gitignore`。
4. **冷启动 onboarding 竞态（lane 环境性抖动，非本分支回归）**：冷跑（npx 首次拉 dsh + 首次装 chromium + 首次建 store）时宿主 settings join 超过 60s，onboarding 弹窗（"Configure later"）在 dismissal 轮询放弃后才挂载，随后挡住 `sendFirstMessage` 的发送按钮点击（`mount.e2e.ts:161` 超时）。暖跑（缓存齐备）**7/7 全绿**。该竞态对本分支代码无涉，与 0.24 基线上加固过的 dismissal 窗口差异留给以后需要时再回移植。
5. **验证结果**：`pnpm build` / `typecheck` / `test`（**1468 通过 / 9 skipped / 0 失败**）；`pnpm test:mount`（真实 `@deepseek-ai/dsh@0.1.7-rc.1` 挂载，**7/7**，含 tab sweep / editor chunk / mermaid / README 预览 / sidechat 烟测）。
6. **制品**：`output/dsh-better-sidebar-0.23.0-myprs.1.tgz`（3.8 MB）。安装到真实 profile（用日常在用的 dsh 命令）：
   `dsh plugin --profile web add "file:$PWD/output/dsh-better-sidebar-0.23.0-myprs.1.tgz"`
