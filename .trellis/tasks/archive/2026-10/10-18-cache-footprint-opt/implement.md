# 集成执行计划：四个子任务的顺序、门禁与最终验收

> 本文件是父任务的**迭代开发方案总表**。每个子任务的细节在各自的 `implement.md`；这里只管顺序、依赖、门禁与最终集成验收。

## 总览

```
R1 入口截断  →  R2 内存上限  →  R3 磁盘 GC  →  R4 包体精简  →  集成验收
   P0            P0             P1             P1
```

**为什么是这个顺序**（顺序不是随意的）：

1. **R1 必须第一**：R2 的 64 条上限只有配上 R1 的 512 截断才有意义——R1 之前，64 条仍可能是几十 MB。先做 R2 会让 AC2.5 的「heap 增量 <20 MB」几乎必然失败。
2. **R2 在 R3 之前**：两者都改 `src/cache.ts`，串行提交避免并发编辑冲突；R2 改动小、语义清晰，先落地降低 R3 的回归面。
3. **R3 在 R4 之前**：R4 打包的是最终 `lib/`，必须等源码全部稳定。
4. **R4 最后**：它是纯元数据改动，不涉及逻辑，放最后可以让前三步的回归信号最干净。

**每个子任务一个独立 commit**，任何一个都能单独 `git revert`，互不牵连（R2/R3 虽同文件，但改的是不同函数区域，revert 不会互相破坏）。

## 集成步骤

### I1 — 四项改动全部落地后

```powershell
git log --oneline -5          # 应有 4 个 perf/build commit
npm run check                 # typecheck + build + readme:check
node test/run-all.test.mjs
```

**门禁**：
- `npm run check` 零输出/零错误；
- `run-all` 汇总行 `27/29 test files passed, 2 skipped`（基线 24/26；R1–R3 各新增 1 个测试文件，分母 +3、分子 +3，skipped 恒为 2）；
- 逐文件小计求和与实测一致（**实测 6463 PASS / 0 FAIL**），任何单文件小计不得低于基线（明细见 `prd.md`）。

**实测结果（2026-10-18）**：`npm run check` exit 0；汇总行 `27/29 test files passed, 2 skipped`；27 个小计行求和 `SUM PASS=6463 FAIL=0`。证据：`.scratch/suite-final.txt`。

### I2 — 交叉验证四项改动的叠加效果

单看每项都合格，叠加后可能互相掩盖。必须重跑：

| 验证 | 命令 / 脚本 | 期望 | 实测结果 |
|---|---|---|---|
| 截断 + 内存上限 | `.scratch/heap-ceiling.mjs`（`node --expose-gc`） | `entries === 64`；realistic 载荷 heap 增量 <20 MB | `resident 64 / 64`；realistic **1.67 MB / 每条 26.8 KB** → PASS；adversarial **64.81 MB / 每条 1037 KB** → 按设计 FAIL（条数上限不约束字节，见 `prd.md` AC3） |
| 截断 + 磁盘 GC | 真实缓存目录副本上跑 `cacheSweepNow()` | >24h 文件清零；新鲜条目一个不动 | 副本 `41 文件 / 11,215,236 B`，stale24h **30 文件 / 7,850,893 B** → `removed=30`、`bytesFreed=7,850,893` → 清扫后 `11 文件 / 3,364,343 B`、**stale24h=0**；`WRONGLY DELETED 0`、`STALE SURVIVORS 0`；真实目录未被触碰 |
| GC + 内存上限 | `.scratch/gc-timing.mjs`：连续 100 次 `cacheSet` | `cacheSet` 不因清扫变慢（100 次总耗时 <2s） | **1022 ms**（每次 10.22 ms）、落盘 100 条、内存 64 条 → PASS |
| 全部 + 打包 | `npm pack --dry-run --json` | 28 文件 / ≤810 KB / ≤400 KB | **28 文件 / 805,009 B / 391,681 B** → 三项全部通过；`^(src\|test\|scripts)/` 与 `\.map$` 零命中；docs PNG 在包内 |

**为什么必须做这一层**：R1 让单条变小，R3 的总量上限（64 MB）在 R1 之后几乎永不触发——这不是 bug，但要确认它**不是因为失效才不触发**（用 `.scratch` 里造 5×20 MB 文件的用例证明上限仍有效，见子任务 AC3.2）。

**叠加后的真实结论**：四项改动互不掩盖——R1 把稳态从 10.70 MB 压到 0.77 MB，R2 让进程内驻留条数恒为 64，R3 在副本上清掉全部 30 条过期文件且零误删，R4 把安装体积砍到 28 文件 / 805,009 B。唯一「不达标」的是 adversarial 载荷下的 heap 增量，它由 R2 的条数口径决定，属已知边界而非叠加副作用（realistic 载荷下同一代码通过）。

### I3 — 未改动项逐条核对（父任务 AC7）

```powershell
git diff --stat v0.2.1-baseline..HEAD -- src test package.json
```

实测只有 8 个文件被改动：`src/cache.ts`（+241）、`src/github.ts`（+36）、`src/render.ts`（+12）、`package.json`（6 行）、`test/cache-description-cap.test.mjs`、`test/cache-disk-gc.test.mjs`、`test/cache-memory-ceiling.test.mjs`、`test/ranking.test.mjs`。

`src/index.ts`、`src/types.ts`、`src/select.ts`、`src/query.ts`、`src/translate.ts`、`src/lexicon.ts`、`src/skeleton.ts`、`src/credentials.ts` 的 diff **为空**，所以下面这些**必然**未变：

- [x] `MAX_DESCRIPTION_CHARS` 仍是 200（`src/render.ts:53`），`clipDescription` 实现未变——R1 只改了它上方的 docblock 注释
- [x] `SUSPICION_QUOTE_CHARS`（120）、`SCORE_GAP_SIMILARITY`（0.6）、`similarity()` 未变（均在未改动的 `src/types.ts`）
- [x] 排序公式 / `rank_candidates` 输出格式未变（在未改动的 `src/select.ts` 与 `src/index.ts`）
- [x] 三个 TTL 常量（5min `MEMORY_TTL_MS` / 24h `DISK_TTL_MS` / 10min `SOURCE_TTL_MS`）未变；`SOURCE_TTL_MS` 现位于 `src/cache.ts:118`（仅行号因新增代码下移）
- [x] `dependencies` 仍为 `{}`（`node -e` 读取确认；`package.json` 的 diff 只有 `files` 一处）
- [x] 缓存目录位置（`$DSH_HOME/cache/dsh-find-ideas`）未变（`src/cache.ts:213` `cacheDir()`），文件名格式未变
- [x] `main` / `types` / `exports` / `dsh.bundle.patch` 未变（同属 `package.json` 的 diff 外区域）
- [x] 工具入参 / 出参 / 卡片渲染格式未变（工具定义在 `src/index.ts`，渲染在 `src/render.ts` 除 docblock 外未动）

### I4 — 基线 tag 完好性

```powershell
git rev-list -n 1 v0.2.1-baseline
```

**门禁**：仍是 `1505487808fec5e04029e5846ef6bdea9a8461e6`。tag 是回滚锚点，任何改动都不得移动它。

**实测通过**：`git rev-list -n 1 v0.2.1-baseline` → `1505487808fec5e04029e5846ef6bdea9a8461e6`；`git log --oneline --decorate` 显示 tag 仍钉在 `1505487`，其上叠了 5 个 commit（4 个改动 + 1 个文档）。

### I5 — 收尾

```powershell
python ./.trellis/scripts/task.py archive 10-18-cache-description-cap
python ./.trellis/scripts/task.py archive 10-18-cache-memory-ceiling
python ./.trellis/scripts/task.py archive 10-18-cache-disk-gc
python ./.trellis/scripts/task.py archive 10-18-package-slim
```

四个子任务归档后父任务 `[4/4 done]`，再归档父任务。

## 回滚矩阵

| 出问题的位置 | 回滚动作 | 副作用 |
|---|---|---|
| R1 之后 | `git revert <R1-sha>` | `CACHE_VERSION` 回 2，3 版条目全 miss，一次 re-fetch |
| R2 之后 | `git revert <R2-sha>` | 无（纯内存行为） |
| R3 之后 | `git revert <R3-sha>` | 已删的过期文件不回来，代价是一次 re-fetch |
| R4 之后 | `git revert <R4-sha>` | 重新 `npm pack` 即恢复旧 `files` 的全部内容（**94 文件 / 2,137,053 B / tarball 760,174 B**，已实测；v0.2.1 发布时是 91 / 2,073,969，因 R1–R3 新增 3 个测试文件而增长） |
| 全部推翻 | `git reset --hard v0.2.1-baseline^{commit}` | 代码回到 0.2.1；`lib/` 需重新 `npm run build`；运行时清 `$DSH_HOME/cache/dsh-find-ideas` |

**三层回滚**（已在规划阶段向用户说明并确认）：
1. **代码层**：每步一 commit，`git revert` 精准回退；
2. **任务层**：prd/design/implement 都在 git 内，回滚代码不丢设计依据；
3. **运行时层**：`CACHE_VERSION` 是开关，旧代码拒绝新格式；删缓存目录永远安全。

## 时间与风险

| 子任务 | 预估 | 主要风险 |
|---|---|---|
| R1 | 小 | `render.ts` 注释改写是否到位（推翻旧决策必须留痕） |
| R2 | 中 | 磁盘回填条件写窄导致 `test/cache.test.mjs` C0 挂 |
| R3 | 中 | 清扫未节流拖慢 `cacheSet`；Windows `EPERM` |
| R4 | 小 | 阈值余量仅 1–3%，误带文件即超标 |

**共同的坑**：`.trellis/spec/` 有 334 处 `src/*.ts:NNN` 引用且无测试校验。每步改动后跑 `.scratch/verify-tree.mjs`，要求 `PAST EOF: 0` / `nonexistent file: 0` / `NEEDS ADJUDICATION: 0`。
