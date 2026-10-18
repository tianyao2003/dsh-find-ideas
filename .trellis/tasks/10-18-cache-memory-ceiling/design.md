# R2 技术设计：进程内缓存上限

## 问题形状

`src/cache.ts:102` 的 `memory` 是模块级 `Map`，三个事实叠起来让它无界：

1. 只有 `set`，没有 `delete`（除 `cacheClearMemory()` 全清）；
2. 命中路径不刷新顺序 → 无法表达「最近用过」；
3. 磁盘分支 `:205` 无论条目多老都 `memory.set` 回填。

实测 11 条大条目全驻留约 13 MB；理论无上限。

## 决策一：为什么是 64 条而不是按字节

按字节算需要 `JSON.stringify` 或 `Buffer.byteLength` 估大小——前者在热路径上把对象再序列化一遍（实测单条 1.43 MB 要几十毫秒），后者对字符串不准。**按条数**是零成本的近似，且真实分布极度偏斜（11 个 >100 KB 文件占 97% 体积）。

64 的依据：单进程一次 `scout_projects` 会话通常只碰几个 idea，64 条覆盖 5 分钟窗口绰绰有余；配合 R1 的 512 截断，64 条 × 约 16 KB ≈ 1 MB 量级。**R1 之后 64 条的内存上限才有意义** —— R1 之前 64 条仍可能到几十 MB。这就是 R2 排在 R1 之后的原因。

## 决策二：LRU 用 Map 插入序，不引依赖

`Map` 迭代按插入顺序，`delete` + 重新 `set` 即「移到末尾」。淘汰时 `memory.keys().next().value` 就是最久未用。

拒绝 `lru-cache`：`dependencies: {}` 是硬约束（父任务 Out of Scope），而这个项目一贯零运行时依赖。

## 决策三：过期不回填（最容易被写错的一处）

朴素实现是「内存过期 → 读磁盘 → 回填」。但磁盘 TTL 是 24h、内存 TTL 是 5 分钟，于是 5 分钟～24 小时龄的条目会：命中磁盘 → 回填内存 → 下次读立刻判过期 → 再读磁盘。**`entries` 永远不降，上限形同虚设。**

所以：只有 `ageMs < MEMORY_TTL_MS` 才回填。更老的条目每次直接读盘（一次 `readFile`，几毫秒），换来 `entries` 真实下降。

**这条改变了行为但不改变正确性**：磁盘 TTL 判定仍在 `cacheGetWithMeta` 里，返回值不变。

## 决策四：为什么导出 `cacheMemoryStats()`

上限若只能靠读代码相信，AC 就只能写「看源码」。导出 `{ entries, maxEntries }` 让 AC2.1/AC2.2/AC2.5 变成可执行断言。代价是新增一个公开 API——但它是纯只读的，且 `cacheClearMemory()` 已有先例。

## 契约不变项

- `cacheGet` / `cacheSet` / `cacheGetWithMeta` 的签名与返回值不变。
- `cacheClearMemory()` 语义不变（`test/cache.test.mjs:84` 依赖）。
- 磁盘格式、文件名、目录位置不变。
- 淘汰**只影响命中率**，绝不返回错值。

## 拒绝的替代方案

| 方案 | 拒绝理由 |
|---|---|
| 定时器 `setInterval` 清理 | 进程生命周期不可控，且 Electron 里定时器会让进程难以退出 |
| `WeakMap` | key 是字符串，不是对象，无法弱引用 |
| 按 `entry.at` 惰性扫全表 | 每次 `cacheSet` 扫 64 条，成本低但需要额外的「上次扫描」节流；LRU 的 `entries` 上限本身就够了 |
| 直接不限，只靠 R3 磁盘 GC | 内存与磁盘是两件事：磁盘 10 MB 不代表 heap 10 MB（UTF-16 膨胀） |
