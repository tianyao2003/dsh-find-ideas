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

### AC1 夹具验收（硬指标）

用 `.scratch/ab-fixture-inspections.cjs` 把 12 份真实 dump 反解析成 `Inspection[]`，
用改后的 `renderInspections` 重渲染，对比字节：

- [ ] **AC1.1** M1 完成后：总字节 **≤308.7K**，单次均值 **≤25.7K**
- [ ] **AC1.2** M2 完成后：总字节 **≤181.1K**，单次均值 **≤15.1K**
- [ ] **AC1.3** 每个 dump 的降幅方向一致，不允许"总量降了但某次涨了"

### AC2 信息等价

- [ ] **AC2.1** `files_read` 列表逐条不变（路径、顺序、数量）
- [ ] **AC2.2** 有声明文件（44 个）的签名行一条不少；行号、`kind`、`name` 不变
- [ ] **AC2.3** 被折叠的每个文件都能通过 `read_repo_files` 补读（路径在 `files_read` 里可查）
- [ ] **AC2.4** 零声明 / 不支持扩展名的文件仍有明确标注，不得渲染成"没有声明"

### AC3 新工具

- [ ] **AC3.1** `read_repo_files` 返回的永久链接形如
      `https://github.com/<owner>/<repo>/blob/<40位sha>/<path>#L<a>-L<b>`
- [ ] **AC3.2** 非法 repo / 非法路径 / 超量 paths 一律**拒绝并说明规则**，不静默丢弃
- [ ] **AC3.3** 一次调用的返回字节 ≤8 KB
- [ ] **AC3.4** schema 成本 ≤2.5K bytes

### AC4 预算上限

- [ ] **AC4.1** `budget_bytes` 生效：超过上限时裁剪，且输出里明说裁剪了什么
- [ ] **AC4.2** 未超限时不改变输出（默认路径逐字节等于无该参数时）

### AC5 回归

- [ ] **AC5.1** `npx tsc --noEmit` exit 0
- [ ] **AC5.2** `npx tsc` exit 0
- [ ] **AC5.3** `node test/run-all.test.mjs` 全部通过（2 个 skip 是缺 fixture 的既有状态）
- [ ] **AC5.4** 现有诚实性测试全绿：`declaration-honesty`、`evidence-chain`、
      `diagnostics-honesty`、`instruction-isolation`、`render-table`
- [ ] **AC5.5** README 里的输出示例同步（`npm run readme:sample && npm run readme:check`）

### AC6 版本管理

- [ ] **AC6.1** 每个改动独立 commit，commit message 说明"改了什么 + 为什么 + 实测数字"
- [ ] **AC6.2** 任一 commit 可单独 `git revert`
- [ ] **AC6.3** 全部通过后打 tag `v0.4.0`

## Notes

- 基线数字全部来自 `.scratch/ab-*.cjs` 脚本，脚本本身不入库（`.gitignore` 已含 `.scratch/`）。
- A/B 实验物料在 `D:\app\dsh\dsh_workspace\work_space2\eval-plugin\`（`metrics.json`、
  `final-summary.json`、`REPORT.md`、`rubric.md`）。
- 验收口径必须沿用"信息等价"定义：README 两处只留一处 + 正文首段 ≤400 字；
  骨架免责话每卡 1 次；无声明/不支持扩展名压计数行；扫描器认识的扩展名保留 1200 字原文。
  早期脚本 `ab-simulate-phases.cjs` 的 p1() 有 bug（把原文压成路径行），**不得作为验收依据**。
