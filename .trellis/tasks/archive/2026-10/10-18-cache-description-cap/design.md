# R1 技术设计：入口截断 description

## 决策一：为什么是 512

候选值与其代价（817 条真实样本）：

| 上限 | 缓存体积 | 受影响候选 | 说明 |
|---|---|---|---|
| 200（= 渲染预算） | 约 200 KB | 74 条 | 与展示完全对齐，但 `SUSPICION_QUOTE_CHARS=120` 与 `similarity` 的输入被压到最短，打分语义变化最大 |
| **512** | **约 514 KB** | **74 条（9%）** | **选它** |
| 1024 | 约 1.0 MB | 仍 74 条 | 体积翻倍，受影响的还是同一批 74 条——没有额外收益 |
| 4096 | 约 3.4 MB | 约 40 条 | 只保护极端样本，长尾仍在 |

关键观察：**74 条 >512 字的候选贡献了 97% 的体积**，而 512 与 1024 影响的**是同一批候选**——1024 多花的 0.5 MB 买不到任何额外正确性。512 是「把长尾砍到接近 0 而语义损失最小」的拐点。

再往下压到 200：会让 `SUSPICION_QUOTE_CHARS = 120`（`src/types.ts:347`）几乎顶到上限，`similarity()` 的 bigram 样本变短，`SCORE_GAP_SIMILARITY = 0.6`（`src/types.ts:548`）的判重行为在中等长度描述上开始漂移。200 是**展示**预算，不该兼任**存储**预算。

## 决策二：只截断，不折叠空白

`clipDescription`（`src/render.ts:58`）会 `replace(/\s+/g, ' ').trim()`。若入口也折叠，`similarity()` 与 `SUSPICION_QUOTE_CHARS` 的输入就变了，**「≤512 字的候选打分逐字不变」这条可验证性质立刻失效**——而这正是本任务唯一能证明「没搞坏打分」的手段。

所以入口**只 `slice`**。折叠仍由渲染层负责，单行化需求不受影响。

## 决策三：存储层不加截断标记

`clipDescription` 会追加 `…（描述过长，原长 N 字符）`。若入口也加标记：

1. 标记本身占预算，512 的额度被吃掉十几个字符；
2. 渲染层看到的是「已经带标记的字符串」，会二次标记或误判长度；
3. 缓存里存的是**数据**，不是**展示文案**。

标记是渲染层职责，存储层只负责让数据变小。

## 决策四：函数放 `github.ts`，不放 `render.ts` 也不放 `types.ts`

依赖图（实测 `lib/*.js`）：

```
github.js  → (零 import)
types.js   → (零 import)
render.js  → types.js, github.js (TAIL_STAR_CEILING), skeleton.js
```

- 放 `render.ts`：`github.ts` 要 `import from './render.ts'`，而 `render.ts:19` 已经 import 了 `github.ts` → **循环依赖**。ESM 能活，但 `TAIL_STAR_CEILING` 的初始化顺序会变成未定义行为。**否决**。
- 放 `types.ts`：`types.ts` 是零 import 的干净叶子，放进去不成环。但 `github.ts:19` 目前是 `import type { RepoCandidate }`（纯类型，编译后消失）；一旦要 import 一个**值**，`github.js` 就从「零 import」变成依赖 `types.js`。功能上无害，但白白新增一条运行时边，且把「存储策略」塞进了「共享词汇表」——`types.ts` 的注释明确说它只放 lossless-JSON 类型。
- 放 `github.ts` 内：`toCandidate` 就在这个文件，函数与它的唯一调用者同处一文件，零新增依赖。**选它**。

## 决策五：`CACHE_VERSION` 必须 2→3

截断改变了 `data.description` 的**长度语义**。若不升版本：

- 旧条目（全量描述）与新条目（512 截断）混在同一缓存里；
- 同一个 idea，昨天命中给 240,000 字符的描述，今天网络新取给 512 字符——下游 `clipDescription` 的「原长 N」会随机在两者间跳；
- 更糟的是这**不会报错**，只是让结果看起来忽长忽短。

`src/cache.ts:12-22` 的 1→2 注释已经把这个道理写透了：宁可让旧条目全部 miss（代价是一次 re-fetch），也不要读出一个「看起来对」的错值。照同样的写法补 2→3。

## 拒绝的替代方案

| 方案 | 拒绝理由 |
|---|---|
| 只在 `cacheSet` 前截断（`src/index.ts:1156`） | 缓存里有两个不同的 payload（`CachedSearch` 与 `CachedInspection`），只截一处会漏；且 `toCandidate` 是唯一填充点，在那里截最不容易漏 |
| 存白名单字段而非整条 item | 更彻底，但会改变 `CachedSearch` 的磁盘形状、波及 `replay` 路径与既有测试，超出本任务范围 → 留作 P2 |
| 在 `cacheGet` 读出时截断 | 磁盘体积一点没降，只降内存峰值——没解决 10.9 MB 的磁盘问题 |
| 用 gzip 压缩缓存文件 | 磁盘变小但每次读都要解压，且内存里仍是全量；`readFile` + `gunzip` 在热路径上不划算 |

## 契约不变项

- `MAX_DESCRIPTION_CHARS = 200`、`clipDescription` 的实现与输出格式。
- `SUSPICION_QUOTE_CHARS`、`SCORE_GAP_SIMILARITY`、`similarity()`。
- `RepoCandidate` 的字段集与类型。
- 工具入参 / 出参 / 卡片渲染格式。
- 三个 TTL 常量。
