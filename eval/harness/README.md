# eval/harness — 测量工具与基线

这一层解决的问题是：**后面每一个"更省 / 更快"的结论，都能被第三个人用仓库里的文件重新算一遍。**

v0.4.0 的报告犯过两次度量错误，两次都不是代码错，而是"数从哪来"没说清：

1. 载荷数字读的是 `dsh --json` 投影，而投影对每个字符串硬截断 8192 字节。22 张卡里 20 张超限，投影从未承载 202,417 字节 → 第一版载荷结论整体偏小。
2. `-28%` 这个数字一度被判定为"查无实据"，因为检索用的是 `28%` 而报告里写的是 `28.4%`。

所以这里的每个脚本各自负责一种"可复算"，任何一个跑不过，就不该引用基线数字。

---

## 六个脚本

| 脚本 | 回答的问题 | 通过标准 |
|---|---|---|
| `golden-inspect.mjs` | 改动之后，卡片内容变了吗？ | `--mode=bytes` 97 项全等；`--mode=info` 577 项全等 |
| `golden-inspect-selftest.mjs` | 上面那个脚本的检查，真的能失败吗？ | 7 个植入回归全部被捕获，恢复构建后 577 项全绿 |
| `ab-metrics.mjs` | 报告里那几个数字，能从冻结的原始行重算出来吗？ | 25 项全等（含配对 t 值；墙钟已撤出，见下） |
| `ab-wall-clock.mjs` | 墙钟撤回有证据吗？修正后的数可复算吗？ | 30 项全等；`--selftest` 的 14 个变异全部被捕获 |
| `payload-truth.mjs` | 载荷字节能从持久会话日志重建吗？ | 46 项全等（逐 run、逐 arm、裁剪计数、budget 参数） |
| `ab-v041.mjs` | M1–M4 之后那一批的结论，能从冻结行重算出来吗？ | 100 项全等（九项配对统计、质量、三个不可达证明、M4 行为证据） |

```bash
node eval/harness/golden-inspect.mjs --mode=bytes
node eval/harness/golden-inspect-selftest.mjs
node eval/harness/ab-metrics.mjs
node eval/harness/ab-wall-clock.mjs
node eval/harness/payload-truth.mjs
node eval/harness/ab-v041.mjs
```

## 统计函数不许重写，只许复制 + 自校验

`ab-v041.mjs` 和 `m5-main-table.mjs` 里的 `betacf` / `gammaln` / `betai` / `tTwoSidedP` 是从 `paired-stats.mjs` **逐字复制**的，不是各自重写的。

原因是真踩过：第一版 `m5-main-table.mjs` 自己内联写了一份 incomplete beta，结果在 df=9 上算出 `t=1.383 → p=0.021`——这个组合在数学上不可能（df=9、t=1.383 的双尾 p 应在 0.20 附近）。p 值错了不会报错，它只会安静地让一个不显著的结论看起来显著。

所以现在每个用到 t 分布的文件都在**产出任何数字之前**先跑一遍已知值自校验：

```js
const known = [[2.262, 9, 0.05], [1.833, 9, 0.1], [3.25, 9, 0.01], [0.5, 9, 0.6286]]
// 容差 0.002，任一不过就 exit(2)
```

这条对报告数字是硬约束：一个 p 值算错的分析，比没有分析更危险，因为它带着"已验证"的外观。

## 为什么需要一个自检脚本

第一版 `golden-inspect.mjs` 有三项检查**永远不会失败**，而它们全都报 PASS：

- `repos` 数的是 `📝`，真实段头是 `📦` → 恒 0 对 0；
- `skeletonHits` 的正则匹配 `function foo(...)` 这种行，真实声明行是 `     method \`x\` — #L12` → 恒 0 对 0；
- `no growth` 写成了体积不变量，但**渲染器变好**会让未裁剪卡更小、裁剪阶梯少降一档、最终卡反而更大 → 它只在基线被过度裁剪的 25 张上失败，在其余 71 张上通过，方向是反的。

一个不能变红的检查比没有检查更糟：它给的是"已验证"的错觉。所以现在有两道防线：

1. `assertPatternsStillMatch()` 在**任何输出之前**（包括 `--write`）先渲染 12 个夹具，任一 signature 正则的总计数为 0 就 exit 2。顺序很重要——先写基线再守卫，等于把空转冻进基线。
2. `golden-inspect-selftest.mjs` 向 `lib/render.js` 植入 7 个真实回归（删行、改标记、截断列表、重复段头、吞掉裁剪提示、无视预算、删掉某仓库骨架），要求每个都被抓到，然后恢复构建。守卫会抢占检查，所以每条检查都配了一个"正则仍匹配、只改数据"的变异，否则无法证明该检查本身能失败。

## `--mode=info` 的六项检查

| 检查 | 判据 | 为什么是这个判据 |
|---|---|---|
| `same files_read` | 与**夹具记录的** `files_read` 逐条相等 | 证据链。卡片变小可以，少一条"读过哪个文件"不行 |
| `every inspected repo still has a section` | 段头数 = `inspections.length` | 丢一个仓库等于丢一整块证据 |
| `structural evidence not reduced` | `treeEntries + skeletonHits` ≥ 基线 | 目录树与声明行是"结构信息"的全部 |
| `every dropped block is announced` | 卡比自己的未裁剪渲染小 ⇒ 必须有裁剪提示 | 判据是**同一输入的未裁剪渲染**，与渲染器版本无关 |
| `within budget, or says it cannot fit` | 字节 ≤ 预算，或卡尾明说装不下 | 唯一允许的例外必须自己说出来 |
| `grows only where the baseline over-trimmed` | 变大 ⇒ 基线那张 `cutNotices > 0` | 未裁剪卡变大是真回归；裁剪卡变大是信息变多 |

前四项的参照物都不是旧基线，而是夹具数据或本次渲染，所以重录基线也不会让它们失去意义。

`payload-truth.mjs` 需要本机的 `~/.dsh/sessions/` 还在。换机器或工作区搬过家时用 `--sessions=<dir>` 指过去；找不到日志会直接 exit 2 并说明缺什么，不会静默算出一个空结果。

---

## `golden-inspect.mjs` 的两种模式，以及为什么必须是两种

改动分两类，验收标准不同：

- **`--mode=bytes`**：卡片必须逐字节不变。适用于 M1（schema 文案）和 M3（并行读）——这两个任务的目的不是改输出，是改成本和时序。输出变了就是副作用。
- **`--mode=info`**：卡片可以变小，但不能丢失它没有声明丢弃的信息。适用于 M2 和 M4（预算与体积）——变小正是目的。判据是：`files_read` 逐条不变、仓库数不变、结构信息不减、任何被裁掉的块都要在裁剪提示里出现、不超预算、且只在基线本就被裁剪过的地方才允许变大。

对 M2 用 `--mode=bytes` 会全红，学不到东西；对 M1 用 `--mode=info` 会在 schema 悄悄变化时照样通过。每个任务在任务书里写明自己必须满足哪一种。

## 夹具为什么是真实的 48 条

`eval/fixtures/inspect-golden-raw.json` 是 v0.4.0 A/B 实测中 12 次 `inspect_projects` 调用返回的 `inspections` 数组原样（48 个不同仓库，原始块内容 531,831 字节）。

它是签入的，不是现场生成的。现场生成会得到一个**不是同一个夹具**的夹具：那些仓库已经往前走了，而一个输入随 GitHub 漂移的回归测试，测的是 GitHub 不是这段代码。

`inspect-golden-baseline.json` 是 `--write` 产出的快照，包含每个夹具 × 8 个预算档的 sha256 与结构签名。它**是 M1/M2 之前模型所见字节的唯一记录**，所以 `--write` 现在默认拒绝执行：

```bash
node eval/harness/golden-inspect.mjs --write           # exit 2：refusing to overwrite the baseline without --force
node eval/harness/golden-inspect.mjs --write --force   # 旧文件先备份成 inspect-golden-baseline.prev.json
```

理由：静默重录会让 `--mode=bytes` 变成"渲染器和自己比"，永不可能失败——这恰好是第一版基线里 `repos`/`skeletonHits` 两个字段变成常量的同一种事故。确实要改输出时才 `--force`，并且同一次提交里说明这是有意的。

## 预算档位

8000 / 12000 / 16000 / 24000 / 28000 / 40000 / 60000 / 64000。

不只测默认值：M2 和 M4 改的正是裁剪路径，只在默认档测等于没测裁剪。这八档覆盖了文档区间（8000–64000）的两端、实测中用过的 28000/40000/60000/64000，以及 M2 打算改成的 12000。

---

## 冻结的基线：`eval/runs/ab-v04-baseline/`

| 文件 | 内容 |
|---|---|
| `metrics-armA-v3.json` / `metrics-armB-v3.json` | 每 run 的 token、调用数、错误（**墙钟列已撤回，见下**） |
| `quality-v3.json` | 2 名评分员 × 20 份输出的四维打分 |
| `true-payload-v3.json` | 每次调用的真实载荷字节（来自持久日志） |
| `final-v3-corrected.json` | 已发布报告里的配对统计表（**保持原样，作为审计痕迹**） |
| `decode-session.cjs` | 多帧 zstd 会话日志解码器 |
| `manifest.json` | 环境与口径：git sha、模型 id、A 臂 helper 的 sha256、发布数字、`corrections[]` 撤回记录 |
| `wall-clock-correction.json` | 墙钟撤回的完整证据：20 run 的假值/真值/span/overhead、根因、修正后的配对统计 |

**只追加，不覆盖。** 新实验另建 `ab-v04.1-*`，旧基线永远保持可复算——否则"提升了 24%"就变成一个谁也无法复核的说法。

## 冻结的基线：`eval/runs/ab-v041-baseline/`

M1–M4 全部生效后的那一批（v0.4.1，40 次运行，冷缓存、严格顺序）。21 个文件，全部是从 `work_space2/ab-v041/` 原样复制，未做任何改写：

| 文件 | 内容 |
|---|---|
| `metrics-armA.json` / `metrics-armB.json` | 每 run 的 token、调用数、步数、墙钟、`cacheBeforeRun`、`sessionId` |
| `payload-truth.json` | 每 run 的真实载荷字节（持久日志逐帧 zstd 解码），**绑 sessionId** |
| `quality-v041.json` + 两份 `quality-v041-rater*.json` | 2 名独立评分员 × 20 份盲评输出的四维打分 |
| `call-seq.json` | 每 run 的完整调用序列（含是否命中裁剪卡），M4 行为证据 |
| `m5-main-table.json` / `paired-stats.json` / `quality-stats.json` | 三份独立算出的统计表（互为交叉校验） |
| `schema-tax.json` / `prefix-tax.json` / `context-mechanism.json` | 三个独立分解：schema 字节税、token 税、上下文累积机制 |
| `feasibility.json` / `floor-profile.json` / `payload-elasticity.json` / `floor-analysis.json` | 不可达证明的四个组成部分 |
| `wall-decompose.json` | 墙钟的 model / tool / host 三段分解 |
| `batch-compare.json` | 与冻结 v0.4 的四行相对量对照 |
| `manifest.json` | 环境与口径、发布数字、`targets.status:'unreachable'`、四条 `comparability` 差异 |

**这批的数字只做两件事**：① 批内 A vs B 配对推断；② 跨批次只比**相对量**。与 v0.4 不可直接比，原因写在 `manifest.json` 的 `comparability.differencesFromAbV04`：工具调用上限 10→15、并发 2→1、formatVersion 3→4、插件改动 M1–M4。

## 已冻结的基线数字

| 指标 | A（直接查） | B（插件） | 变化 | p |
|---|---:|---:|---:|---:|
| 计费输入当量 | 27,172.7 | 32,715.1 | +20.4% | 0.127 |
| 工具调用 | 8.8 | 6.3 | −28.4% | 0.020 |
| 载荷字节 | 44,945 | 60,291 | +34.1% | 0.054 |
| 质量（16 分制） | 13.50 | 14.10 | +0.6 | 0.279 |
| 错误数 | 0/10 | 0/10 | — | — |
| ~~墙钟秒~~ **已撤回** | ~~54.16~~ 66.49 | ~~75.01~~ 69.49 | ~~+38.5%~~ +4.5% | ~~0.032~~ 0.684 |

计费口径：`billedInputEq = inputTokens + 0.1 × cacheReadTokens`（缓存命中按十分之一计价）。

### 墙钟一栏为什么被撤回

冻结的 `metrics-arm{A,B}-v3.json` 里那一列墙钟**不是这 20 个 run 测出来的**。

`work_space2/ab-v04/aggregate.mjs` 从 `events/*.jsonl` 重算所有数值型指标，但墙钟不在事件流里，于是它用正则从 runner 日志抓 `wall=[\d.]+s`，按 mtime 排序后"后来的日志赢"。而 v3 那批的两个日志 `runA-v3.log` / `runB-v3.log` **一条 `[done]` 行都没有**（0 行匹配），所以 v2 那批的墙钟被逐字贴到了 v3 的行上。

证据（都在 `wall-clock-correction.json`，由 `ab-wall-clock.mjs` 校验）：

- **假列与 v2 逐值相同 19/20**（arm A 10/10、arm B 9/10；唯一不同的 I04 恰是 v2 里 `exit=1` 重跑的那一轮），而**两批 sessionId 共享 0/20** —— 十个不同的 run 重新测量，绝不可能精确到 0.1s 全部相同。
- **真值来自 runner 自己写的未命名 `metrics-arm{A,B}.json`**（比 v3 早 12 秒，被 aggregate 覆写前存活），它与冻结 v3 的 **sessionId 共享 20/20**、token 总量 20/20 精确相等。
- **overhead 判据**：真列 `wall − session span` 20/20 落在 **1.79–2.36s**（均值 2.02，负值 0），正是进程启停开销；假列 `−31.2 ~ +43.16`（均值 −1.38，**负值 12/20**）—— 一个物理上不可能的分布。
- 同批配对 t 检验：**66.49 → 69.49，d=+3.00s（+4.5%），t=0.419，p=0.684，不显著**。

**影响**：此前"墙钟 +20.9 秒（+38.5%，p=0.032，显著）"的说法作废。50s 墙钟目标要按 69.49s 重算，不是 75.01s。

**教训**：跨批次聚合的指标必须绑 `sessionId`，不能绑 `I01-armB` 这种可复用的标签——否则不同批的 run 会被合并成一行，token 来自 A 批、墙钟来自 B 批。而"检查自洽通过"不等于"数字正确"：`ab-metrics.mjs` 曾用这列假数据跑了 28 项全等、全绿。

## v0.4 的已知缺陷，以及 v0.4.1 怎么修的

**A 臂 5/10 个 run 撞了 10 次工具调用上限**（calls = `[10, 8, 6, 9, 9, 10, 10, 6, 10, 10]`）。

这意味着 A 臂在这些 run 里被迫少干活——它不是因为"不需要更多调用"而停在 10，是因为预算到顶。这对两个方向都有影响：

- A 臂的载荷和 token 被**低估**（它想读但没读成）；
- A 臂的墙钟被**低估**（少做的部分不花时间）。

所以 `+20.4%` 的计费差是在一个 A 臂被截断的条件下测出来的。

**v0.4.1 已修**：上限放宽到 15，并逐 run 记录是否触顶。结果 A 臂 calls 从 8.8 涨到 13.4，**8/10 轮 ≥14 次、4 轮恰好 15**——上限从"偶尔卡住"变成了"真实约束"。修正后的批内差值是 **+0.4%（p=0.979）**，不是 +20.4%。这也说明 v0.4 的 `+20.4%` 里有相当一部分是额度效应：A 臂想读但没读成。

（墙钟一行不在这里讨论——它已整体撤回，见上一节。撤回后的真值 66.49 → 69.49 同样是在 A 臂被截断的条件下测的，所以同样只能当方向参考。）

### v0.4.1 的数字（批内可比，跨批次只比相对量）

| 指标 | A（直接查） | B（插件） | 变化 | p |
|---|---:|---:|---:|---:|
| 计费输入当量 | 36,938.6 | 37,095.1 | +0.4% | 0.979 |
| 工具调用 | 13.4 | 7.4 | **−44.8%** | **0.0003** |
| 步数 | 9.0 | 7.4 | −17.8% | 0.200 |
| 输出 token | 7,267.8 | 10,847.8 | **+49.3%** | **0.007** |
| 墙钟秒 | 73.66 | 69.17 | −6.1% | 0.608 |
| 载荷字节 | 63,715.9 | 56,836.0 | −10.8% | 0.451 |
| 质量（16 分制） | 14.10 | 13.70 | −0.4 | 0.259 |
| 错误数 | 0/10 | 0/10 | — | — |

只有两行显著：调用次数降 44.8%、输出 token 涨 49.3%。**账单与不用插件持平，没有变便宜。**

`manifest.json` 的 `targets` 记录了本轮的两个目标（25,000 billed / 50s 墙钟）及其状态 `unreachable`——不是"还差一点"，是算术上够不着：绝对下界 29,123.5、结构地板 28,803、把工具延迟归零后墙钟仍需 50,293ms。`ab-v041.mjs` 的第 5 节把这四条证明都钉成了检查。

---

## 冷热缓存：必须分开测

插件的磁盘缓存（`$DSH_HOME/cache/dsh-find-ideas`）搜索结果存 24 小时、源码读取存 10 分钟。热缓存下同一个 idea 的墙钟可以差 10 秒以上，而这个差值会被误读成"插件变快了"。

规则：

- **"更快"一律报冷启动**：跑之前清空缓存目录。
- 热缓存作为附加说明，单独一列，不混进主指标。
- 每轮 run 记录缓存状态（冷/热），否则两次实验不可比。

清缓存（会删掉可复用的检索结果，只影响下一次调用的速度，不影响正确性）：

```powershell
Remove-Item "$env:USERPROFILE\.dsh\cache\dsh-find-ideas\*" -Recurse -Force -ErrorAction SilentlyContinue
```

---

## 回滚的三层

| 层 | 手段 | 验证 |
|---|---|---|
| git | 每个任务从 `post-m{N-1}` 切分支，单 commit；`git revert <sha>` | 回滚后 `golden-inspect --mode=bytes` 必须全绿 |
| 运行 | 并发度、默认预算、仓库数都是**常量**，不是散落的字面量；并发度 = 1 等价于旧行为 | 改一行即可复原 |
| 数据 | `eval/runs/` 只追加；基线快照一旦写入永不修改 | 旧报告永远可复算 |

回滚的触发条件写在任务书里，不事后找理由：

| 触发 | 动作 |
|---|---|
| `golden-inspect` 任一仓库输出变化（bytes 模式） | 该 commit 立即 revert |
| 质量配对差 CI 下界 < −1.0 | 回退该任务 |
| 出现任何 429/403 导致的重试 | 并发度降半或回退 M3 |
| 单任务墙钟 p95 > 120s | 回退 M3 |
| 任一 run 出现错误或交付物缺失 | 全量回退到 `pre-m{N}` |
