# dsh-find-ideas：磁盘缓存 GC（R3）

> 父任务：`.trellis/tasks/10-18-cache-footprint-opt`（R3）。
> 顺序：依赖 **R2 的 commit**（同一文件 `src/cache.ts` 收尾）。

## Goal

`src/` 里没有任何 `unlink` / `rm` / `prune` / `evict`——过期条目永久留在盘上。在 `cacheSet` 成功后做**机会式**清扫，每进程每小时最多一次：删 `mtime` 超 24h 的 `.json`、删 `mtime` 超 10 分钟的 `*.tmp-*`、总量超 **64 MB** 时按 `mtime` 从旧到新删。

清扫失败**绝不能**让 `cacheSet` 失败——缓存是 best-effort，这是 `src/cache.ts:238-240` 的既有契约。

## 需求

- **R3.1** 常量：
  ```ts
  const SWEEP_INTERVAL_MS = 60 * 60 * 1000
  const CACHE_DIR_MAX_BYTES = 64 * 1024 * 1024
  const TMP_STALE_MS = 10 * 60 * 1000
  ```

- **R3.2** 模块级 `let lastSweepAt = 0`；`cacheSet` 的 `try` 块**成功之后**（`rename` 之后）调用 `void sweepIfDue()`。

- **R3.3** `sweepIfDue()` 内部**自己**吞掉所有异常（`try { ... } catch {}`），且 `cacheSet` 用 `void` 调用、不 `await`——清扫绝不阻塞、绝不失败主路径。
  - 并发保护：进入时先设 `lastSweepAt = Date.now()`，再干活。这样并发调用只有一个真的扫。
  - 失败也**不重置** `lastSweepAt` 为 0：否则一个只读目录会让每次 `cacheSet` 都重试扫一遍。

- **R3.4** 清扫规则（按此顺序，先删后算总量）：
  1. `*.tmp-*` 且 `mtime` 早于 `TMP_STALE_MS` → 删（崩溃残留）；
  2. `.json` 且 `mtime` 早于 `DISK_TTL_MS`（24h）→ 删（过期垃圾）；
  3. 重扫一遍，若剩余总量 > `CACHE_DIR_MAX_BYTES`，按 `mtime` 升序删到不超限。
  - 用 `readdir(dir, { withFileTypes: true })` + `stat`，**只处理普通文件**，不递归、不碰子目录。
  - 单文件 `unlink` 失败只跳过该文件，不影响其余。

- **R3.5** 新增 `export async function cacheSweepNow(): Promise<{ removed: number; bytesFreed: number }>` 供测试与诊断直接调用（绕过 1 小时间隔）。`sweepIfDue()` 复用它。

- **R3.6** 目录不存在时静默返回 `{ removed: 0, bytesFreed: 0 }`。

## 验收标准

- [ ] **AC3.1** 在 scratch `DSH_HOME` 下造三类文件后调 `cacheSweepNow()`：
  - 3 个 `mtime` 改到 25 小时前的 `.json` → **全删**；
  - 2 个 `mtime` 改到 15 分钟前的 `.tmp-123` → **全删**；
  - 1 个 `mtime` 改到 9 分钟前的 `.tmp-456` → **保留**（未到 10 分钟）；
  - 2 个新鲜 `.json` → **保留**；
  - 断言返回 `removed === 5`，且保留的文件**内容未变**。
- [ ] **AC3.2** 总量上限：造 5 个各 20 MB 的 `.json`（`mtime` 依次递增），调 `cacheSweepNow()` 后目录总量 **≤64 MB**，且被删的是 `mtime` 最旧的（断言剩下的是最新的那 3 个）。
- [ ] **AC3.3** 失败不传染：把缓存目录设成不可写（或用一个 `readdir` 抛错的桩），`cacheSet` 仍 resolve，不抛。
- [ ] **AC3.4** 机会式节流：连续 `cacheSet` 5 次，`cacheSweepNow` 的调用计数（用一个包装桩或直接看 `lastSweepAt` 未导出时的替代证据：5 次 `cacheSet` 后仍只有 1 次清扫副作用）为 1。若不便观测，至少断言「第二次 `cacheSet` 不会再次删掉刚放进来的过期文件」。
- [ ] **AC3.5** 真实目录（**先在副本上验证**，再对真目录执行一次）：对 `C:\Users\longt\.dsh\cache\dsh-find-ideas` 的副本调 `cacheSweepNow()`：
  - `mtime` 超 24h 的 `.json` 数量从 **26**（2026-10-18 采样，会随日期增长）降到 **0**；
  - 未过期文件的数量与内容**逐个不变**；
  - 报告 `removed` / `bytesFreed`。
  - 真目录上执行前先 `Copy-Item -Recurse` 备份，执行后对比文件清单。
- [ ] **AC3.6** `npm test` 汇总行应为 `27/29 test files passed, 2 skipped`（基线 24/26 + R1、R2、R3 各新增 1 个测试文件；`skipped` 恒为 2 个）；逐文件小计求和 ≥ **6377 PASS / 0 FAIL**（逐文件明细见父任务 PRD）；`test/cache.test.mjs` C0–C5 全绿。
  - **不要看终端最后一行 `45 PASS / 0 FAIL`**：`run-all` 用 `stdio: 'inherit'`，最后那行是 `translation-routing.test.mjs` 自己的小计，不是套件总计。
- [ ] **AC3.7** 一个独立 commit（`perf(cache): sweep expired and oversized disk entries`）；`git revert <sha>` 后 `npm test` 回到 `24/26 passed`、逐文件求和 **6377 PASS**。

## 不改动

- `DISK_TTL_MS`（24h）不变——清扫**用**这个值，不重新定义过期语义。
- 缓存目录位置、文件命名、`CACHE_VERSION`（R1 已升到 3）。
- 不删目录本身，不递归子目录。

## 风险与坑

- **AC 不能写死「26」**：过期文件数随日期单调增长，写死会在第二天变成假失败。断言必须是「sweep 后 >24h 的文件数 === 0」。
- **不要 `await` 清扫**：`cacheSet` 在 `scout_projects` 的热路径上，一次 `readdir` + N 次 `stat` 在慢盘上可能几十毫秒。用 `void`。
- **不要用 `mtime` 当唯一真相**：`mtime` 可被复制/解压改写，但对「过期垃圾」这个用途足够——真正的 TTL 判定仍在 `cacheGetWithMeta` 的 `fetchedAt` 里。清扫只删**一定**过期的（`mtime` 超 24h 的必然 `fetchedAt` 也超 24h，因为写入时才 rename）。
- **Windows 上 `unlink` 遇到被占用文件会 EBUSY/EPERM**：单文件失败跳过，不中断整轮。
- 行号漂移同上（`.trellis/spec/` 334 处引用，跑 `.scratch/verify-tree.mjs`）。

## 回滚

`git revert <sha>`。清扫已删的文件不会回来，但删掉的都是过期条目，代价是一次 re-fetch。
