# dsh-find-ideas v0.1 — 设计

> 规划阶段产物。**实现授权只来自用户对本方案的明确批准**（2026-10-15 复审更正：原文写「授权来自 `python ./.trellis/scripts/task.py start`」，但 `task.py start` 只是 Trellis 的状态迁移动作，不是授权来源——工具不能自己给自己发授权）。批准后再执行 `task.py start` 把任务推进到实施态。
> 需求见同目录 `prd.md`（R1–R7 / AC1–AC8）。本文件只记录**架构、契约、兼容与权衡**，不重复需求原文。

## 1. 架构与边界

### 1.1 形态：纯 Host 半边

插件只通过 `output.render` 产出模型可读文本，不写 `client.js`、不碰 typert 契约。理由：本插件的消费者是主 Agent 而不是人眼（Out of Scope 已排除 GUI 面板），且 UI 增强类插件在生态里已饱和。

入口契约（沿用前身已验证形状）：

```ts
export const name = 'dsh-find-ideas'      // ← 插件身份改名（见 §3.1）
export const inject = ['tools']            // ← 只有 tools 是硬依赖
export function apply(ctx: Context): void  // ← 三处 ctx.tools.register(defineTool(...))
```

### 1.2 模块布局

移植的九个模块（`src/`，全部成为本仓库自己的源码）：

| 模块 | 职责 | 移植改动 |
|---|---|---|
| `types.ts` | 类型 + `rankCandidates` + 公式打分 + 评分分布分析 | 统一候选身份视图、`note` 透传（§1.4、§2.3） |
| `github.ts` | 检索、三查询计划执行、tree/readme/file 抓取、限流与配额 | 探针守卫改看 search 桶（§4.3）、余席按 RRF 排序（§1.4） |
| `query.ts` | 三查询长尾计划生成、规划失败解释 | 无 |
| `lexicon.ts` | 97 条中英词表兜底种子 | 无 |
| `select.ts` | 源码扩展名枚举、架构文件挑选 | **软排除 + 零源码 fallback**（§4.5；被 `skeleton.ts` 复用） |
| `cache.ts` | 成功/失败 TTL 缓存 | **记录 completeness / failedRepos**（§1.4、§2.5） |
| `credentials.ts` | `GITHUB_TOKEN` 解析与匿名降级 | 无 |
| `render.ts` | 候选/排序/骨架渲染 | **`renderRanked` 改为 Markdown 表格**（§2.3）+ 全字段转义 + `note` 透传 + 截断标注 |
| `index.ts` | 插件入口 + 三工具定义与编排 | 翻译接线、骨架接线、渲染调用点、缓存完整性、复用已读 README（§1.4） |

新增两个模块：

| 模块 | 职责 | 依赖 |
|---|---|---|
| `translate.ts` | 插件内 LLM 翻译（R2） | 零新依赖（`ctx.get` + duck typing） |
| `skeleton.ts` | 有界启发式签名扫描器（R5） | 零新依赖（复用 `select.ts` 地基） |

### 1.3 服务读取边界（决定性约束）

**只有 `'tools'` 进 `inject`。** 其余三个服务全部走 `ctx.get()`：

| 服务 | 读取方式 | 缺失时行为 |
|---|---|---|
| `credentials` | `ctx.get('credentials')` | 匿名模式（既有行为，`src/index.ts:272` 已验证） |
| `llm` | `ctx.get('llm')` | 翻译降级（R2 / AC2） |
| `agentDefaultModel` | `ctx.get('agentDefaultModel')?.currentSelection()` | 用 provider/model 缺省路径降级 |

**把 `'llm'` 或 `'credentials'` 写进 `inject` 会让插件在缺该服务的宿主上整体加载失败**——这正是 AC2 与 AC8 要防的。Cordis 下未声明 `inject` 就读 `ctx.llm` 会抛 `cannot get property without inject`，所以**必须**用 `ctx.get`。

### 1.4 移植时就地修复的五条证据完整性缺陷

2026-10-15 复审发现：idea-scout 的「已验证内核」只覆盖**主路径**。以下五条性质**未**被验证，且全部直接影响「证据可信」这个立身之本，因此**在移植时就地修复**，不留给后续任务（对应 `prd.md` R1 的诚实边界与 AC11）。**这不是「顺手改前身」**——这五条会原样继承进新仓库，继承的缺陷就是新仓库的缺陷。

| # | 缺陷 | 位置 | 就地修法 | 不修会怎样 |
|---|---|---|---|---|
| 1 | RRF 算了但没用来排序 | `src/github.ts:937-946` 累积、`:961` 按 `[...quota, ...fused.keys()]` 插入顺序取余席 | **保留 quota 席，余席按 RRF 分数排序** | 跨通道命中的高相关项被漏（复现：`x` RRF `0.03149801587301587` > `a2` `0.015873015873015872`，`x` 仍被漏） |
| 2 | 候选身份两套视图 | `src/types.ts:673-694`（排名遍历原始 `candidates`）vs `:501-514`（`findScoreGaps` first-score-wins） | 排序与**全部**诊断共用同一个 lowercase `full_name` 视图 + 同一份有效评分 | 同一仓库传两次出两行；最终两项都是 9 分却仍报 1/9 冲突 |
| 3 | 缓存把部分批次回放成完整成功 | `src/index.ts:1258-1276`、`:1327`（命中返回 `degraded: null`）、`:1366-1377` | 缓存存 requestedRepos / failedRepos / completeness / fetchedAt / 各文件错误；命中**重建「部分证据」**而非完整成功 | 读到一半被限流，再查同样的仓库**看起来是完整成功** |
| 4 | 重复读 README + 多级截断无标记 | `src/index.ts:416` 与 `src/select.ts:468` 重复；`src/index.ts:463` 二次截断未标 | 复用已读 README 填第一槽；tree / API / file / excerpt / render 五级截断逐级标注范围 | shallow 6 次请求里 1 次纯浪费；扫描器搭在未标记窗口上，读者无法知道证据被剪过 |
| 5 | 自动选择器是 Tauri 笔记样本适配 | `src/select.ts:148-151`、`:415-426` | **软排除 + 零源码 fallback + 按仓库布局填槽**（§4.5） | Android / Python CLI / Go 服务的 inspect 拿不到任何源码证据 |

**预算不变**：4 槽 / 6 请求 / 4500ms（shallow）与 `INSPECT_BUDGET` 其它档位**一律不动**——这五条都是「同样的预算花得更值」，不是「花更多预算」。

**回归证据**：每条都必须有针对性反例测试（§3.6），不能只靠「主路径还能跑」。

## 2. 数据流与契约

### 2.1 三段流水线

```
scout_projects(idea, keywords?)
   ├─ 非英文 idea 且 keywords 无拉丁字母 → translate.ts（§2.2）
   ├─ tryPlanQueries() → 三查询计划（anchor/precise/tail）
   ├─ searchMerged() → 候选池（含 pushed_at）
   └─ renderCandidates() → 候选清单 + degraded

rank_candidates(idea, candidates, scores[{full_name, relevance, note?}], keywords?, limit?, pool_source?)
   ├─ rankCandidates() → 代码内算分排序（调用方只能给 full_name + relevance）
   └─ renderRanked() → Markdown 表格 + 诚实性区块（§2.3）

inspect_projects(idea, repos, depth?)
   ├─ 配额检查（发请求前，R6）
   ├─ tree / readme / 架构文件摘录（INSPECT_BUDGET 内）
   ├─ skeleton.ts 扫描 1200 字符摘录（§2.4）
   └─ renderInspections() → Markdown 骨架
```

### 2.2 翻译契约（R2）

```ts
export interface TranslateOutcome {
  keywords: string
  source: 'llm' | 'caller' | 'none'
  degraded: Degraded | null
}
export function translateIdea(idea: string, callerKeywords: string, signal?: AbortSignal): Promise<TranslateOutcome>
```

调用链：`ctx.llm.stream({ provider, model, system, messages, temperature, maxTokens })` 返回 **AsyncIterable**（不是 Promise），`for await` 累加 `type === 'text-delta'` 的 `chunk.text`。`provider`/`model` 从 `ctx.get('agentDefaultModel')?.currentSelection()` 读，**不在 config 里硬编码模型 id**。

**决策表**（顺序即优先级）：

| 条件 | 行为 |
|---|---|
| idea 已含拉丁字母（含混合 Han+Latin） | **不调 LLM**，走既有路径（零新增延迟与配额） |
| idea 非英文，caller keywords 含拉丁字母 | **不调 LLM**，用调用方给的（调用方更了解意图） |
| idea 非英文，无有效 keywords，`ctx.get('llm')` 可用 | 调 LLM → 校验 → 用其结果，输出标注来源 |
| LLM 缺失 / 超时 / 抛错 / 输出非法 | 回落到既有 `refuseChineseIdeaWithoutKeywords` 路径，`degraded.detail` 说明**为什么**（比今天的拒绝更有信息量） |

**⚠️ 「跳过翻译」不得重新落进旧守卫（2026-10-15 复审发现的自相矛盾）。** 前身守卫 `src/index.ts:337-345 refuseChineseIdeaWithoutKeywords` 判的是「**任何**汉字 **且** keywords 无拉丁字母」就拒绝，调用点 `src/index.ts:656-659`。所以输入 `本地优先的 Markdown 笔记应用，支持双向链接`（不给 keywords）会：含拉丁 → 按上表跳过翻译 → **仍然命中旧守卫 → `plan_failed`**。这是接线矛盾，不是行为缺陷。

修法（**不改「含拉丁不翻译」这条裁定**）：跳过翻译 **≠** 继续走旧拒绝分支。为「跳过翻译」的输入构造确定性的规划器上下文（例如从 idea 里的拉丁词直接生成 seed，或给新编排一个「已通过」分支标识），**不让它重新进入为「纯中文且无英文词」设计的旧守卫**。旧守卫只保留给「LLM 不可用且确实无任何拉丁字母」这一条回落路径。

**四分支必须都有测试**：纯中文无 keywords / 混合 Han+Latin 无 keywords / 纯英文 / 调用方已给 keywords。

输出校验（全部为硬性，任一不过即视为非法 → 降级）：至少一个含拉丁字母的词；词数 1..`MAX_QUERY_TERMS`；总长有界；剥离 markdown 围栏与引号；**CJK-only 输出视为非法**。LLM 输出是**不可信输入**，按 adversarial 处理。

**检索词预算（2026-10-15 复审）**：翻译产出的词**不会全部进入查询**。规划器固定只吃 `latinSeed.slice(0, 2)`（宽查询）与 `latinSeed.slice(0, 3)`（长尾），中文通道用 **idea 的前两段**而不是翻译结果（`src/query.ts:555-579`）。实测 `blockchain explorer multi-chain transaction tracing` 与 `blockchain explorer multi-chain social feed` 得到**完全相同的三条查询**——关键能力约束凭空消失。因此：
- **prompt 必须写明这个预算**：至多 3 个词、按重要性排序——前 2 词 = 领域核心（进宽查询），第 3 词 = 最关键的能力/限定符（只进长尾）。
- **输出必须报告实际进入查询的词与被丢弃的后缀**，让「翻译成功但关键约束没进检索」可见。

超时：自带 `AbortSignal.timeout(8000)` 并转发 `exec.signal`（调用方取消优先）。任何失败**都不得让工具调用失败**。

### 2.3 表格契约（R3 / R4）

`renderRanked` 的输出结构，**自上而下顺序固定**：

1. `🎯 针对 idea 排序后的候选（共 N 个，按 relevance × (1 + log10(max(star,10)+1)) / 2 排序）` + idea 原文 + 候选池来源（若调用方声明）
2. `【代码计算区】` 的声明，**必须分成三类**（2026-10-15 复审更正：原文写「以下每个数字均由代码算出，调用方不能指定或改动」，这**超出实现边界**——实测传 `stars=99999`、`pushed_at=2099-01-01`、`pool_source=scout_projects`，工具照常出表且无任何告警，见 `src/index.ts:869-929`、`:924-929`、`:1034-1079`）：
   - `relevance` = **调用方判断**（0–10，工具不校验其正确性）
   - `stars` / `pushed_at` / `description` = **传入元数据**（来源声明未校验；调用方自带候选时不会重查 GitHub）
   - `得分` / `评级` / `顺序` = **代码派生**（可由公式复算）
   
   措辞要点：**算术可复算 ≠ 输入是真的；工具不报警 ≠ 已核实。**
3. **Markdown 表格**（八列）：

| # | 项目 | 最近更新 | relevance | stars | 得分 | 语言 | 简介 |
|---|---|---|---|---|---|---|---|
| 1 | `[owner/name](html_url)` + 归档标记 | `pushed_at` 或占位 | `9/10` | `12.3k` | `8.4` | `TypeScript` | `clipDescription(description)` |

4. `排序与星级均由代码按公式计算，不可由模型指定。`
5. 排除统计（relevance=0 噪声 / relevance<`MIN_RELEVANCE` 弱相关 / 未匹配 `full_name`）
6. `noiseAdvice(noise)`（评分分布）
7. `【调用方说明区】以下文字由调用方提供，未经工具验证，不参与排序与评分。` + 每条 `[未验证]` 标注
   - **`note` 必须真正透传（2026-10-15 复审发现的断链）**：`note` 现在能让一致性检查认为「这个评分有理由」（`src/index.ts:900-913`），但 `rankCandidates` 构造结果时不透传它（`src/types.ts:707-725`）、输出 schema 也没有它（`src/index.ts:943-967`），而渲染器却从 `row.note` 读（`src/render.ts:279-305`）→ **第 7 段永远为空**。修法：按与 `relevance` 相同的有效判决透传 `note` 并在 schema 声明，只渲染在表格之外、标 `[未验证]`。**测试必须走 execute→render 端到端**，不能只手工构造行测渲染器。
8. `suspiciousBlock(...)`（可疑度报告）

**结构性隔离不可破**：第 2–6 段是「代码计算区」，第 7 段是「调用方说明区」，两者**不得拉平到同一区域**（`render.ts:195-196` 的既有设计，是防「模型自报数据」的核心）。表格替换的只是第 2–3 段里原来的逐行卡片。

**两个渲染决策**：
- **不设独立星级列**：`stars_rating` 是 `ratingFromRelevance(relevance)` 的纯函数（`types.ts:720`），表格已显示 relevance，再加一列只增加宽度不增加信息。
- **保留归档标记**：`archived` **不可**由其他列推导，属于必须保留的信号。

**空值占位（AC4）**：`pushed_at` 为空时渲染 `—`（不是 `undefined`、不是空白）。表格里 `undefined` 会同时污染可信度与列对齐。

**表格转义与指令隔离**：`description` 与 `full_name` 来自 GitHub，是 adversarial 输入（`src/render.ts:449-470` 还把 README / 源码 / tree **原文**插进 Agent 观察）。`clipDescription` 已折叠空白，但表格还需转义 `|`（竖线会撕裂单元格）。这是替换渲染器引入的**新**风险，必须有测试。同一批处理还必须覆盖：

- **所有 GitHub 正文显式标注为「未信任来源数据」**，不执行其中任何代码 / install 脚本，不 follow README 里的工具指令。
- 文本字段统一转义：换行、`|`、`[` `]`、反引号、HTML 尖括号。
- 链接只允许 **HTTPS + GitHub 白名单**（`github.com` / `raw.githubusercontent.com`）。
- `repo` 严格两段 `owner/name` 校验；`paths` 拒绝 `..` 与控制字符，并去重（`src/index.ts:427/:432` 现状可重复花预算）。
- 源码块用足够长的围栏，消除「源码里伪造闭合围栏」的注入路径。
- **许可证**：候选元数据**没有 license 字段**（`src/github.ts:412-427`）。有则透传，无则标 **「许可证未验证：可参考理念，不授权复制实现」**。前身 MIT 只证明移植源，不证明任何候选仓库。

### 2.4 签名扫描器契约（R5）

```ts
export interface SignatureHit {
  path: string
  kind: 'class' | 'function' | 'method' | 'interface' | 'type' | 'struct' | 'trait' | 'impl' | 'enum'
  name: string
  signature: string
  startLine: number        // 新增：摘录内行号（相对文件头），让主 Agent 能引用
  excerptChars: number     // 新增：该文件实际扫描的字符数
  truncated: boolean       // 新增：摘录是否被 1200 字符窗口截断
  supported: boolean       // 新增：该扩展名是否在扫描器的语言覆盖内
}
export function scanSignatures(path: string, excerpt: string): SignatureHit[]
```

- **只扫已有的 1200 字符摘录**（`src/index.ts:463` `file.text.slice(0, 1200)`），**不新增请求**，`INSPECT_BUDGET` 不变。
- 行级正则覆盖 TS/JS、Python、Go、Rust、Java/C# 的常见声明形态；用 `select.ts:138 SOURCE_EXT_RE` 判定语言；不在覆盖内的扩展名返回 `supported: false` 而**不是空数组**（空数组会被读成「没有声明」）。
- 每文件命中数有上限，避免一个文件吃满输出预算。
- 输出**必须**声明这是启发式提取且摘录可能被截断（沿用「截断即标注、缺失不等于不存在」的既有模式）。

**⚠️ 必须诚实命名为「局部声明证据」而非「架构骨架」（2026-10-15 复审）。** `src/index.ts:450-463` 是**先读 4000/12000 字符再 `slice(0, 1200)`**，所以 1200 字符窗口是**文件头**——版权头 + import 就能吃满它，而类/函数主体通常在文件头之外；且这次二次截断在 `src/index.ts:463` **完全未标记**。因此：

| 约束 | 理由 |
|---|---|
| 输出声明「这是**文件头局部声明证据**，不是完整架构」 | 避免主 Agent 把文件头读成架构全貌 |
| **零命中 ≠ 该仓库没有类/函数** | 可能只是文件头没写声明；`supported: false` 时更是完全未测 |
| 拓扑结论（依赖方向 / 调用链 / 持久化边界 / 进程边界）**只在摘录内出现 import / 调用 / 接口等直接证据时**才允许输出 | 签名列表推不出依赖方向 |
| 保留已有 `tree.sha` / `blob.sha`，但 **tree SHA ≠ commit SHA** | 不得冒充 `blob/<commitSHA>/path#Lx-Ly`；要不可变链接须先确认 commit SHA |
- 零新依赖：不使用 TypeScript 编译器 API（22.5 MB、只惠及两种语言），不使用 tree-sitter（原生模块 + 构建链，Windows 风险）。

### 2.5 降级契约（R6，继承不变量）

- 任何单点失败都返回部分结果 + `degraded: { reason, detail }`，**不抛错**。
- **在发请求之前**拒绝会超出剩余配额的源码读取——「看起来完整的截断检查」会让模型描述它从未见过的架构。
- 请求了却读不到的路径必须报告，绝不静默丢弃。
- **缓存不得把部分证据洗成完整成功（2026-10-15 复审）**：命中缓存时若 `failedRepos` 非空或 `completeness` 不是 full，必须重建出对应的 `degraded`，**不能返回 `degraded: null`**（现状 `src/index.ts:1327` 正是这么做的）。
- **有效缓存应先于网络配额拒绝**（现状 `src/index.ts:1258-1276` 的配额拒绝在 cache 查询之前 → 配额没了就连缓存也用不了）。
- 缓存 key 必须含 **auth 可见性**（对比已修的 search key `src/types.ts:941-949`）与 **selector / scanner 版本**（新扫描器复用旧 source cache 会让两版证据混淆）。
- 缓存写失败时保持既有 memory fallback，但**不承诺持久**（`cache.ts:153-168`）。

### 2.6 证据链的端到端要求（2026-10-15 复审新增）

主 Agent 的**事实主张必须绑定 inspect 返回的仓库 URL / 文件路径 / 摘录位置**，不能仅凭 `score` 或「没有告警」就断言某仓库具备某架构。工具侧对应义务：

- 每条签名证据带 `path` + `startLine` + `excerptChars` + `truncated`（§2.4）。
- 每条源码摘录带截断标注与范围（§1.4 缺陷 4）。
- 不确定的拓扑结论**不输出**，或显式标为「未测」（§2.4）。
- 许可证状态显式标注（§2.3）。

### 2.7 检索质量的可观测性（2026-10-15 复审新增）

**长尾指标是候选池覆盖，不是最终榜覆盖。** 公式 `relevance × (1 + log10(max(stars,10)+1)) / 2` 会让大仓系统性压过小仓——精确复算：r10/0★ = `10.206963425791125`，r10/31★ = `12.525749891599531`，r7/50000★ = `19.946425415485795`，r9/45000★ = `25.439499740954695`。**7 分大仓高于 10 分精准小仓。** 前身只在池化阶段留了长尾席（`src/github.ts:1007`、`:1031-1043` 的 `min(8, floor(pool/2))`），最终排序与默认截 10 行（`src/types.ts:728-731`、`src/index.ts:1035/:1045`）又会压平。

**决策：不改公式（用户既有裁定），但让长尾流失可见。** 诊断必须**分开**统计：
- 候选池里的低 star 数（长尾是否进了池）
- **最终榜里的低 star 数**（长尾是否活到了输出）

主 Agent 选骨架时额外检查「高 relevance 低 star」候选。要保最终榜长尾席需要用户新裁定。

**查询诊断不得强于证据（2026-10-15 复审）**：`src/types.ts:240-248` 把 carrying 定义为「少/无额外约束」，但 `src/index.ts:134-145` 用 `total===0 → carrying`、`-1 → selective`、`计数 ≥ 最宽 0.7 → carrying` 反推，单词 `alpha=100` / `beta=100` 都被判 carrying，而两个集合可能完全不交——**solo count 证明不了 AND 冗余**；零命中词反而可能是强限制。修法：solo totals 明确表述为**基数 / 宽泛度启发式**，不是语义约束力；未知标「未测」、零命中标「solo 无命中」；缓存命中时显示「诊断未保存」（现状 `src/index.ts:729` 存 `query_terms=[]`、`:767-772` 不缓存诊断）。长尾失败文案从「只包含高 star、≤100 无法进池」改为「**长尾通道覆盖未知**」（`src/query.ts:1250-1252` 的绝对断言在 anchor-only 三个 5★ 的反例下不成立）。

## 3. 兼容与迁移

### 3.1 移植基线 = 工作区状态，不是 HEAD

idea-scout 工作区有 1857 行在飞改动（双语路由 + 噪声/可疑度报告），其中双语路由是修复 CJK 语言域不匹配这个 P0 的成果。**退回 HEAD 会让新版比现状更差。**

provenance（移植时按此核对，`D:\workspace\work_space2\dsh-idea-scout`）：

| 项 | 值 |
|---|---|
| HEAD | `e4dfccf63abd60aee5819b03607e84ec7eeb6ac9`（`docs: rewrite the README as an entry page, add a Chinese mirror`） |
| sha256(tracked diff) | `cb10ca2605999217bb1e5173387aec1ad1bd4c4fa69e8bcccb1a0bd85a169ed1` |
| sha256(`test/bilingual-routing.test.mjs`) | `c309ab5d16d72d0809436e6d3e26176e7dab91613b8a44be72d80e493eb07258` |
| diffstat | 12 files changed, 1857 insertions(+), 249 deletions(-) |

### 3.2 公开面：插件身份变，工具面不变

| 维度 | 变化 |
|---|---|
| 包名 / `export const name` / bundle 层 id | `dsh-idea-scout` → **`dsh-find-ideas`** |
| 三个工具名 | **不变**（`scout_projects` / `rank_candidates` / `inspect_projects`） |
| 参数键 | **不变**（含 `keywords` / `pool_source` / `depth`） |
| 打分公式与排序 | **不变** |

用户 m00636 裁定：工具名冲突的正解是让前身退休，而不是给继任者改名。因此既有断言（`test/ranking.test.mjs:165-169` 三工具已注册、`defs.get('scout_projects')`）移植后应当**继续成立**。

### 3.3 两处红灯随移植修正（不是行为缺陷）

| 位置 | 根因 | 修法 |
|---|---|---|
| `test/ranking.test.mjs:175` | 期望值漏了后来加入的 `pool_source`（`src/index.ts:924` 声明 / `:1079` 读取） | 把 `pool_source` 加进期望数组，**不放宽成子串测试** |
| `test/bilingual-routing.test.mjs:144` | `assert.deepEqual` 比对**全部** fetch 调用，未排除 B6 的 3 次逐词探针（`github.ts:774 MAX_TERM_PROBES` / `:789 probeTermTotals`） | 把断言限定在计划调用上（`calls.slice(0, expected.length)`），并**新增**「探针不参与排序」的断言；同文件 `:151` 的 `calls.length === 3` 同步处理 |

**一个自带红灯的新仓库会立刻失去「证据可信」这个立身之本**（R7 / AC7 要求全绿）。

### 3.4 启用与退休（用户 m00688 裁定 B）

- 装插件 = **同时**加 `dependencies` **和** `dsh.profile.bundles` 两项，缺一不生效。
- 顺序：**先在克隆 profile 上做无头验证**（§5.2），通过后才动 live desktop profile；同时移除 idea-scout 的悬空 `file:` 依赖。
- idea-scout 当前不在 `dsh.profile.bundles`、`cordis.patch.yml` 也无插入项 → **本来就没激活**，移除只是清理悬空链接，不改变现有行为。
- **绝不让两者同时激活**：工具名相同，会冲突。

### 3.5 peer 范围已覆盖宿主线（已实测）

| 检查 | 结果 |
|---|---|
| `^0.2.0-rc.1` vs 宿主 `0.2.0-rc.2` | **satisfies: true** |
| `^4.0.1` vs cordis `4.0.4` | **true** |

宿主 `desktopVersion = 0.2.0-rc.2`（`resources\runtime\primary-runtime\runtime.json`）。`@deepseek-ai/dsh-tools` 由内核运行时提供（desktop profile 的 `node_modules/@deepseek-ai` 只有 `cosmokit` + `schemastery`，`.dsh-module-fallback/node_modules` 无 `@deepseek-ai`）→ **只能写 peerDependencies**，写进 dependencies 会装出第二份导致上下文割裂。

### 3.6 证据完整性修复的回归反例（2026-10-15 复审新增）

每条修复都必须有**针对性反例测试**，不能只靠「主路径还能跑」：

| 修复 | 必测反例 |
|---|---|
| 余席按 RRF 排序（§1.4-1） | `channels=[a0,a1,a2,x],[b0,b1,x,b3]` 全 200★、limit 5 → `x` 必须入选（旧行为漏掉 `x`） |
| 统一候选身份视图（§1.4-2） | 同一 `full_name` 大小写不同传两次 → **一行**；两项最终同为 9 分 → `findScoreGaps` **不得**报冲突 |
| 缓存完整性（§1.4-3） | 2 个仓库、第 2 个限流 → 命中缓存时必须带 `degraded` / `failedRepos`，**不得**是 `degraded: null` |
| README 复用与截断标注（§1.4-4） | shallow 请求数从 6 降到 5；每级截断都有标注；扫描器输入是标记过的窗口 |
| 选择器通用化（§4.5） | Android / Python CLI / Tauri 三棵树都**至少有一个源码文件**入选 |
| 混合 Han+Latin 接线（§2.2） | 四分支：纯中文无 keywords / 混合无 keywords / 纯英文 / 调用方已给 keywords |
| `note` 透传（§2.3） | execute→render 端到端：`note` 出现在【调用方说明区】并标 `[未验证]` |
| 探针守卫资源桶（§4.3） | core 充足但 search 剩余 0 → 探针**被跳过**；search 充足 → 保留 |
| 检索质量可观测性（§2.7） | 低 star 候选在池里但被最终榜挤掉时，两个统计**分别**反映出来 |
| 指令隔离与转义（§2.3） | 含 `\|`、换行、反引号、伪造围栏、README 注入句的描述不撕裂表格、不越出数据区 |

## 4. 关键权衡

### 4.1 表格替换卡片（用户 m00624 A）
表格比逐行卡片更省 token、更易被模型结构化消费；代价是失去卡片的分隔线视觉分组，且引入 `|` 转义这一新风险。选择**替换而非并存**，因为并存会让每次排序输出 token 翻倍，与本插件「省 token」的核心卖点相悖。

### 4.2 启发式扫描器 vs 精确解析（用户 m00612 A）
代价是**可能漏项**，且对宏、装饰器、条件编译等形态无能为力；换来零依赖、零构建链、六种语言覆盖。诚实标注是这一权衡的补偿：读者知道这是启发式，就不会把「没列出」读成「不存在」。

### 4.3 逐词探针的配额代价（2026-10-15 复审修正了资源桶）

B6 的 `probeTermTotals` 把每次搜索的请求数**从 3 翻倍到 6**（实测：计划 3 次 + 探针 3 次）。**这个事实成立**；但由此推出的「匿名配额 60/小时 → 每小时检索次数从 20 减半到 10」**作废**——它把 core 桶的配额套到了 search 请求上。

**资源桶修正（源码 + 官方规则已证实）**：探针调的是 `/search/repositories`（`src/github.ts:812`），属于 **search** 桶；而 `getCoreQuota` 只读 `resources.core`（`src/github.ts:274-290`），core 是**非搜索**的独立桶。官方：core 匿名 60/小时、认证 5000/小时；**search 匿名 10/分钟、认证 30/分钟**（Search code 10/分钟），`x-ratelimit-*` 响应头是权威值。见 [rate-limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、[rate-limit](https://docs.github.com/en/rest/rate-limit/rate-limit)。

原判据「用 core 剩余守卫 search 探针」因此**双向失效**：core 尚足而 search 已空时守卫仍放行（探针 403）；core 不足而 search 充足时错误跳过诊断。

**决策：保留探针（诊断价值真实），但在匿名且 search 配额紧张时跳过。**
- **core 继续保护源码读取**（这一条不变）。
- **探针守卫改看 search 响应头** `x-ratelimit-remaining` / `x-ratelimit-reset`（**无需新增请求**——响应头本来就在 `src/github.ts:728-729` 被读）。
- 判据：拟执行探针数 + 重试预留 + 安全余量 > search 剩余额 → 跳过，并在输出里说明跳过原因（诚实性：读者知道这轮没有逐词诊断）。
- **配额未知时明确标注未知**，不假设充足。
- **认证不等于 search 享 5000/小时**——那条推导一并作废。

### 4.4 不硬编码模型 id
从 `agentDefaultModel.currentSelection()` 读，代价是多一个可选服务依赖与一条降级路径；换来插件在换模型/换 provider 的宿主上不会静默用错模型。

### 4.5 自动选择器：从 Tauri 样本适配改为通用核心定位（2026-10-15 复审）

前身 `src/select.ts` 是在 Tauri 笔记应用样本上调出来的：`:148-151` 无条件排除 `android/ios/macos/linux/appx` 与 `scripts/tools/examples/...`，`:415-426` 按 README / web / native / manifest 四个固定槽填。实测（只读调用前身现有 `lib/select.js`）：

| 输入树 | 前身选中 | 问题 |
|---|---|---|
| Android（README + build.gradle.kts + `android/app/src/main/java/{App,Service}.java`） | 仅 README + Gradle | **零 Java 源码证据** |
| Python CLI（README + package.json + `scripts/{main,tool}.py`） | 仅 README + package.json | **零 Python 源码证据** |
| Tauri 对照 | README + `src/main.ts` + `src-tauri/src/lib.rs` + package.json | 正常（样本内） |

而 R1 承诺 `select.ts`「无改动移植」，用户提的却是**任意 idea**。修法（**预算不变**：4 槽 / 6 请求 / 4500ms）：

1. **软排除**：把 `:148-151` 的无条件排除改为**减分**而非删除——先过滤掉的文件在后续找不到核心时仍可被选回（`:245-260` 现在一过滤就再也找不回）。
2. **零源码 fallback**：四槽填完后若**没有任何源码文件**（只有 manifest / README），补一个源码槽，从剩余候选里按扩展名优先级取。
3. **按仓库布局填槽而非强分 web/native**：`:436-443` 的 `isEntryPoint` 扩展集含 `ts/js/rs/go/py` 却**不含 `java`/`cs`**（尽管 native 集合包含它们）——补齐语言集合。
4. 保持既有 `files` override 语义不变（调用方显式指定路径时行为不动）。

**这是 design「无改动移植」的显式例外**，理由：选择器决定 inspect 有没有源码证据，而「证据可信」是本插件的立身之本。作为对照，`design.md §1.2` 的移植改动列已标注 `select.ts` 为「软排除 + 零源码 fallback」。

**回归证据（§3.6）**：Android / Python CLI / Tauri 三棵树都断言「至少一个源码文件入选」。

## 5. 运维与回滚

### 5.1 加载验证的三条硬约束（已实测）

| 路径 | 结果 |
|---|---|
| `dsh --profile desktop --dump-config` | `error: profile "desktop" is managed exclusively by the Electron application`（exit 1） |
| `dsh plugin --profile desktop list` | `EPERM ... open 'C:\Users\<user>\.dsh\profiles\desktop\package.json.lock'`（沙箱 Low 完整性，profile 目录无 Low 标签 ⇒ 不可写） |
| 直接改 profile `package.json` | **本会话唯一可用路径**（宿主 write/edit 工具） |

### 5.2 克隆 profile 无头验证（动 live 之前）

profile 排除 `node_modules` 后仅 0.99 MB，克隆成本极低。流程：克隆 desktop profile → 建 `node_modules` junction → `ELECTRON_RUN_AS_NODE=1` 跑 `resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js --profile <克隆> --no-open --port 0` → **判成功看 stderr 有无** `did not activate` / `AggregateError` / `has no create() factory` / `skipping profile bundle`。

### 5.3 回滚点

| 操作 | 回滚 |
|---|---|
| find-ideas 源码改动 | `git revert` / `git checkout`（本仓库 git 干净，1 个 commit） |
| live profile 两行改动 | 恢复 `package.json` 备份（`.bak-shop-20260929-133401`、`.bak-v054`），或删掉 `dependencies` + `bundles` 两处条目 |
| idea-scout 悬空依赖移除 | 恢复那一行 `file:` 依赖 |
| 构建产物 | `lib/` 是构建产物，**绝不手改**；重建即 `npm run build` |

### 5.4 工具链风险

- **devDependencies 全部可从公共 registry 解析（已实测）**：`@deepseek-ai/dsh-tools` 33 个版本且**含 `0.2.0-rc.2`**；`@deepseek-ai/cordis` latest `4.0.4`；`semver` `7.8.5`；`typescript` `7.0.2`；`@types/node` `26.6.5`。
- **⚠️ 必须钉死版本，不能依赖 `latest`**：`@deepseek-ai/dsh-tools` 的 `dist-tags.latest` 指向 **`0.0.1-rc.1`**（远早于 0.2.x 线）。用 `npm install @deepseek-ai/dsh-tools` 会装到那条旧线并静默失配宿主 API。devDependencies 写**精确版本**（`@deepseek-ai/dsh-tools: 0.2.0-rc.2`、`@deepseek-ai/cordis: 4.0.4`），与 idea-scout 的既有写法一致。
- 回退方案（若 install 仍出问题）：复用 `work_space2\dsh-idea-scout\node_modules`（已含 cordis 4.0.4 / dsh-tools 0.2.0-rc.2 / typescript 5.9.3 / @types/node / semver）。
- **PowerShell 网络 cmdlet 不可用**（TLS 栈报「基础连接已经关闭」）：查 registry 一律用 node fetch，不要用 `Invoke-WebRequest`。
- **本仓库工作区已修好 ACL**（Low 完整性标签已 `icacls /setintegritylevel /T` 施加到全树），沙箱内 python/git/node 均可写；`C:\Users\<user>\.dsh\profiles\**` **仍不可写**（无 Low 标签）。
