# R2 执行计划：进程内缓存上限

> 依赖：**R1 的 commit 已落地**（同一文件 `src/cache.ts`，串行改避免冲突）。预估改动：`src/cache.ts` 约 +45 行、新增 1 个测试文件。

## 步骤

### S1 — 建基线

```powershell
git log --oneline -2         # 确认 HEAD 是 R1 的 commit
npm run build
node test/cache.test.mjs     # 记录 C0–C5 全绿
```

**验收**：`test/cache.test.mjs` 输出 `29 PASS / 0 FAIL`（基线值）。

### S2 — 加常量与 LRU 辅助

在 `src/cache.ts` 的 `CACHE_VERSION` 附近加：

```ts
/** Hard ceiling on resident entries. Count-based: measuring bytes would re-serialize on the hot path. */
const MAX_MEMORY_ENTRIES = 64
```

在 `memory` 声明（`:102`）之后加内部函数：

```ts
function remember(key: string, entry: CacheEntry<unknown>): void {
  memory.delete(key)
  memory.set(key, entry)
  while (memory.size > MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}
```

**注意**：`delete` 后再 `set` 是「移到插入序末尾」的全部实现——**不需要**额外的双向链表。

**验收**：`npm run typecheck` 无输出。

### S3 — 三处 `memory.set` 收敛到 `remember`

- `cacheGetWithMeta` 的内存命中分支：改为 `remember(key, { ...hit, at: hit.at })`（等价于把该 key 移到末尾，不改变 `at`）。
  **不要**在这里更新 `at`：那会把内存 TTL 变成「滑动过期」，5 分钟窗口内反复读会让条目永不过期。
- `cacheGetWithMeta` 的磁盘回填分支（`:205`）：改为 `remember(key, { at, data: parsed.data, ... })`，且**只在 `ageMs < MEMORY_TTL_MS` 时执行**。
- `cacheSet` 的 `:225`：改为 `remember(key, { at: Date.now(), data })`（保持现有语义）。

**验收**：`grep -n "memory.set" src/cache.ts` 只出现在 `remember` 内部（1 处）。

### S4 — 过期即删

内存分支：

```ts
if (hit && Date.now() - hit.at < Math.min(MEMORY_TTL_MS, ttlMs)) {
  remember(key, hit)
  return { data: hit.data as T, source: 'memory', ... }
}
if (hit) memory.delete(key)   // ← 新增：过期即删，避免僵尸驻留
```

**关键**：删掉之后**不要**立刻从磁盘回填——交给下面的 `ageMs < MEMORY_TTL_MS` 判断。

**验收**：`npm run build` 成功。

### S5 — 导出统计

```ts
/** Resident entry count, for tests and diagnostics. Read-only. */
export function cacheMemoryStats(): { entries: number; maxEntries: number } {
  return { entries: memory.size, maxEntries: MAX_MEMORY_ENTRIES }
}
```

**验收**：`node -e "import('./lib/cache.js').then(m => console.log(m.cacheMemoryStats()))"` 打印 `{ entries: 0, maxEntries: 64 }`。

### S6 — 写测试 `test/cache-memory-ceiling.test.mjs`

照 `test/cache.test.mjs:41-44`：**先**设 `DSH_HOME` 到 mkdtemp 目录，**再** `await import`。覆盖 AC2.1–AC2.4。

AC2.4 的「改 `fetchedAt` 为 6 分钟前」用 `readFile` + `JSON.parse` + 改字段 + `writeFile` 直接操作磁盘文件，**不要 fake `Date.now`**（`test/cache.test.mjs:155-158` 明确警告过）。

**验收**：`node test/cache-memory-ceiling.test.mjs` 全 PASS。

### S7 — 内存压力脚本（AC2.5）

`.scratch/heap-ceiling.mjs`，用 `node --expose-gc` 跑：写 100 条各约 1 MB 的数组，两轮 `global.gc()` 后读 `process.memoryUsage().heapUsed` 增量。

**验收**：增量 <20 MB，`cacheMemoryStats().entries === 64`。脚本落在 `.scratch/`，不进 git 不进包。

### S8 — 全量回归

```powershell
npm run check
node test/run-all.test.mjs
```

**验收**：汇总行 `26/28 test files passed, 2 skipped`（基线 24/26；R1 加 1 个测试文件、本任务再加 1 个，分母 +2、分子 +2，skipped 恒为 2）；逐文件求和 ≥ 6377 + 新增；**`test/cache.test.mjs` 的 C0–C5 必须全绿**（这是本任务最可能挂的地方）。

### S9 — 提交

```powershell
git add -A
git commit -m "perf(cache): bound the in-process cache at 64 entries with LRU"
```

**验收**：`git revert --no-commit <sha>` 后 `npm test` 回到上一基线，再 `git reset --hard`。

## 回滚点

| 位置 | 动作 |
|---|---|
| S3 之后 | `git checkout -- src/cache.ts` |
| S9 之后 | `git revert <sha>`（纯内存行为，无需清缓存目录） |

## 复核红灯（出现即停下问）

- `test/cache.test.mjs` 的 C0 挂了 → 最可能是「磁盘命中一律不回填」写错了。C0 的 gate 是「`cacheClearMemory()` 后仍能从磁盘读回」，回填条件写窄不会让它挂，但**删掉回填**会。
- `test/cache.test.mjs` 的 C2/C3 连续读挂了 → `remember` 里的 `memory.delete` 破坏了既有语义，检查是否误删了刚写的条目。
- heap 增量远超 20 MB → `MAX_MEMORY_ENTRIES` 没生效，或 `remember` 的 `while` 循环条件写反。
