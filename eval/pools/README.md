# 候选池

每个 idea 一个文件：`pools/<ID>.yaml`，20 条，**打乱顺序、不含 star、不含任何插件输出**。

池子是标注的输入。它一旦被污染，这个 idea 的金标就不可信，且不可逆。

## 三条硬规则

1. **先建池，后跑插件。** 建池阶段不许打开 `scout_projects`／`rank_candidates`。
2. **`description` 原样复制，不改写、不摘要、不翻译。** 改写会抹掉「描述质量差」这个真实信号，而它正是 `unsure` 的来源之一。
3. **池子只建一次。** 标到一半发现漏了明显的好仓库，不要偷偷加——记进 `notes`，这一轮标完再决定是否 bump 版本重标。

## 池子怎么来的（v2，2026-10-19）

不用手搓：脚本 `.scratch/build-pools.mjs` 直连 GitHub REST 搜索建池，**全程不经过被测插件**。
池子需要对「被测插件」盲，不需要对「人」盲——用人手搜反而会不自觉用上插件教给你的检索技巧。

每个 idea 四条通道，槽位固定，避免被单一查询绑死：

| 通道 | 来源 | 槽位 | 为什么需要它 |
|---|---|---|---|
| `search` | 一句产品级关键词搜索 | ≤7 | 最像真实用户的检索方式 |
| `readme` | 同义改写 + `in:readme` 宽搜 | ≤7 | 覆盖「描述里没写、README 里写了」的仓库 |
| `memory` | `labels.yaml` 里预先登记的种子 | 全部（0–5） | 补常识先验，防止池子比真实世界窄 |
| `interference` | **故意错域**的查询（如书签管理器 → `rss reader self hosted`） | 2 | 检验标注者会不会对什么都说 yes |

`interference` 的错域属性由查询本身保证，不是人工挑的；仓库同时混在 `candidates` 里、位置随机。
哪些是干扰项记在 `interference` 字段——**这一列和 `channels` 都只给实验者看，发给标注者的表格里必须去掉。**

星数、archived、pushed_at 不在池文件里，存在 `.scratch/pool-stars.json` 侧车，等标注完成后由脚本回填 `labels.yaml` 的 `star_band`。

## 文件格式

```yaml
idea_id: A1
generated: "2026-10-19"
provenance: "GitHub REST 直连搜索，未经被测插件"
channels:
  search: [owner/name, ...]
  readme: [owner/name, ...]
  memory: [mediar-ai/screenpipe, ...]
interference: [owner/name, owner/name]   # 同时也在 candidates 里
notes: ""                                # 中途发现的问题记这里，不要改 candidates

# 打乱后的顺序 = 标注顺序。这一列是唯一给标注者看的部分。
candidates:
  - repo: mediar-ai/screenpipe
    description: "24/7 local screen recording you can search"
```

## 标注工具

`eval/labeling.html` 由 `.scratch/build-sheet.mjs` 把 12 个池注入生成，双击用浏览器打开即可，纯本地、不联网。

- 一次显示一个 idea 的全部 20 条，横向对比，标准更容易一致。
- `J/K` 或上下键移动，`1/2/3` 标 `Y/N/U` 并自动跳到下一条。
- 自动存 localStorage（按标注者 A/B 分开存），随时「导出 JSON」。
- 导出的 `labels-A.json` 交给实验者，由 `.scratch/merge-labels.mjs` 合进 `eval/labels.yaml`。

## 关于「不要在同一个 idea 里连续标完」

原始 SOP 建议轮转（每个 idea 先标 5 条，轮完 12 个再回来），理由是标准会在第一个 idea 上锁死然后一路漂移。
v2 改成按 idea 批量标：工具里同 idea 的 20 条是横向并列的，逐条孤立地标反而更难保持一致；跨 idea 的漂移改由「最后一遍复核」兜底——
复核时只看每个 idea 里被判 `yes` 和 `unsure` 的条目，问自己「按现在的标准，这条还成立吗」。

这是一个有意识的取舍，不是遗漏。如果你的标注过程中明显感到后半段变松或变严，记进 `notes`，这片段的结论要打折看。
