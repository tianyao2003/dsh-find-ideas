# R3 执行计划：磁盘缓存 GC

> 依赖：**R2 的 commit 已落地**（同一文件 `src/cache.ts` 收尾）。预估改动：`src/cache.ts` 约 +80 行、新增 1 个测试文件。

## 步骤

### S1 — 建基线

```powershell
git log --oneline -2
npm run build
node test/cache.test.mjs
```

**验收**：`29 PASS / 0 FAIL`；记录真实缓存目录当前状态：

```powershell
$dir = "$env:DSH_HOME\cache\dsh-find-ideas"
Get-ChildItem $dir -File | Measure-Object Length -Sum | Select-Object Count, Sum
(Get-ChildItem $dir -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-24) }).Count
```

### S2 — 加常量

```ts
/** Sweep at most once per hour per process. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000
/** Total on-disk budget; ~6x the observed steady state. */
const CACHE_DIR_MAX_BYTES = 64 * 1024 * 1024
/** A temp file older than this was orphaned by a crash. */
const TMP_STALE_MS = 10 * 60 * 1000
let lastSweepAt = 0
```

**验收**：`npm run typecheck` 无输出。

### S3 — 实现 `sweepOnce()`

```ts
async function sweepOnce(): Promise<{ removed: number; bytesFreed: number }> {
  const dir = cacheDir()
  let names: string[]
  try { names = await readdir(dir) } catch { return { removed: 0, bytesFreed: 0 } }

  const now = Date.now()
  const survivors: { name: string; mtime: number; size: number }[] = []
  let removed = 0, bytesFreed = 0

  for (const name of names) {
    const full = join(dir, name)
    let st
    try { st = await stat(full) } catch { continue }
    if (!st.isFile()) continue

    const age = now - st.mtimeMs
    const isTmp = name.includes('.tmp-')
    const isEntry = name.endsWith('.json')
    if (!isTmp && !isEntry) continue

    const stale = isTmp ? age > TMP_STALE_MS : age > DISK_TTL_MS
    if (stale) {
      try { await unlink(full); removed++; bytesFreed += st.size } catch { /* locked: skip */ }
    } else {
      survivors.push({ name, mtime: st.mtimeMs, size: st.size })
    }
  }

  let total = survivors.reduce((n, s) => n + s.size, 0)
  if (total > CACHE_DIR_MAX_BYTES) {
    survivors.sort((a, b) => a.mtime - b.mtime)
    for (const s of survivors) {
      if (total <= CACHE_DIR_MAX_BYTES) break
      try { await unlink(join(dir, s.name)); total -= s.size; removed++; bytesFreed += s.size } catch {}
    }
  }
  return { removed, bytesFreed }
}
```

**注意**：`cacheDir()` 是现有的私有函数——若签名不同，按实际调整；`readdir` / `stat` / `unlink` 需从 `node:fs/promises` 补进 import（当前只 import 了 `mkdir, readFile, rename, writeFile`）。

**验收**：`npm run build` 成功。

### S4 — 加节流与导出

```ts
async function sweepIfDue(): Promise<void> {
  const now = Date.now()
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = now
  try { await sweepOnce() } catch { /* best effort */ }
}

/** Force a sweep now, bypassing the hourly throttle. For tests and diagnostics. */
export async function cacheSweepNow(): Promise<{ removed: number; bytesFreed: number }> {
  return sweepOnce()
}
```

**验收**：`node -e "import('./lib/cache.js').then(m=>console.log(typeof m.cacheSweepNow))"` 打印 `function`。

### S5 — 接到 `cacheSet` 的 `rename` 之后

在 `src/cache.ts:237` 的 `rename` 之后、`catch` 之前：

```ts
void sweepIfDue()
```

**必须是 `void`**，不能 `await`。

**验收**：`grep -n "sweepIfDue" src/cache.ts` 显示 2 处（定义 + 调用），调用处有 `void` 前缀。

### S6 — 写测试 `test/cache-disk-gc.test.mjs`

照 `test/cache.test.mjs:41-44` 的 scratch `DSH_HOME` 惯例。用 `utimes`（`node:fs/promises`）改 `mtime`，不用 fake `Date.now`。覆盖 AC3.1–AC3.4。

**验收**：`node test/cache-disk-gc.test.mjs` 全 PASS。

### S7 — 真实目录验证（AC3.5）

**先在副本上做**：

```powershell
$src = "$env:DSH_HOME\cache\dsh-find-ideas"
$bak = "$env:TEMP\cache-bak-$(Get-Date -f yyyyMMddHHmmss)"
Copy-Item $src $bak -Recurse
```

对副本跑一次 `cacheSweepNow()`，记录 `removed` / `bytesFreed`，并对比文件清单。

**验收**：>24h 文件数从基线降到 **0**；新鲜文件数量与内容逐个不变。

### S8 — 全量回归

```powershell
npm run check
node test/run-all.test.mjs
```

**验收**：汇总行 `27/29 test files passed, 2 skipped`（基线 24/26；R1、R2、R3 各加 1 个测试文件，分母 +3、分子 +3，skipped 恒为 2）；逐文件求和 ≥ 6377 + 新增；`test/cache.test.mjs` C0–C5 全绿。

### S9 — 提交

```powershell
git add -A
git commit -m "perf(cache): sweep expired and oversized disk entries"
```

**验收**：`git revert --no-commit <sha>` 后 `npm test` 回到上一基线。

## 回滚点

| 位置 | 动作 |
|---|---|
| S5 之后 | `git checkout -- src/cache.ts` |
| S9 之后 | `git revert <sha>`（已删的过期文件不回来，代价是一次 re-fetch） |

## 复核红灯（出现即停下问）

- `cacheSet` 变慢（测 100 次 `cacheSet` 的耗时）→ 说明 `void` 漏了或清扫没节流。
- `test/cache.test.mjs` 的 C0 挂了 → 清扫把测试刚写的文件删了。检查 `TMP_STALE_MS` 是否误把新鲜 temp 当孤儿。
- 真实目录里新鲜文件被删 → 总量判定在删过期文件**之前**算了，顺序写反。
- Windows 上大量 `EPERM` → 有进程占用；单文件跳过逻辑没生效。
