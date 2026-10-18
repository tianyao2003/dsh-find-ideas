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

> 每条 AC 都在实现后附了实测证据。原始 AC 里的样例数字（「3 个 25 小时前的 .json」等）是设计时的示例，落地测试改用了等价但更严格的构造：每组用独立的 scratch 根目录，断言的是**删除集合恰好等于应删集合**，而不是只数个数。差异已在下文注明。

- [x] **AC3.1** 过期 `.json` 全删、未过期全留 —— **证据**：`test/cache-disk-gc.test.mjs` G2（4 PASS）。48h 前的删、1h 前的留、23h 前的留（仍在 24h TTL 内），`removed === 1`。
  - 与原始示例的差异：原写「3 个 25 小时前 + 2 个新鲜」，实测用「1 个 48h + 1 个 1h + 1 个 23h」，因为 23h 这条能同时证明「没把 TTL 边界写成 ≤」。
- [x] **AC3.2** 总量上限：目录超预算后按 `mtime` 从旧到新删到不超限 —— **证据**：G6（6 PASS）。70 个各约 1 MB 的文件（70 MB），清扫后 `after <= 64 MB`、删掉的是最旧的一段连续前缀、`removed === 70 - 存活数`、且没有把目录清空。
  - 与原始示例的差异：原写「5 个各 20 MB，剩最新 3 个」，实测用 70 × 1 MB —— 20 MB 单文件会让测试写 100 MB 临时数据，70 个 1 MB 文件同样能证明「按 mtime 升序、删到刚好不超限」，且更快。
- [x] **AC3.3** 失败不传染 —— **证据**：G5（2 PASS，目录不存在时静默返回 `{removed:0,bytesFreed:0}`）+ G4（4 PASS，目录里混入 `.txt` 与名为 `subdir.json` 的**目录**，两者都保留、`removed === 1`）+ G7（7 PASS，`cacheSet` 在清扫路径存在时仍 resolve，进程没有因未处理的 rejection 死亡）。
  - 说明：没有真的把目录设成不可写（在 Windows 上会让整个测试文件无法清理），改用「目录不存在」与「非普通文件跳过」覆盖同一条降级路径。
- [x] **AC3.4** 机会式节流 —— **证据**：G1（7 PASS）。第一次 `cacheSet` 触发了清扫（过期文件消失、新写文件保留）；**第二次** `cacheSet` 在 1 小时内不再扫（新造的过期文件仍在）；`cacheSweepNow()` 绕过节流后它才消失。
  - **重要事实**：`lastSweepAt` 是进程级状态、初值 0，所以**只有进程内第一次 `cacheSet` 必然触发清扫**。G1 因此必须是测试文件的第一个小节，后续小节只能观测到「被节流」的那一面。这一点写进了 `database-guidelines.md`。
- [x] **AC3.5** 真实目录验证（**只在副本上执行**）—— **证据**：`.scratch/gc-real-probe.mjs`，对 41 文件 / 11,215,236 B 的副本：
  - `removed=28`，`bytesFreed=6,647,153`；清扫后 13 文件 / 4,568,083 B，**>24h 文件数 = 0**；
  - `VANISHED 28  ADDED 0`、`SURVIVORS CHANGED 0`、`WRONGLY DELETED 0`、`STALE SURVIVORS 0`；
  - 副本操作前后，**真实目录仍是 41 文件 / 11,215,236 B**（未被动过）。
  - 与原始 AC 的差异：原写「从 26 降到 0」，采样时刻不同（基线实测为 **28**）。断言用「降为 0」而非写死数字，理由见「风险与坑」。
- [x] **AC3.6** 全量回归 —— **证据**：`node test/run-all.test.mjs` 汇总行 **`27/29 test files passed, 2 skipped`**；逐文件小计求和 **6459 PASS / 0 FAIL**（6377 基线 + 29 R1 + 19 R2 + 34 R3，算术精确吻合）；`test/cache.test.mjs` C0–C5 全绿（29 PASS）；`npm run check` exit 0（typecheck + build + readme:check）。
- [x] **AC3.7** 独立 commit —— **证据**：见下节「提交」。

## 提交

commit message：`perf(cache): sweep expired and oversized disk entries`。回滚验证：`git revert --no-commit HEAD` → `npm run build` → `node test/run-all.test.mjs` 必须回到 `26/28 passed`、逐文件求和 6425（R2 后基线）。

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
