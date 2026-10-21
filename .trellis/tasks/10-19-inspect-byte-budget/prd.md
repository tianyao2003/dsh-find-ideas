# dsh-find-ideas: 砍掉 inspect_projects 的返回字节（两段式漏斗）

> 授权来源：用户对 2026-10-19 方案的三项明确选择（scope = M0+M1+M2 先做；
> tool4 = 新增 `read_repo_files`；dirty = 先单独成 commit）。`task.py start` 只是状态迁移，不是授权来源。
>
> 父任务：无（本任务自身直接改代码）。基线 tag `v0.3.0-pre-inspect-budget`（9cca969），
> 分支 `feat/inspect-byte-budget`。

## Goal

把 `inspect_projects` 的单次返回从 **49.4 KB** 压到 **≤16 KB**，总返回字节从 **593.0 KB**
压到 **≤181 KB**，**信息等价**（`files_read` 列表不变、有声明文件的签名一条不少、
被折叠的文件给出可补读的路径），并在同批提供一个第二段点读工具让 agent 按需补读。

这不是"加功能"，是修一个已量出来的浪费：`inspect_projects` 占全部工具返回字节的
**71.8%**（593.0K / 825.8K，12 次调用，单次均值 49.4K），而它 82% 的骨架段字节是同一段
免责话在每个文件上重复、README 被完整吐两遍、同一个 1200 字符窗口既解析成签名又原样吐出。

## 背景：A/B 实验的实测基线（全部可复现，脚本在 `.scratch/`）

| 指标 | arm A（不用插件） | arm B（用插件） | 备注 |
|---|---:|---:|---|
| 工具调用次数 | 10.7 | **6.9** | B 胜 10/10，统计显著 |
| 工具返回总字节 | 44,266.6 | 84,566.2 | B 输 9/10，ratio 2.41 |
| `inputTokens` | 46,937.1 | 59,777.5 | B 输 9/10，+12,840 |
| `billedInputEq` | 81,109.3 | 90,872.4 | B 输 7/10，+15.25% |
| `steps` | 9.3 | 7.9 | |
| `llmRetries` | 4.2 | 2.8 | |
| 质量总分（满分 16） | 13.3 | **14.1** | p=0.0368；提升全部来自 dim4 诚实度 |

**字节归因**（12 份真实 dump，593.0K）：

| 段 | 字节 | 占比 |
|---|---:|---:|
| file-excerpt（源码原文 dump） | 281.5K | 47.5% |
| skeleton（骨架段） | 140.2K | 23.7% |
| readme（README 摘录，且吐了两遍） | 114.3K | 19.3% |
| manifest | 19.3K | 3.2% |
| structure | 18.1K | 3.0% |
| repo-header | 8.7K | 1.5% |
| preamble / banner | 10.9K | 1.8% |

**骨架段内部**：真声明行仅 6.6K（4.7%）、代码片段 5.2K（3.7%）、
**免责/道歉样板 115.2K（82.1%）**、文件条目标题 12.8K（9.1%）。

**窗口重复**：骨架条目 201 个、文件摘录 193 个，**路径重合 188 个（94%）**，
重合部分原文 193.4K —— 根因 `src/index.ts:639-644`，同一个 1200 字符窗口
既 `scanSignatures()` 解析成签名，又原样 `excerpts.push()` 吐出。

## Requirements

### R1 去冗余（M1，信息等价，目标 −48% → 308.7K / 单次 25.7K）

- **R1.1** README 只输出一次。`pickArchitectureFiles` 会把根 README 选进 `files`，
  于是 `[README 摘录]` 段和 `[结构信息]` 里的文件摘录各吐一遍。文件摘录里遇到 README
  只留一行路径说明，正文不再重复。
- **R1.2** README 摘录取"第一个有意义的段落"≤400 字。跳过标题行、徽章行
  （`[![`/`![`/`<img`/shields.io）、HTML 注释、纯链接行、license 声明、`---` 分隔线。
  **抽不出段落时必须明说**"前 N 行只有标题与徽章"，不得返回空串（空串读起来像"README 是空的"）。
- **R1.3** 骨架免责话每仓库一次，不是每文件一次。每个文件只留 `· <path>` + 声明行；
  文件级异常（零声明、扩展名不在覆盖内）收拢成卡尾一行汇总。
- **R1.4** 零声明 / 不支持扩展名压成计数行。**红线**：必须保留"这个文件根本没被看过"
  这个事实，`test/declaration-honesty.test.mjs` 会抓"零命中≠没有声明"的措辞。

### R2 漏斗化（M2，目标累计 −69% → 181.1K / 单次 15.1K）

- **R2.1** 非源码摘录只列路径（`.md/.txt/.json/.toml/.yaml/.mod/.sum/无扩展名`）。
  **折中**：非 README 的 `.md` 保留首行标题（保住"这个项目有哪些文档"的信息），正文不展开。
- **R2.2** 扫描器不认识的源码也只列路径（`src/select.ts:138` `SOURCE_EXT_RE` 有 35 个扩展名，
  `src/skeleton.ts:104` `FAMILY_BY_EXT` 只有 11 个，差 24 个：lua/swift/rb/sh/cpp/h/vue…）。
- **R2.3** 新增第 4 个工具 `read_repo_files`（第二段点读）：
  - 参数 `repo`（必填 `owner/name`）、`paths`（必填 1–4 个仓库内相对路径）、
    `focus`（可选，命中行段定位）、`max_bytes`（可选）。
  - 返回每个 path 的窗口（默认 1200 字符，focus 命中时定位到相关行段 ±40 行）+
    `https://github.com/<repo>/blob/<sha>/<path>#L<a>-L<b>` 永久链接 + sha。
  - 复用 `getFile` 与现有缓存；`TreeEntry` 目前无 sha，需在 `src/github.ts` 补齐。
  - schema 成本预算 ≤2.5K bytes（约 0.5K token）。
- **R2.4** `inspect_projects` 加 `budget_bytes` 参数（默认 24000）。超限按顺序裁剪
  manifest → README → 骨架命中行，并在输出里**明说砍了什么、用 `read_repo_files` 补读哪些路径**。

### R3 约束（不可协商）

- **R3.1 零新增运行时依赖**：`package.json` `dependencies` 必须保持 `{}`。
  （`.trellis/spec/backend/index.md` Pre-Development Checklist：若任务看起来需要库，
  答案是 `src/` 里的有界启发式，不是依赖。）**因此 tree-sitter 方案被排除。**
- **R3.2** 新增诊断字符串必须同批写测试（`test/diagnostics-honesty.test.mjs`、
  `test/evidence-chain.test.mjs`、`test/declaration-honesty.test.mjs` 断言"禁止措辞不存在"）。
- **R3.3** 改常量前先查是否已在别处定义（`INSPECT_TIMEOUT_MS`、`TIME_BUDGET_SHARE` 是范例）。
- **R3.4** 质量检查命令固定为 `npx tsc --noEmit`、`npx tsc`（测试跑 `lib/` 不跑 `src/`，
  改完 src 必须先 build）、`node test/run-all.test.mjs`；**绝不直接 `node --test`**。
- **R3.5** 每个 commit 自带测试更新，可独立 `git revert`。
- **R3.6** `inspect_projects` 的参数键集合**没有测试钉住**，可以加参数；
  但 `rank_candidates` 的参数键被 `test/ranking.test.mjs:177` 和
  `test/channel-visibility.test.mjs:382-384` 精确钉住，**本任务不改 rank 的参数**。

### R4 明确不做（本任务范围外）

| 不做 | 理由（实测） |
|---|---|
| tree-sitter | 违反 R3.1；106 个"扩展名不在覆盖内"的文件里 **83 个不是源码**（.md 50/.toml 11/.json 11/.mod 8/.txt 3），真源码只有 23 个 |
| SHA 级永久缓存 | 12 次 inspect 共 46 个 repo 实例、**46 个唯一仓库、重复 0 个**，跨会话收益为零；`SOURCE_TTL_MS` 10 分钟的注释已说明真实重复模式是 turn 内 |
| 把纪律剥成 skill、工具减到 2 个 | schema 三工具合计 16.95K ≈ 11.93% 的 A 臂 inputTokens，是启动预算的 1/8，不是主要矛盾 |
| 架构骨架图 | 工作量大、质量不可控；dim3 空白识别 B 反而比 A 低 0.2，数据不支持 |
| M3/M4（窗口前移、语言扩展、SPDX、检索侧） | 用户明确要求"M1+M2 先做，跑完夹具验收再决定" |

## Acceptance Criteria

> **收尾状态（2026-10-21，tag `v0.4.0` = `1ccc9ad`）**：AC1.2 未达标，AC4 已被 M4 废止。
> 其余全部达成。逐项实测见下；数字全部可用 `npm run eval:gate` 复算。
>
> **AC1 的度量口径**：`eval/fixtures/inspect-golden-baseline.json` 的 12 个 dump × 8 档预算，
> 取**出货默认档 24000** 的 12 张卡求和与求均值（96 张卡的全档合计 2,510,950B 不对应任何一个
> 真实调用，不能用来对账）。

### AC1 夹具验收（硬指标）

- [x] **AC1.1** M1 完成后：总字节 **≤308.7K**，单次均值 **≤25.7K**
      → **实测 260,207B / 21,683.9B**，达标。
- [ ] **AC1.2** M2 完成后：总字节 **≤181.1K**，单次均值 **≤15.1K**
      → **未达标：实测 260,207B / 21,683.9B**（相对 593.0K 基线 −56.1%，不是 −69%）。
      M2 的 commit body 已提前如实记过这一点：排版去冗余只能到 −3.6%，缺口是结构性的，
      留给 M4 的默认预算。而 M4 最终选了 **24000 而不是 16000**——在 16000 档确实是
      172,622B / 14,385.2B（达标），但 24000 是刻意选在均值之上的：均值那张卡是调用方
      点名要的证据，应当整张返回。**这是一次知情的目标让步，不是没做到。**
- [x] **AC1.3** 每个 dump 的降幅方向一致 → 12 个 dump 在 24000 档全部 ≤23,731B，
      而基线单次均值是 49,417B；`golden-inspect --mode=info` 的
      「grows only where the baseline over-trimmed」把它钉成了检查（577 PASS）。

### AC2 信息等价

- [x] **AC2.1** `files_read` 列表逐条不变 → `--mode=info` 的 `same files_read` 检查
      （与夹具记录的 217 条逐条相等），577 PASS / 0 FAIL。
- [x] **AC2.2** 有声明文件的签名行一条不少 → 24000 档 12 个 dump 共 94 条 skeletonHits，
      `structural evidence not reduced` 检查保证不低于基线。
- [x] **AC2.3** 被折叠的文件都能通过 `read_repo_files` 补读 → B4 断言卡里给出
      `read_repo_files(repo="owner/repo", paths=[` 点读路径，且路径都在 `files_read` 里可查。
- [x] **AC2.4** 零声明 / 不支持扩展名的文件仍有明确标注 → `src/render.ts:243/252/263`
      三种情形分别明说「这个文件根本没有被看过，不是「没有声明」」等，`declaration-honesty`
      47 PASS 守着。

### AC3 新工具

- [x] **AC3.1** 永久链接形如 `https://github.com/<owner>/<repo>/blob/<40位sha>/<path>#L<a>-L<b>`
      → `src/render.ts:1814-1817` 构造，单行 `#L<n>`、多行 `#L<a>-L<b>`，`ref` 是提交 sha。
- [x] **AC3.2** 非法 repo / 非法路径 / 超量 paths 一律拒绝并说明规则 → `read-files.test.mjs`
      R2 段（invalid_repo / invalid_paths 各自断言「说了规则」「没花请求」），108 PASS / 0 FAIL。
- [x] **AC3.3** 一次调用的返回字节 ≤8 KB → `READ_BYTES_CEILING = 8192`（`src/index.ts:199`）。
- [x] **AC3.4** schema 成本 ≤2.5K bytes → `test/read-files.test.mjs:165-175` 的 R1 把它做成
      检查（`description + parameters + output.schema ≤ 2500`，另加 `> 1500` 防退化成空壳），通过。

### AC4 预算上限

- [~] **AC4.1 / AC4.2 已被 M4 废止，不再是验收项。** 本任务原本要加的 `budget_bytes`
  参数在 v0.4.0 里被**删掉了**：实测 12 次额外 `inspect_projects` 里只有 3 次是裁剪恢复，
  抬高默认预算净亏 +11,343 billed token/run，而那 3 次恢复本身还要 87,801B。
  M4 把上限改成固定常量（24000），保留 `read_repo_files` 点读与「少传几个仓库」两条恢复路径。
  → 对应的验收改由 `test/inspect-budget.test.mjs`（67 PASS）承担：常量值、参数已不存在、
  旧调用传 `budget_bytes` 被静默忽略、超限分支的文案。

### AC5 回归

- [x] **AC5.1** `npx tsc --noEmit` exit 0
- [x] **AC5.2** `npx tsc` exit 0 → `npm run check` 全绿（含 `readme:check`）。
- [x] **AC5.3** `node test/run-all.test.mjs` 全部通过 → **32/34 files**，2 个 skip 是缺 fixture 的既有状态。
- [x] **AC5.4** 五个诚实性测试全绿 → `declaration-honesty` 47 / `evidence-chain` 35 /
      `diagnostics-honesty` 50 / `instruction-isolation` 140 / `render-table` 130，全部 0 FAIL。
- [x] **AC5.5** README 输出示例同步 → `readme:check` 通过（两份 README 现无 sample marker，
      报告为 `skipped` 而非 `current`，不假装检查过）。

### AC6 版本管理

- [x] **AC6.1** 每个改动独立 commit 且说明「改了什么 + 为什么 + 实测数字」→
      `ac7ae21`(M1) / `d44af68`(M2) / `a248d87`+`59d5438`(M3) / `c499ff3`(M4) / `9a54d78`(M5) / `66d6b8e`(M6)。
- [x] **AC6.2** 任一 commit 可单独 `git revert` → M4 已实测：worktree 里 revert `c499ff3`
      后 `--mode=bytes` 97/0、`--mode=info` 577/0、全套 32/34 files 全绿。
- [x] **AC6.3** 打 tag `v0.4.0` → **已创建（annotated，指向 `1ccc9ad`），但尚未 push。**
      push 会触发 `publish.yml` 直接发到 npm 且不可撤销，因此留待用户确认。

## Notes

- 基线数字全部来自 `.scratch/ab-*.cjs` 脚本，脚本本身不入库（`.gitignore` 已含 `.scratch/`）。
- A/B 实验物料在 `work_space2/` 下（v0.4.1 一轮是 `work_space2/ab-v041/`，其冻结产物已入库到
  `eval/runs/ab-v041-baseline/`；v0.4 一轮的冻结产物在 `eval/runs/ab-v04-baseline/`）。
- 验收口径必须沿用"信息等价"定义：README 两处只留一处 + 正文首段 ≤400 字；
  骨架免责话每卡 1 次；无声明/不支持扩展名压计数行；扫描器认识的扩展名保留 1200 字原文。
  早期脚本 `ab-simulate-phases.cjs` 的 p1() 有 bug（把原文压成路径行），**不得作为验收依据**。
