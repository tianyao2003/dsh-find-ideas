# Research — 移植前必须处理的两处红灯 + 请求预算发现

采集时间：2026-10-15。对象：前身 `D:\workspace\work_space2\dsh-idea-scout` 的**工作区状态**（含 1857 行未提交改动）。

## 结论速览

`node test/run-all.test.mjs` → **`10/12 test files passed`，exit=1**。两处失败**都是陈旧测试，不是行为缺陷**。二者都在未提交的改动里，因此 HEAD 是绿的、工作区是红的。

聚合运行器 `test/run-all.test.mjs:36` 用 `spawnSync(process.execPath, [file], { stdio: 'inherit' })`，**每个测试文件一个独立进程**——所以这两处失败与文件间状态泄漏无关，是真实的断言失败。

> 教训：早期用 `node --test <file>` 复核时按 `not ok` 过滤，得出「单独跑全部通过」的错误结论。本项目测试自己打印 `FAIL`/`PASS`（`test/bilingual-routing.test.mjs:22-26` 的 `check()`），不用 node:test 的 TAP 词汇。**复核本项目测试必须直接跑文件本身（`node test/<file>`），并按 `FAIL|AssertionError|PASS / N FAIL` 过滤。**

## 红灯 1 — `test/ranking.test.mjs:175`（陈旧期望值）

断言 `rank_candidates` 的参数键集合等于 `['candidates','idea','keywords','limit','scores']`，实测为
`["idea","candidates","scores","keywords","pool_source","limit"]`。

- 该断言自己的注释（`test/ranking.test.mjs:170-174`）记录了 B2/B4 加 `keywords` 时更新过期望值；
- 后来加入的 `pool_source`（`src/index.ts:924` 声明、`src/index.ts:1079` 读 `args.pool_source?.trim() ?? ''`）**没有同步进期望值**。
- 断言的**主体**仍然成立：「排序器不接受任何计算字段，`stars` / `stars_rating` 不得回流」由 `test/ranking.test.mjs:176` 单独守着。`pool_source` 是调用方提供的**来源声明字符串**（Step 1 后候选池可由 agent 自采，必须声明来源），不是计算字段。

**修法**：把 `pool_source` 加进期望数组。不要放宽成子串测试——那会停止捕捉 `stars` 回流。

## 红灯 2 — `test/bilingual-routing.test.mjs:144`（断言范围过宽）

抛 `AssertionError: the tool issues the exact new query order`。实测（探针见同目录 `probe-bilingual-routing-calls.mjs`）：

| # | 实际发出的调用 | 来源 |
|---|---|---|
| 1 | `blockchain explorer` / stars | 计划 anchor |
| 2 | `一个区块链浏览器 支持多链查询和交易追踪` / stars | 计划 precise |
| 3 | `blockchain explorer multi-chain` / updated | 计划 tail |
| 4 | `支持多链查询和交易追踪` / stars | **B6 逐词探针** |
| 5 | `multi-chain` / stars | **B6 逐词探针** |
| 6 | `blockchain` / stars | **B6 逐词探针** |

- **计划的前 3 条与实际前 3 次调用完全一致** → 规划器与工具都没错。
- 多出的 3 次是 B6 新增的**逐词独立命中数探针**：`src/github.ts:774 MAX_TERM_PROBES = 3` + `src/github.ts:789 probeTermTotals()`，由 `src/index.ts:756 termReport(queries, termTotals)` 消费，用途是让「某个检索词其实毫无约束力」在卡片上可见（`src/index.ts:750-755` 记录了实测动机：`browser extension web page translation translate` 返回满页，但其中两个词毫无约束力，卡片上看不出来）。
- 断言用 `assert.deepEqual(calls, plan)` 比对**全部**调用，故失败。同文件 `:151` 的 `check('replay makes no further search requests', calls.length, 3)` 同样会失败，只是前者先抛。

**修法**：把断言限定在计划调用上（`calls.slice(0, expected.length)`），或把期望值更新为 6 次并**新增**一条「探针不参与排序」的断言。

## 附带发现 — 逐词探针使每次搜索的请求数从 3 翻倍到 6

匿名模式 GitHub 配额为 **60 次/小时**。探针无条件执行时，每小时可做的检索次数**减半**（60/6 = 10 次 vs 60/3 = 20 次）。这与 `src/github.ts:765-773` 注释里「探针最多 3 个、不超过计划本身的通道数」的自我约束并不矛盾，但**它没有把匿名配额当成约束**。

**设计阶段决定（非用户决策）**：保留该诊断能力（B6 的价值真实），但在**匿名且配额紧张时跳过探针**，而不是无条件花费一半配额。落地进 `design.md`。

## 其他已核验事实

- `lib/` **不是陈旧构建**：`src` 与 `lib` 的 mtime 同为 `10-14 15:25`，关键 token 计数一一对应（`index`：`pool_source` 5 / `keywords` 37 / `pushed_at` 3，两侧相同）。测试跑的 `lib/*.js` 确实反映当前 `src`。
- `lib/` **未被 git 跟踪**（`git ls-files lib` 为空）→ 从 HEAD 出发跑测试必须先 build。
- 对比 HEAD 基线**不要用 `git archive HEAD | tar -x`**：本机 Windows tar 与 Git-Bash 路径冲突，刷屏 `Damaged tar archive (bad header checksum)` 数千行。改用 `git worktree add` 或 `git stash`。
