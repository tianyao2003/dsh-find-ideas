# R3 技术设计：磁盘缓存 GC

## 问题形状

`src/` 全文没有 `unlink` / `rm` / `prune` / `evict`（已 grep 确认）。`cacheSet`（`src/cache.ts:224-241`）只写不删，`cacheGetWithMeta` 判定过期后只是**不返回**，文件留在盘上。

实测 41 个文件 / 11.22 MB，其中 **26 个已过期 / 6.61 MB（59%）是永不回收的垃圾**。这与「缓存」的直觉相反：它不是缓存，是只增日志。

## 决策一：机会式清扫，不是定时器

三种触发方式的取舍：

| 方式 | 优点 | 致命问题 |
|---|---|---|
| `setInterval` | 简单 | Electron/Node 进程里让事件循环难以退出；插件没有 `dispose` 钩子可用 |
| 进程启动时扫一次 | 无热路径成本 | 长跑进程永远不扫；短命进程每次启动都扫（最坏情况更糟） |
| **`cacheSet` 成功后机会式** | **零额外生命周期依赖，写入本来就要 IO** | 需要节流，否则每次写都扫 |

选第三种，节流 1 小时。

## 决策二：清扫**不 await**，且自己吞异常

`cacheSet` 在 `scout_projects` 的热路径上。一次 `readdir` + N 次 `stat` 在慢盘/网络盘上可能几十毫秒到几百毫秒。所以：

```ts
void sweepIfDue()   // 不 await
```

`sweepIfDue()` 内部整体包 `try { } catch { }`。这是 `src/cache.ts:238-240` 既有契约的延伸——那里 `cacheSet` 的整个写入已经包在 `catch {}` 里，注释说明缓存是 best-effort。清扫若能让 `cacheSet` 失败，就破坏了这条契约。

**为什么不用 `.catch(() => {})` 而用内部 try/catch**：`void promise.catch(...)` 仍会创建一个 microtask 并在下一次 tick 执行；内部 try/catch 让同步部分的失败（如 `Date.now()` 之外的参数校验）也一并被吞，且没有未处理的 rejection 风险。

## 决策三：`lastSweepAt` 先设再扫，失败也不回退

```ts
async function sweepIfDue(): Promise<void> {
  const now = Date.now()
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = now          // ← 先设，不是扫完再设
  try { await sweepOnce() } catch { /* best effort */ }
}
```

- **先设**：并发调用（同一 tick 里多个 `cacheSet`）只有一个真的进入扫描。
- **失败不回退**：若清扫失败就重置 `lastSweepAt = 0`，一个只读目录会让**每次** `cacheSet` 都重试扫一遍——把一次失败放大成持续开销。

## 决策四：为什么用 `mtime` 而不是 `fetchedAt`

清扫要判定「这个文件能不能删」，两个信息源：

- 文件内容里的 `fetchedAt`（真 TTL 依据）→ 需要**读每个文件**并 `JSON.parse`。41 个文件里最大的 1.43 MB，全读一遍是几十 MB IO——为了删垃圾而制造更大 IO，荒谬。
- `mtime`（`stat` 即可）→ 一次 `stat` 几十微秒。

**安全性论证**：`cacheSet` 是「写 temp → `rename`」，`rename` 会更新 `mtime`。所以 `mtime` **不早于** `fetchedAt`。因此「`mtime` 超 24h」⇒「`fetchedAt` 也超 24h」⇒ **一定过期，删之无损**。反过来不成立（`mtime` 新但 `fetchedAt` 旧），但那种情况清扫**不会**误删——保守方向正确。

真正的 TTL 判定仍在 `cacheGetWithMeta` 里，清扫只是回收**确定**是垃圾的文件。

## 决策五：三类删除，按顺序

1. **`*.tmp-*` 且 `mtime` > 10 分钟**：`cacheSet` 用 `${path}.tmp-${process.pid}` 写临时文件再 `rename`。进程在 `writeFile` 与 `rename` 之间崩溃（或被 kill）就留下孤儿。10 分钟远大于任何正常写入耗时，安全。
2. **`.json` 且 `mtime` > 24h**：`DISK_TTL_MS` 的直接后果。
3. **总量 > 64 MB**：按 `mtime` 升序删到不超限。

顺序重要：先删前两类再算总量，否则过期垃圾会让总量判定误触发，删掉本来可以留的新鲜条目。

## 决策六：64 MB 上限的依据

实测稳态 11 MB、垃圾 6.6 MB。64 MB 是「正常使用永远碰不到，但能挡住病态增长」的位置——约 6 倍稳态，约 64 条 × 1 MB 的最坏单条尺寸。

再低（如 32 MB）会在用户跑大量不同 idea 时误删仍有用的条目；再高（如 256 MB）在磁盘紧张的机器上失去意义。

## 拒绝的替代方案

| 方案 | 拒绝理由 |
|---|---|
| 每次 `cacheGet` 判定过期时顺手 `unlink` | 命中路径上做写操作，且只有被读到的过期条目才会被删——真正的问题是**没人读**的条目 |
| 单独的 CLI 命令 `dsh-find-ideas cache prune` | 需要用户手动执行，绝大多数用户不会 |
| 启动时全量扫 | 冷启动延迟；且短命进程（每次工具调用一个进程的场景）会重复扫 |
| 用 LRU 文件数上限而非字节上限 | 单文件大小差 3 个数量级（几百 B 到 1.43 MB），按文件数无法约束体积 |
| 把缓存放进 OS 临时目录让系统清理 | 改变缓存位置是破坏性变更，且系统清理时机不可控 |

## 契约不变项

- `DISK_TTL_MS = 24h` 不变——清扫**使用**它，不重新定义。
- 缓存目录位置、文件名格式、`CACHE_VERSION`（R1 已升 3）。
- `cacheSet` 的签名、返回值、best-effort 语义。
- 不删目录本身，不递归子目录。
