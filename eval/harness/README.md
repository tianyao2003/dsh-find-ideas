# eval/harness — 测量工具与基线

这一层解决的问题是：**后面每一个"更省 / 更快"的结论，都能被第三个人用仓库里的文件重新算一遍。**

v0.4.0 的报告犯过两次度量错误，两次都不是代码错，而是"数从哪来"没说清：

1. 载荷数字读的是 `dsh --json` 投影，而投影对每个字符串硬截断 8192 字节。22 张卡里 20 张超限，投影从未承载 202,417 字节 → 第一版载荷结论整体偏小。
2. `-28%` 这个数字一度被判定为"查无实据"，因为检索用的是 `28%` 而报告里写的是 `28.4%`。

所以这里的三个脚本各自负责一种"可复算"，任何一个跑不过，就不该引用基线数字。

---

## 四个脚本

| 脚本 | 回答的问题 | 通过标准 |
|---|---|---|
| `golden-inspect.mjs` | 改动之后，卡片内容变了吗？ | `--mode=bytes` 97 项全等；`--mode=info` 577 项全等 |
| `golden-inspect-selftest.mjs` | 上面那个脚本的检查，真的能失败吗？ | 7 个植入回归全部被捕获，恢复构建后 577 项全绿 |
| `ab-metrics.mjs` | 报告里那六个数字，能从冻结的原始行重算出来吗？ | 28 项全等（含配对 t 值） |
| `payload-truth.mjs` | 载荷字节能从持久会话日志重建吗？ | 46 项全等（逐 run、逐 arm、裁剪计数、budget 参数） |

```bash
node eval/harness/golden-inspect.mjs --mode=bytes
node eval/harness/golden-inspect-selftest.mjs
node eval/harness/ab-metrics.mjs
node eval/harness/payload-truth.mjs
```

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
| `metrics-armA-v3.json` / `metrics-armB-v3.json` | 每 run 的 token、墙钟、调用数、错误 |
| `quality-v3.json` | 2 名评分员 × 20 份输出的四维打分 |
| `true-payload-v3.json` | 每次调用的真实载荷字节（来自持久日志） |
| `final-v3-corrected.json` | 已发布报告里的配对统计表 |
| `decode-session.cjs` | 多帧 zstd 会话日志解码器 |
| `manifest.json` | 环境与口径：git sha、模型 id、A 臂 helper 的 sha256、发布数字 |

**只追加，不覆盖。** 新实验另建 `ab-v04.1-*`，旧基线永远保持可复算——否则"提升了 24%"就变成一个谁也无法复核的说法。

## 已冻结的基线数字

| 指标 | A（直接查） | B（插件） | 变化 | p |
|---|---:|---:|---:|---:|
| 计费输入当量 | 27,172.7 | 32,715.1 | +20.4% | 0.127 |
| 墙钟秒 | 54.16 | 75.01 | +38.5% | 0.032 |
| 工具调用 | 8.8 | 6.3 | −28.4% | 0.020 |
| 载荷字节 | 44,945 | 60,291 | +34.1% | 0.054 |
| 质量（16 分制） | 13.50 | 14.10 | +0.6 | 0.279 |
| 错误数 | 0/10 | 0/10 | — | — |

计费口径：`billedInputEq = inputTokens + 0.1 × cacheReadTokens`（缓存命中按十分之一计价）。

## 已知的基线缺陷，必须在下一轮修掉

**A 臂 5/10 个 run 撞了 10 次工具调用上限**（calls = `[10, 8, 6, 9, 9, 10, 10, 6, 10, 10]`）。

这意味着 A 臂在这些 run 里被迫少干活——它不是因为"不需要更多调用"而停在 10，是因为预算到顶。这对两个方向都有影响：

- A 臂的载荷和 token 被**低估**（它想读但没读成）；
- A 臂的墙钟被**低估**（少做的部分不花时间）。

所以 `+20.4%` 的计费差和 `+38.5%` 的墙钟差，都是在一个 A 臂被截断的条件下测出来的。**下一轮（M5）必须把 A 臂上限放宽到 15，并记录每个 run 是否仍触顶。** 在修掉之前，这两个数字只能当方向参考，不能当"插件比直接查贵 20%"的定论。

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
