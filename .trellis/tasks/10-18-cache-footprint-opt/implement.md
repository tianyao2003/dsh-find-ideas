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
- 逐文件小计求和 ≥ **6377 + 新增**，任何单文件小计不得低于基线（明细见 `prd.md`）。

### I2 — 交叉验证四项改动的叠加效果

单看每项都合格，叠加后可能互相掩盖。必须重跑：

| 验证 | 命令 / 脚本 | 期望 |
|---|---|---|
| 截断 + 内存上限 | `.scratch/heap-ceiling.mjs`（`node --expose-gc`） | heap 增量 <20 MB 且 `entries === 64` |
| 截断 + 磁盘 GC | 真实缓存目录副本上跑 `cacheSweepNow()` | >24h 文件清零；新鲜条目一个不动 |
| GC + 内存上限 | 连续 100 次 `cacheSet` | `cacheSet` 不因清扫变慢（100 次总耗时 <2s） |
| 全部 + 打包 | `npm pack --dry-run --json` | 28 文件 / ≤810 KB / ≤400 KB（实测 28 / 805,009 B / 391,681 B） |

**为什么必须做这一层**：R1 让单条变小，R3 的总量上限（64 MB）在 R1 之后几乎永不触发——这不是 bug，但要确认它**不是因为失效才不触发**（用 `.scratch` 里造 5×20 MB 文件的用例证明上限仍有效，见子任务 AC3.2）。

### I3 — 未改动项逐条核对（父任务 AC7）

```powershell
git diff v0.2.1-baseline..HEAD --stat
```

然后逐条确认这些**没有**出现在 diff 里：

- [ ] `MAX_DESCRIPTION_CHARS` 仍是 200，`clipDescription` 实现未变
- [ ] `SUSPICION_QUOTE_CHARS`（120）、`SCORE_GAP_SIMILARITY`（0.6）、`similarity()` 未变
- [ ] 排序公式 / `rank_candidates` 输出格式未变
- [ ] 三个 TTL 常量（5min / 24h / 10min）未变
- [ ] `dependencies` 仍为 `{}`
- [ ] 缓存目录位置（`$DSH_HOME/cache/dsh-find-ideas`）未变
- [ ] `main` / `types` / `exports` / `dsh.bundle.patch` 未变
- [ ] 工具入参 / 出参 / 卡片渲染格式未变

### I4 — 基线 tag 完好性

```powershell
git rev-parse "v0.2.1-baseline^{commit}"
```

**门禁**：仍是 `1505487808fec5e04029e5846ef6bdea9a8461e6`。tag 是回滚锚点，任何改动都不得移动它。

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
