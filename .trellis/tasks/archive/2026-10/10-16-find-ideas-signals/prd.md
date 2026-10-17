# dsh-find-ideas：上浮管线已经算出、却从未报告的检索信号

## Goal

把三处**管线内部已经知道、但从未说出口**的事实补进用户可见的输出：

1. **R1 — 检索面的描述与实际不符，且错在两个相反的方向。** 实测（GitHub 官方文档 + 六个 token 的集合包含实验）确认：默认检索面是**名称、描述与 topics**，**不含 README 正文**；`in:readme` 能触达 README，但既不保证穷尽、也不比裸查询更准。据此源码里有两类错误陈述：**漏报**——`RETRIEVAL_SURFACE`（`src/index.ts:68-73`）说检索面「只有名称与描述」，漏了 topics，且断言 README 里的项目「任何查询都触达不了，无论多精确」，被 `in:readme` 直接证伪；**错报**——**四处**文案把 README 写进了**默认**检索面（`src/query.ts:242`、`:1346`、`:1382`、`src/render.ts:330`）。另需注意：`src/query.ts:1054` 的字段列表「名称、描述与 topics」**是正确的**（与官方文档一致），PRD 初稿把它列为错误项是误判。
2. **R2 — 归档仓库的规模不可见。** `archived` 被采集、被逐行标记（`[已归档]`），但读者看不到「这一池里有几个是归档的」。标记本身还容易被误读为「废弃」。
3. **R3 — 通道命中数被算出来又扔掉。** `selectPool` 的融合阶段记录了每个仓库被哪几条查询召回（`sources: Set<number>`），但它在 `.map(e => e.row)` 处被丢弃，渲染层零命中。

三条都不是新能力，是**已有信号的可见性缺口**。R1 是唯一的「错误陈述」——它优先于另外两条。

**来源**：第三方 agent 对 `Fectivnfy112357/github-explore` 的可借鉴机制清单（14 条建议）。本任务只取其中经我方代码取证后**判定成立且成本可控**的三条；报告本身的判定错误见「技术注记」。

## Background — 已确认事实

### R1：`in:readme` 的实测结论（本任务的决定性证据）

用 `deepseek-ai/deepseek-harness` 做对照（`description` = "DeepSeek Harness: Everything is a Plugin."，`topics` = `["ai-agents","cordis","dsh","dsh-plugin"]`，README 2669 字节）。取三个**只出现在 README 正文**、不在名称/描述/topics 里的词：

| 查询 | `total_count` | 结果含该仓库？ |
|---|---|---|
| `open-source` | 449,114 | **否** |
| `open-source in:readme` | 13,352,426 | **是** |
| `developed` | 959,102 | **否** |
| `developed in:readme` | 10,611,468 | **是** |
| `architecture` | 625,575 | **否** |
| `architecture in:readme` | 9,718,750 | **是** |

**结论：`in:readme` 确实能触达 README 正文。** 三个 README-only 词在无限定符时全部落空，加限定符后全部命中。

**但同一次取证也证明它不可靠，这条必须一起写进去**：第四个 README-only 词 `cordiverse` 在 README 里确实存在（`in README = true`），而 `cordiverse in:readme` **仍然没命中该仓库**（`total=102`，`contains=false`）。→ **`in:readme` 扩大覆盖，但不保证穷尽。** 修文案时不得把「检索不到」换成「检索得到」——那只是换一个方向的过度断言。

**并且它的结果被噪声主导**：三个命中的 `total_count` 分别是 13.35M / 10.61M / 9.72M，远大于无限定符时的 449k / 959k / 625k。→ `in:readme` 是**更宽**的网，不是更准的网。

限定符对检索面的切分（`dsh-plugin` 实测）：裸词 23,513 · `in:readme` 39,000 · `in:name,description` 8,239 · `in:topics` 19,659。

### R1：默认检索面的决定性证据（官方文档 + 集合包含实验）

**官方文档逐字**（`https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories`）：

> With the `in` qualifier you can restrict your search to the repository name, repository description, repository topics, contents of the README file, or any combination of these. **When you omit this qualifier, only the repository name, description, and topics are searched.**

> Besides using `in:readme`, it's not possible to find repositories by searching for specific content within the repository.

→ **默认面 = 名称 + 描述 + topics，不含 README 正文**；`in:readme` 是触达 README 的唯一途径。

**集合包含实验**（`.scratch/probe-surface4.mjs`）：`in:readme` 把检索限制在 README 内，故若默认面也含 README，必有 `total("T in:readme") <= total("T")`；反向不等式即证伪。六个 token 全部证伪：

| token | 裸查询 | `in:readme` | `in:name,description` | `in:topics` | 比值 |
|---|---|---|---|---|---|
| `open-source` | 449,208 | 13,353,563 | 399,318 | 75,371 | 29.7× |
| `architecture` | 625,616 | 9,719,583 | 622,500 | 10,077 | 15.5× |
| `dsh-plugin` | 23,524 | 39,022 | 8,243 | 19,671 | 1.7× |
| `cordis` | 3,820 | 27,741 | 1,520 | 2,765 | 7.3× |
| `prior-art` | 907 | 68,955 | 786 | 186 | 76.0× |
| `find-ideas` | 3,087 | 1,276,329 | 3,088 | 0 | 413.5× |

且 `裸查询 − in:name,description` 的超出量（49,890 / 3,116 / 15,281 / 2,300 / 121 / −1）全部 ≤ `in:topics`，与「topics 是第三个被检索字段」一致。

**方法论教训（前两个探针失败的原因，勿重蹈）**：用「成员资格」判定检索面在本语料上**不可行**——`probe-topics.mjs` 的 `dsh-plugin` 命中可由 README 解释（脚本只看 name/desc 就打印 DECISIVE，是脚本 bug）；`probe-surface2.mjs` 的 `cordiverse` 裸查询 miss 被索引陈旧性污染（`in:readme` 也 miss）；`probe-surface3.mjs` 全部 inconclusive（百万级结果集里的一次 miss 什么也证明不了，稀有词又常常不在索引里）。**只有集合包含论证不受分页与索引陈旧性影响。**

### R1：检索面陈述的现状（共 7 处，错在两类方向）

**A 类 — 漏报（说少了）**

| 位置 | 逐字内容 | 判定 |
|---|---|---|
| `src/index.ts:68-73` `RETRIEVAL_SURFACE` | `'GitHub repository search matches the repository NAME and DESCRIPTION only. It does NOT index README bodies, and it does NOT index file contents. A project that describes itself as this idea only inside its README or its code is unreachable by any query, however precise.'` | **两处不实**：①「只匹配名称与描述」漏了 topics（官方文档与实测均确认 topics 在默认面内）；②「README 里的项目**任何**查询都触达不了，无论多精确」被 `in:readme` 直接证伪——`in:readme` 就是一个查询 |
| `src/index.ts:53-54` 其 doc 注释 | `'the search endpoint matches a repository's NAME and DESCRIPTION. It does not index README bodies and it does not index code.'` | 同源、同样漏 topics（`README bodies` 半句方向正确） |
| `src/query.ts:1054` 失败文案 | `'  这不代表没有相关项目。GitHub 仓库搜索只覆盖仓库的名称、描述与 topics。'` | **字段列表正确**（与官方文档一致）；唯一缺口是没给出 `in:readme` 这条补救路径。PRD 初稿把它判为错误项，**是误判** |

**B 类 — 错报（说多了）：把 README 写进了默认检索面。这四处 PRD 初稿完全没提，是 R1 的真正主体。**

| 位置 | 逐字内容 | 判定 |
|---|---|---|
| `src/query.ts:242` `STOPWORDS` doc 注释 | `GitHub's repository search AND-matches across name, description and README,` | **错**——默认面不含 README |
| `src/query.ts:1346`（`explainThinResult` 的 `narrow` 分支） | `'  GitHub 仓库搜索对名称、描述、README 做多词 AND 匹配，词越多命中越少。\n'` | **错**，同上 |
| `src/query.ts:1382`（`describeReplayedThinness`） | 同上逐字 | **错**，同上 |
| `src/render.ts:330`（`explainEmpty`） | `'  这通常不是故障，而是查询词太具体：GitHub 仓库搜索对名称、描述、README 做多词 AND 匹配，\n'` | **错**，同上 |

**C 类 — 正确（不得改动）**

| 位置 | 逐字内容 | 判定 |
|---|---|---|
| `src/query.ts:1054` 字段列表 | 见 A 类 | 正确（与官方文档一致） |
| `src/index.ts:1256` `rank_candidates` 描述 | `'yourself (for example with the qualifiers `topic:`, `in:readme`, `stars:>` or `pushed:`), pass your '` | **正确**——同一份代码已经告诉 agent 有 `in:readme` |

**测试侧约束（已实测）**：grep `名称、描述、README|README 做多词|对名称、描述|AND 匹配|多词 AND` 在 `test/*.mjs` 内**只有 1 处命中**——`test/source-integrity.test.mjs:164` 的 `['多词 AND 匹配', 'the Latin operator keeps its spaces']`，它钉的是「拉丁算子保留空格」，**不钉字段列表**。B 类四处把「名称、描述、README」改成「名称、描述、topics」不会挂它。`explainThinResult` / `describeReplayedThinness` / `explainEmpty` 的测试断言只钉 `/查询词过窄/`（`test/queries.test.mjs:628`、`:640`），该短语不在改动范围内。

**`RETRIEVAL_SURFACE` 被逐字重复在三处工具描述里**（`src/index.ts:794`、`:1243`、`:1525`），文件头注释 `:64-66` 明写这是刻意设计：「Kept as one constant and repeated verbatim in all three tool descriptions so the boundary is stated wherever a result is read, and so a test can assert it is present rather than trusting three hand-edited copies to stay in sync.」→ 改一处即改三处，**这正是该常量的设计意图**。

### R2：归档信号的现状

- 采集：`src/github.ts:448` `archived: item.archived === true,`
- 全仓**无归档过滤**，也不参与排序（`src/` 内 `exclude` 零命中；排序只按 `stars`）。
- 逐行标记存在且被测试钉住：`src/render.ts:286` `const archived = row.archived ? ' [已归档]' : ''`（ranked 表）、`src/render.ts:383`（扁平列表），断言在 `test/render-table.test.mjs:203-204`（`rows[0].includes('[已归档]')` / `!rows[1].includes('[已归档]')`）。
- 该标记的保留理由写在 `src/render.ts:280-282`：「The archived marker IS kept, because `archived` cannot be derived from any other column.」
- 项目**已经认为这个标记会被误读**：`src/render.ts:741` 逐字 `'  单看 star 数或少量的「已归档」标记很容易把这类项目当成噪声。'`
- **规模不可见**：没有任何计数。

### R3：通道命中数的现状

- 计算：`src/github.ts:1184` `const fused = new Map<string, { row: RepoCandidate; score: number; sources: Set<number> }>()`；`:1189` 首次命中建 `new Set([index])`；`:1192` `existing.sources.add(index)`。
- 消费：**只有尾座位归因**读它——`src/github.ts:1298-1299`（`roles[index] === 'tail'` → `tailChannels.add(index)`）与 `:1310-1313`（`for (const source of entry.sources) if (tailChannels.has(source)) return true`）。
- **丢弃点（两处，都是 `.map(e => e.row)`）**：`src/github.ts:1239` `entries.slice(0, size).map((e) => e.row).sort(byStars)`（`truncate`，非尾路径）与 `src/github.ts:1324` `[...head.slice(0, size - tail.length), ...tail].map((e) => e.row).sort(byStars)`（尾座位路径）。
- 渲染层零命中：`src/render.ts` 内 `sources` / `channels_hit` **零命中**。→ **信号算出来了，渲染层从不读。**

### 三条硬约束（实测，决定实现方式）

- **约束① — `RepoCandidate` 形状在三处重复声明，且都是 `additionalProperties: false`**：`src/index.ts:839-850`（`scout_projects` 输出）、`:1263-1274`（`rank_candidates` 入参）、`:1334-1345`（`rank_candidates` 输出）。**少改一处，宿主按 `additionalProperties: false` 拒绝整个结果。** 尤其：`scout_projects` 的输出要能原样喂给 `rank_candidates` 的入参，所以 R3 的新字段必须**三处同时**声明为可选。
- **约束② — 八列表格被测试钉死**：`test/render-table.test.mjs:104`（`const COLUMNS = ['#', '项目', '最近更新', 'relevance', 'stars', '得分', '语言', '简介']`）、`:106`（`cells(header).length === 10`）、`:113`（固定顺序）、`:114`（`/^\|-{3,}(\|-{3,}){7}\|$/` 恰好 8 组）。**加列必挂测试。**
- **约束③ — `rank_candidates` 的参数名集合被钉死**：`test/ranking.test.mjs:177` 断言恰好为 `['candidates','idea','keywords','limit','pool_source','scores']`。**给它加参数必挂测试。**（`scout_projects` 的参数集合**未被任何测试钉住**，已验。）

### 行号引用风险（本任务最大的隐性成本）

`.trellis/spec/` 内有 **334 处** `src/*.ts:NNN` 形式的行号引用，分布在 13 个文件；`.scratch/verify-tree.mjs` 连裸 `:NNN` 一起共检 **513 处**。分布：`index.ts` 97 · `render.ts` 68 · `cache.ts` 49 · `github.ts` 40 · `types.ts` 31 · `query.ts` 28 · `select.ts` 7 · `credentials.ts` 6 · `skeleton.ts` 4 · `translate.ts` 4。

**而没有任何测试检查这些引用**（`test/*.mjs` 内 `.trellis|spec/` 只有 2 处命中，且都无关：`evidence-integrity.test.mjs:2` 是注释、`queries.test.mjs:688` 是文件名模式 `src/a.spec.ts`）。→ **改 `src/*.ts` 一旦行号位移，spec 层静默腐烂：编译通过、测试全绿、无报警。**

当前行数（`\n` 切分后去掉末尾空元素）：`index.ts` 1883 · `query.ts` 1405 · `github.ts` 1331 · `render.ts` 1036 · `types.ts` 1032 · `select.ts` 816。

## Requirements

- **R1 — 修正检索面的不实陈述（最高优先），两类方向都要修。**
  - **R1a（A 类，漏报）**：`RETRIEVAL_SURFACE`（`src/index.ts:68-73`）与其 doc 注释（`src/index.ts:53-54`）必须与实测一致：
    - 承认 topics 也在默认检索面内；
    - **删除**「README 里的项目任何查询都触达不了，无论多精确」这一断言，改为陈述 `in:readme` 这条通道的存在；
    - 同时**不得反向过度断言**：必须写明 `in:readme` 扩大覆盖但不保证穷尽（`cordiverse` 反例），且其结果是更宽的网（13.35M vs 449k）而非更准的网；
    - 保持 `RETRIEVAL_SURFACE` 作为**单一常量、三处逐字重复**的现有结构不变（`src/index.ts:64-66` 的注释即其设计理由）。
  - **R1b（B 类，错报——本任务真正的主体）**：**四处**把 README 写进默认检索面的文案必须改成与官方文档一致（默认面 = 名称 + 描述 + topics）：`src/query.ts:242`（`STOPWORDS` doc 注释）、`src/query.ts:1346`（`explainThinResult` 的 `narrow` 分支）、`src/query.ts:1382`（`describeReplayedThinness`）、`src/render.ts:330`（`explainEmpty`）。改法：把「名称、描述、README」改为「名称、描述、topics」；**不得**顺手加 `in:readme` 的说明（这四处讲的是「词越多命中越少」的机制，`in:readme` 与那句论断无关）。
  - **R1c（C 类，正确，不得改动）**：`src/query.ts:1054` 的字段列表「名称、描述与 topics」与 `src/index.ts:1256` 的 `in:readme` 提示都**已经正确**，改动只允许是**追加**（在 `:1054` 补 `in:readme` 这条补救路径），不得删除或改写既有正确字段列表。
  - 失败文案的修改**不得删除** `test/plan-failure.test.mjs:337-352` 已断言的短语：`没有发起任何检索`、`tailReason`、`不代表没有相关项目`、`不相交`/`两个`、`keywords`、`local-first`、`请通过 keywords 参数补充`、`反馈`。
  - B 类改动**不得删除** `test/queries.test.mjs:628`/`:640` 断言的 `/查询词过窄/`。
- **R2 — 上浮归档仓库的规模。** 在既有的诚实性区块内报告「本次池子里有多少行是归档仓库」，措辞须与 `src/render.ts:741` 已有的「已归档标记容易被误读为噪声」一致。
  - **不剔除**归档仓库：本插件是「前车之鉴」工具，归档仓库常是**完工的作品**，剔除会丢掉最有参考价值的样本。
  - **不改得分公式**（`relevance × (1 + log10(max(stars,10)+1)) / 2` 是中心契约，`design.md §2.3` 与测试钉着）——**不得**给归档仓库降权。
  - **不加表格列**（撞约束②）。若要在行内标注，沿用 `[已归档]` 的既有形态。
  - 计数必须能区分「未测量」与「测量结果为 0」——先例 `src/render.ts:357-365`（`lowStarInPool: number | null = null`，注释逐字：「`null` means the caller did not report the pool population — which is NOT the same as reporting zero」）。
- **R3 — 上浮通道命中数。** 把 `selectPool` 已经算出的 `sources.size` 传到渲染层并在卡片上可见。
  - **字段必须可选。** `src/index.ts:1255-1257` 明确允许并鼓励调用方自带仓库池（不经 `scout_projects`），此时该字段不存在；声明成 `required: true` 会让整个调用失败。
  - **三处 schema 同步**（约束①）：`src/index.ts:839-850`、`:1263-1274`、`:1334-1345`。
  - **不加表格列**（约束②）。在既有的「项目」单元格内追加标注，形态参照 `src/render.ts:286`/`:298-299` 的 `archived`。
  - **不加 `rank_candidates` 参数**（约束③）。
  - 渲染层必须把「字段缺失」与「命中 0 条通道」区分开（同 R2 的 null/0 先例）。
  - **不得让它进入打分**：`test/ranking.test.mjs:184` 断言排序器不接受任何计算字段，该断言的主体必须继续成立。

## Acceptance Criteria

- [x] **AC1** `RETRIEVAL_SURFACE` 不再包含「README 里的项目任何查询都触达不了」这一断言，且包含 `in:readme`；三处工具描述仍逐字一致（新增断言：三处**相等**，而不是各自包含）。
  - 证据：`test/retrieval-surface.test.mjs`（三处描述断言**逐字相等**，不是各自包含）
- [x] **AC2** `RETRIEVAL_SURFACE` 承认 topics 在**默认**检索面内。
  - 证据：同上，`topics` 在默认检索面内
- [x] **AC3** `in:readme` 的表述带**双向**限定：既说明它扩大覆盖，也说明它不保证穷尽。**有反例测试**——断言文案包含「不保证」/「并非全部」一类限定词，防止将来被简化成「README 也能搜到」。
  - 证据：同上，反例测试断言「不保证」类限定词存在
- [x] **AC4** `src/index.ts:53-54` 的 doc 注释与 `RETRIEVAL_SURFACE` 同步（不得只改常量、留下同源注释继续漏报 topics）。
  - 证据：`src/index.ts:53-54` 的 doc 注释与 `RETRIEVAL_SURFACE` 同源
- [x] **AC5** `src/query.ts:1054` 的失败文案**追加** `in:readme` 这条补救路径，既有正确字段列表「名称、描述与 topics」保留，且 `test/plan-failure.test.mjs` 现有断言全部继续通过（尤其 `不代表没有相关项目` 与「with a hint 不重复 keywords 建议」两条）。
  - 证据：`test/plan-failure.test.mjs` 原样通过；文案追加 `in:readme` 补救路径
- [x] **AC6** **B 类四处**不再把 README 写进**默认**检索面：`src/query.ts:242`、`src/query.ts:1346`、`src/query.ts:1382`、`src/render.ts:330` 一律改为「名称、描述、topics」；`test/queries.test.mjs:628`/`:640` 的 `/查询词过窄/` 断言继续通过；`test/source-integrity.test.mjs:164` 的 `多词 AND 匹配` 断言继续通过。
  - 证据：`test/queries.test.mjs:628`/`:640`、`test/source-integrity.test.mjs:164` 原样通过
- [x] **AC7** 归档计数出现在卡片上，且**未测量与 0 可区分**（两条断言：测量为 0 时与未测量时的文案不同）。
  - 证据：`test/archived-visibility.test.mjs` §R2.3（未测量 vs 测量为 0 文案不同）
- [x] **AC8** 归档仓库**不被剔除、不被降权**：得分公式、排序、行数成员关系均有反例测试（构造一个 archived=true 的行，断言它仍在榜上且得分与 archived=false 的同参数行相同）。
  - 证据：`test/archived-visibility.test.mjs` §R2.5（得分与成员关系均不变）
- [x] **AC9** 通道命中数出现在卡片上；`scout_projects` 的输出能**原样**通过 `rank_candidates` 的入参校验（往返测试，不是分别校验两个 schema）。
  - 证据：`test/channel-visibility.test.mjs` §R3.6：生产者输出原样喂给消费者，用**主机自己的** `validateJsonSchemaValue`（`@deepseek-ai/dsh-tools`）判定，不是手写校验器
- [x] **AC10** 通道命中数**缺失**时不渲染任何数字，且不渲染为 0（断言两种输入产出不同文案）。
  - 证据：`test/channel-visibility.test.mjs` §R3.3（两种输入文案不同）
- [x] **AC11** 通道命中数**不进入打分**：同参数下改 `channels_hit` 不改变 `score`、`rank` 与顺序。
  - 证据：`test/channel-visibility.test.mjs` §R3.5（score / rank / 顺序三者均不变）
- [x] **AC12** 表格仍是**恰好八列**：`test/render-table.test.mjs` 的四条列断言全部原样通过，无新增列。
  - 证据：`test/render-table.test.mjs` 四条列断言原样通过；`test/channel-visibility.test.mjs` §R3.4 另断言八列
- [x] **AC13** `test/ranking.test.mjs:177` 的参数名集合断言原样通过（未新增 `rank_candidates` 参数）。
  - 证据：`test/ranking.test.mjs:177` 原样通过；`test/channel-visibility.test.mjs` §R3.7 另断言一次
- [x] **AC14** `.trellis/spec/` 的行号引用全部有效：`.scratch/verify-tree.mjs` 输出 `PAST EOF: 0`、`nonexistent file: 0`、`NEEDS ADJUDICATION: 0`。**若某文件的改动不可避免地位移了行号，必须在同一提交内更新受影响的 spec 引用。**
  - 证据：`.scratch/verify-tree.mjs` → `PAST EOF: 0` / `nonexistent file: 0` / `NEEDS ADJUDICATION: 0`。**R3 不可避免地位移了行号**：三处 schema 站点在 `src/index.ts` 深处、两处 interface 在 `src/types.ts` 深处，`src/github.ts` 与 `src/render.ts` 已排成净零位移。174 处引用在**同一提交** `fdc1c7d` 内机械重编号，并逐条证明指向同一段文本（范围引用只允许按 diff 实际插入的行数扩张）。`.scratch/cite-guard.mjs check` → 539/539 文本一致
- [x] **AC15** 全量校验全绿：`npx tsc --noEmit`、`npm run check`、`node test/run-all.test.mjs`（21/23 passed, 2 skipped 为基线；末条 45 PASS / 0 FAIL 为基线）。**复核红灯必须直接跑 `node test/<file>`，不带 `--test`**——本项目测试自己打印 `FAIL`/`PASS`，`node --test` 的过滤会给出假阴性。
  - 证据：`npx tsc --noEmit` 绿、`npm run check` 绿、`node test/run-all.test.mjs` → **24/26 passed, 2 skipped**（基线 21/23 加上本任务新增的三个测试文件；2 个 skip 仍是 `baseline`/`stage2` 的冻结 eval 夹具缺失，与本任务无关）。末条 45 PASS / 0 FAIL 未变

## Out of Scope

- **不把 `in:readme` 做成第二条检索通道。** 成本被第三方报告低估：它会改变查询计划产出，而 `test/baseline.test.mjs` 与 `test/stage2.test.mjs` **回放冻结的 eval 记录**（`eval/runs/` 不在仓库，新克隆上自我跳过——`test/run-all.test.mjs:9-17` 解释了这点）；`SEARCH_PLAN_VERSION = 7`（`src/types.ts:987`）与缓存键（`src/types.ts:1023-1031`）绑在计划上，改计划须升版本 + 重做基线。本任务只修**陈述**，不动**计划**。R1 的取证为将来做这条通道提供了实测依据（含噪声量级与穷尽性反例）。
- **不做 `--exclude` 后置黑名单**（报告 P1-1）。缺口属实（`src/` 内 `exclude` 零命中），但过滤必须发生在池装配之后、座位分配之前（否则被排除者仍占配额座位），且必须渲染「排除了几条」。属独立交付。
- **不做 awesome-list 识别降权**（报告 P1-2）。标记需要动三处 schema，降权需要动中心公式；而 `MIN_RELEVANCE = 3`（`src/types.ts:310`）与尾座位机制已处理主要噪声形态。
- **不做规范锚点回填 / 话题扩展 / 先 2 轴再决定第 3 轴 / 相似仓库**（报告 P1-3、P1-4、P1-5、P2-3）：都要新数据表、N+1 请求或 A/B，不属于本批次。
- **不做检索结果落盘**（报告 P0-1）。报告引用的 668,409 / 674,064 字节事故（注释在 `src/render.ts:36-40`）**早已修好**：`MAX_DESCRIPTION_CHARS = 200`（`src/render.ts:47`）+ `clipDescription`（`src/render.ts:58`）已在两条渲染路径生效（`:384` 扁平列表、`:308` ranked），实测池子 6128 B。这是「新能力」，不是「修 bug」，不在本任务。
- **不并行化检索**（报告 P2-4）。顺序执行是刻意设计：`src/github.ts:683` 逐字「Queries run **sequentially**, not in parallel: the anonymous budget is 10 requests per minute for the whole egress IP」。
- **不改得分公式、不加表格列、不给 `rank_candidates` 加参数**（见约束②③）。

## 技术注记

### 第三方报告本身的判定错误（本任务不得继承）

1. **伪造/错引的直接引语**：报告称对方 README 写着 `"script is mechanical, no LLM"`，但 `README.md` / `README_zh.md` / `SKILL.md` 三个文件 grep `mechanical|no LLM|no-LLM` **全部零命中**。结论方向可能对，**引语不可复述**。
2. **行号偏移**：报告把落盘逻辑定位在 `explore.py:786-836`，实际在 `:1044-1049`（差约 250 行）。
3. **优先级定级偏乐观**：把动机已过期的 P0-1（落盘）与真缺口 P0-2（通道命中数）并列为 P0。

### 取证脚本（`.scratch/`，gitignored，不随仓库发布）

| 脚本 | 覆盖内容 |
|---|---|
| `.scratch/probe-surface4.mjs` | **决定性**：集合包含实验（六个 token × 四种查询形态），证伪「README 在默认检索面内」。不受分页与索引陈旧性影响 |
| `.scratch/probe-readme-surface.mjs` | 用 `deepseek-ai/deepseek-harness` 做 README-only 词的对照实验：`in:readme` 的覆盖增益（三词全命中）与穷尽性反例（`cordiverse` 仍 miss） |
| `.scratch/probe-surface.mjs` | 四个限定符（裸词 / `in:readme` / `in:name,description` / `in:topics`）对 `dsh-plugin` 的 `total_count` 切分 |
| `.scratch/probe-topics.mjs`、`.scratch/probe-surface2.mjs`、`.scratch/probe-surface3.mjs` | **已证伪的三个探针，仅供追溯**：成员资格论证在本语料上不可行（见上方方法论教训）。它们的第一版结论是错的，不得引用 |
| `.scratch/verify-tree.mjs` | 独立校验 `.trellis/spec/**/*.md` 里每一处行号引用是否落在符号范围内；AC14 用它 |

### 实现前必须重测的基线

```powershell
npx tsc --noEmit
npm run check
node test/run-all.test.mjs
node .scratch/verify-tree.mjs     # 基线：513 citations, PAST EOF 0, nonexistent 0, NEEDS ADJUDICATION 0
```

改动后再跑一次，逐项对比。**行数敏感的改动优先保持行数不变**（项目既有做法：上一次修复即「`src/render.ts` 保持 1036 行、`src/index.ts` 保持 1883 行」）。

### 建议实现顺序

R1（零风险，改字符串，先做）→ R2（不改公式，便宜）→ R3（收益最大，是契约变更，最后做且三处 schema 同步）。
