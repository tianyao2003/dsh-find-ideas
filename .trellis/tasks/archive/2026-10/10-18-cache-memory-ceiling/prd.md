# dsh-find-ideas：给进程内缓存设上限（R2）

> 父任务：`.trellis/tasks/10-18-cache-footprint-opt`（R2）。
> 顺序：依赖 **R1 的 commit**（同一文件 `src/cache.ts`，串行提交避免并发编辑冲突）。

## Goal

`src/cache.ts:102` 的 `const memory = new Map<string, CacheEntry<unknown>>()` 只 `set` 从不淘汰，过期命中也不删，进程生命周期内单调增长（实测 11 条大条目全驻留约 13 MB）。加 **64 条**上限、命中刷新 LRU、过期即删，并导出 `cacheMemoryStats()` 让上限**可被断言**，而不是靠读代码相信。

## 需求

- **R2.1** `const MAX_MEMORY_ENTRIES = 64`。

- **R2.2** `memory` 变成 LRU（用 Map 的插入顺序，不引入任何依赖）：
  - `cacheGetWithMeta` 内存命中时，先 `memory.delete(key)` 再重新 `set`，把该 key 移到插入序末尾；
  - 新增内部 `function remember(key: string, entry: CacheEntry<unknown>): void`，负责「写入 + 超限淘汰」，把现有三处 `memory.set`（`:205`、`:225`）收敛进去；
  - 超限时 `while (memory.size > MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value!)` —— 删插入序第一个（最久未用）。

- **R2.3** 过期即删，且**不立刻从磁盘回填**：
  - 内存分支 `Date.now() - hit.at < Math.min(MEMORY_TTL_MS, ttlMs)` 不成立时，先 `memory.delete(key)` 再走磁盘分支；
  - 磁盘分支只在 `ageMs < MEMORY_TTL_MS` 时 `remember(...)`。否则一个 5 分钟～24 小时龄的条目每次命中都会被塞回内存、又立刻被判过期，`entries` 永远不降——上限形同虚设。
  - 该改动**不影响正确性**：磁盘 TTL（24h）不变，5 分钟～24 小时的条目改为每次从磁盘读，代价是一次读文件。

- **R2.4** 新增 `export function cacheMemoryStats(): { entries: number; maxEntries: number }`。

- **R2.5** `cacheClearMemory()` 行为不变（`test/cache.test.mjs:84` 在用）。

- **R2.6** 淘汰只影响命中率，**绝不能返回错值**：被淘汰的 key 再读时走磁盘，磁盘没有就 miss。

## 验收标准

- [ ] **AC2.1** 写 100 条不同 key 后 `cacheMemoryStats().entries === 64`，`maxEntries === 64`。
- [ ] **AC2.2** 淘汰的是最久未用：写 64 条 → 读 key#0（刷新它）→ 再写 1 条 → 被淘汰的是 key#1，key#0 仍在内存（`entries` 仍 64，且 key#0 的读不触发磁盘 IO——用一个 `readFile` 计数桩或直接比对 `cacheMemoryStats()` 前后的 `entries` 变化证明）。
- [ ] **AC2.3** 淘汰不影响正确性：对被淘汰的 key 再 `cacheGet`，仍能从磁盘读回**同值**（`cacheSet` 先写内存再写盘，磁盘还在）。
- [ ] **AC2.4** 过期即删（不 fake `Date.now`，见 `test/cache.test.mjs:155-158` 的警告）：
  1. `cacheSet` 写一条；
  2. 把磁盘 JSON 的 `fetchedAt` 改写成 6 分钟前；
  3. `cacheClearMemory()`；
  4. 连续两次 `cacheGet` —— 两次都必须返回该值（磁盘 TTL 是 24h）；
  5. 断言 `cacheMemoryStats().entries === 0`（6 分钟龄的条目不再进内存）。
- [ ] **AC2.5** 内存压力（**按真实数据规模，不是任意大对象**）：连续 `cacheSet` 100 条各约 20 KB 的候选列表（30 个候选 × 512 字描述，即 R1 之后一条真实 `scout_projects` 结果的量级），`node --expose-gc` 两轮 GC 后 heap 增量 **<20 MB**，且 `entries === 64`。脚本 `.scratch/heap-ceiling.mjs`（`.gitignore` 已忽略），不进包、不进 git。
  - **这条 AC 原本写成「100 条各约 1 MB 数组，增量 <20 MB」，那个算术不成立**：64 条 × 1 MB = 64 MB，按条数设的上限**无法**约束字节数。实测 adversarial 载荷确实是 65.29 MB。所以 AC 改为在真实载荷上验证上限有效，并**单独记录**「上限只约束条数、不约束字节」这个残留风险（见 design.md 决策一）。
  - 实测（本机）：realistic 载荷 100 条 → `entries 64/64`、heap 增量 **1.67 MB**、单条约 26.7 KB；adversarial 载荷 → `entries 64/64`、heap 增量 **65.29 MB**、单条约 1044.7 KB。两个数都必须报，不能只报前者。
- [ ] **AC2.6** `npm test` 汇总行应为 `26/28 test files passed, 2 skipped`（基线 24/26 + R1 与本任务各新增 1 个测试文件；`skipped` 恒为 2 个）；逐文件小计求和 ≥ **6377 PASS / 0 FAIL**（基线，逐文件明细见父任务 PRD）。`test/cache.test.mjs` 的 C0–C5 全部仍绿（尤其 C0 的「磁盘层可达」gate 与 C4 的 `SOURCE_TTL_MS` 断言）。
  - **不要看终端最后一行 `45 PASS / 0 FAIL`**：`run-all` 用 `stdio: 'inherit'`，最后那行是 `translation-routing.test.mjs` 的小计。
- [ ] **AC2.7** 一个独立 commit（`perf(cache): bound the in-process cache at 64 entries with LRU`）；`git revert <sha>` 后 `npm test` 回到 `24/26 passed`、逐文件求和 **6377 PASS**。

## 不改动

- `MEMORY_TTL_MS`（5 分钟）、`DISK_TTL_MS`（24h）、`SOURCE_TTL_MS`（10 分钟）、`CACHE_VERSION`（R1 已升到 3，本任务不动）。
- 磁盘格式、文件命名、缓存目录位置。
- 不引入任何依赖（含 `lru-cache`）：`dependencies: {}` 是硬约束。

## 风险与坑

- **`test/cache.test.mjs` 的 C0 gate 依赖内存清空后仍能从磁盘读回**（`:84-87`）。R2.3 让「磁盘回填只在 <5 分钟时发生」，而 C0 刚写的条目是新鲜的，不受影响；但若实现写错成「磁盘命中一律不回填」，C2/C3 的连续读断言会挂——这是本任务最可能的回归点，务必先跑 `test/cache.test.mjs` 单文件。
- `memory.keys().next().value` 在 TypeScript 严格模式下是 `string | undefined`，需非空断言或显式判空；`tsconfig.json` 开了 `strict`。
- 行号漂移同上（`.trellis/spec/` 的 334 处引用，跑 `.scratch/verify-tree.mjs`）。

## 回滚

`git revert <sha>`。LRU 是纯内存行为，回滚后无需清缓存目录。
