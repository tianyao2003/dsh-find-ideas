# dsh-find-ideas v0.1 — GitHub 先例检索 + 骨架提取插件

## Goal

把「用户提出一个中文 idea → 自动检索 GitHub 上最接近的开源先例 → 用户挑选 → 提取代码骨架 → 产出架构方案」这条流水线封装成一个 DSH host 插件。

用户价值：在动手造轮子之前，先知道轮子存不存在、长什么样。插件承担**确定性工作**（翻译之外的检索、过滤、打分、抓取、渲染全是写死的流水线），主 Agent 只负责它擅长的**总结**（翻译由插件自己做，见 R2——本节原文写「翻译和总结」，与 R2 及 `src/index.ts:337-345` 的实际分工不一致，2026-10-15 复审已改正）。这样既不把整个 GitHub 仓库喂进上下文（省 token、不被冗余代码带偏），也让主 Agent 只需「点菜」。

**范围裁定（用户 m00294a）**：find-ideas 不是重写 idea-scout，而是**只做 idea-scout 明确没做的四件事**（见下「四个差异化能力」）。**复用方式裁定（用户 m00522）**：把 idea-scout 已验证的模块**移植进本仓库**，本仓库成为独立可发布包，idea-scout 作为前身退休。

## Background — 已确认事实

### 本仓库（dsh-find-ideas）当前状态

- `D:\workspace\dsh-find-ideas` 顶层只有 `.agents/`、`.dsh/`、`.git/`、`.trellis/`、`.gitattributes`、`AGENTS.md`。**没有 package.json、没有 src、没有 README**——代码尚未开始，是绿地。
- git 仓库存在，1 个 commit `b6e2c72 chore: trellis init (dsh platform, developer Tianyao2003)`，**无 remote**，当前分支 `master`。
- Trellis 已装好并可用：`.trellis/`（scripts/spec/workflow.md/config.yaml）、`.agents/skills/trellis-*/`、`.dsh/skills/trellis-*/`。
- DSH 在 `.trellis/workflow.md` 里被归入 `[codex-inline, Kilo, Antigravity, Devin, DeepSeek Harness]` 组：**inline 工作流**，不分派 implement/check 子代理，Phase 1.3（配置上下文）跳过，因此 `implement.jsonl` / `check.jsonl` 的 ready gate **不适用**；Phase 1.2 的研究在主线做完并写入 `{TASK_DIR}/research/`。

### 前身 dsh-idea-scout 的状态（移植源）

- 位置 `D:\workspace\work_space2\dsh-idea-scout`，**是用户自己写的插件**（m00388b），MIT，`version: 0.1.0`，`author: tianyao2003`，`engines.node >=22`，`npm view dsh-idea-scout` 返回 **404（未发布到 npm）**。
- 三个工具按顺序调用：`scout_projects`（`src/index.ts:501`）、`rank_candidates`（`src/index.ts:834`）、`inspect_projects`（`src/index.ts:1086`）。入口形状 `src/index.ts:44 export const name` / `:45 export const inject = ['tools']` / `:499 export function apply`。
- 打分公式 `relevance × (1 + log10(max(stars, 10) + 1)) / 2`，**排序与星级全在代码里算，agent 只能提供 `full_name` 和 0–10 的 relevance**（公式注释 `src/types.ts:106`）。
- 候选池跑三查询计划（anchor / precise / tail）以覆盖长尾，避免按 star 降序截断把小仓库挤出去。
- 限流/降级契约：任何一次搜索失败都不让工具调用失败，而是返回部分结果 + `degraded: { reason, detail }`；`plan_failed` 是其中之一（`src/index.ts:658, :681`）。
- 依赖声明：`@deepseek-ai/cordis ^4.0.1` 与 `@deepseek-ai/dsh-tools`（range 覆盖到 `^0.2.0-rc.1`）都是 **peerDependencies**——`dsh-tools` 由内核运行时提供，写进 `dependencies` 会装出第二份导致上下文割裂。
- `exports` map 只暴露 `"."` → `lib/index.js`，外加 `./cordis.patch.yml` 与 `./package.json`。**内部模块（`types.ts` / `query.ts` / `select.ts` / `github.ts` 等）当前不可作为子路径 import。**
- 20 个 commit，最新 `e4dfccf docs: rewrite the README as an entry page, add a Chinese mirror`。
- **⚠️ 工作区有 1857 行未提交改动在飞**：12 个文件已修改（README.md、README.zh.md、docs/DESIGN.md、src/{github,index,query,render,types}.ts、test/{baseline,plan-failure,ranking,replay}.test.mjs）+ 1 个未跟踪新文件 `test/bilingual-routing.test.mjs`。内容主题是**双语路由**与**噪声/可疑度报告**（新增 `TERM_TOTAL_UNKNOWN`、`TermReport`、`NoiseReport`、`Suspicion`、`findSuspicious`、`similarity`、`findScoreGaps`、`findDoubleSided`、`findNoteEchoes`、`termReport`，`SEARCH_PLAN_VERSION` 升到 7）。
- **这 1857 行在飞改动不是全绿**：`node test/run-all.test.mjs` → `10/12 test files passed`，exit=1。聚合运行器 `test/run-all.test.mjs:36` 用 `spawnSync(..., { stdio: 'inherit' })` **每个测试文件一个独立进程**，所以两处失败与文件间状态泄漏无关，是真实的断言失败，且**都在未提交的改动里**：
  - `test/ranking.test.mjs:175` 断言 `rank_candidates` 的参数键集合为 `['candidates','idea','keywords','limit','scores']`，实际为 `["idea","candidates","scores","keywords","pool_source","limit"]`。该断言自己的注释（`test/ranking.test.mjs:170-174`）记录了 B2/B4 加 `keywords` 时更新过它，但后来加入的 `pool_source`（`src/index.ts:924` 声明、`src/index.ts:1079` 读 `args.pool_source?.trim() ?? ''`）**没有同步进期望值**。断言的**主体**（「排序器不接受任何计算字段，`stars` / `stars_rating` 不得回流」）仍然成立——`pool_source` 是调用方提供的来源声明字符串，不是计算字段。→ **陈旧测试**，改一个词即可。
  - `test/bilingual-routing.test.mjs:144` 抛 `AssertionError: the tool issues the exact new query order`。**根因已实测定位（探针 `.probe-br.mjs`）：该断言已陈旧，规划器与工具都没错。** 实测：`planQueries()` 产出的 3 条计划与工具**最先发出的 3 次调用完全一致**（`blockchain explorer`/stars → `一个区块链浏览器 支持多链查询和交易追踪`/stars → `blockchain explorer multi-chain`/updated），但工具随后**又发了 3 次调用**（`支持多链查询和交易追踪`、`multi-chain`、`blockchain`，均 sort=stars）——这是 B6 新增的**逐词独立命中数探针**（`src/github.ts:774 MAX_TERM_PROBES = 3` + `src/github.ts:789 probeTermTotals()`，由 `src/index.ts:756 termReport(queries, termTotals)` 消费，用途是让「某个检索词其实毫无约束力」在卡片上可见）。断言用 `assert.deepEqual(calls, ...)` 比对**全部**调用，故多出的 3 次探针使其失败；同文件 `:151` 的 `check('replay makes no further search requests', calls.length, 3)` 同样会失败，只是断言在前者先抛。→ **陈旧测试**，修法是把断言限定在计划调用上（或把期望值更新为 6 次并新增「探针不参与排序」的断言）。
  - **附带发现（影响 R1 的请求预算）**：该探针把每次搜索的**请求数从 3 次翻倍到 6 次**。匿名模式下 GitHub 配额仅 60 次/小时，这意味着每小时可做的检索次数减半。移植时应保留这个诊断能力（它是 B6 的真实价值），但**在匿名且配额紧张时跳过探针**，而不是无条件花费一半配额。
- **`lib/` 不是陈旧构建**：`src` 与 `lib` 的 mtime 同为 `10-14 15:25`，且关键 token 计数一一对应（`index`：`pool_source` 5 / `keywords` 37 / `pushed_at` 3，两侧相同）。测试跑的 `lib/*.js` 确实反映了当前 `src`。
- **移植基线 = 工作区状态，不是 HEAD**（provenance 见「技术注记」）。双语路由正是修复 CJK 语言域不匹配这个 P0 的成果；退回 HEAD 等于让新版比现状更差。

### 四个差异化能力的证据（用户 m00294 裁定 find-ideas 只做 idea-scout 明确没做的四件事）

| # | 能力 | 证据 |
|---|---|---|
| 1 | **Markdown 表格输出** | `src/render.ts` 里 grep 表格分隔行（`\| ---` / 行首 `\|`）**零命中**；`renderCandidates`（`src/render.ts:89`）与 `renderRanked`（`src/render.ts:218`）用的是逐行卡片。 |
| 2 | **更新时间列** | **数据已采集但从不展示**：`src/github.ts:423 pushed_at: String(item.pushed_at ?? '')`；schema 三处 `src/index.ts:563, :886, :958 pushed_at: { type: 'string', required: true }`；类型 `src/types.ts:26, :192` 与透传 `src/types.ts:716`。而渲染处 `src/render.ts:108` 与 `src/render.ts:258` 的 `const bits = [formatStars(...), language \|\| '未知语言']` **从不输出 pushed_at**。→ 零采集成本的纯展示缺口。 |
| 3 | **类/函数签名骨架提取** | 在 `src/` 全目录 grep `signature\|exported\|symbol\|skeleton\|骨架` 只有 4 处无关命中（注释 + `src/select.ts:22` 的 `MANIFEST_RE`）。**idea-scout 只抓 manifest 文件（package.json / requirements.txt / go.mod 等），不做类/函数签名提取。** |
| 4 | **插件内 LLM 翻译** | idea-scout 明确选择**不**自调模型：`docs/DESIGN.md §6.2.1` 原文「不新增请求通道，预算仍最多三条；不扩大或移除 97 条词表，**也不在插件内调用模型翻译**。调用工具的 agent 应先提炼核心概念，再通过 `keywords` 提供英文检索词。」中文 idea + `keywords` 无拉丁字母时直接拒绝（`src/index.ts:537` 附近，返回 `plan_failed`）。 |

### 插件内调 LLM 的技术可行性（已验证，用户 m00294b 裁定走这条路）

- API：`ctx.llm.stream(options)` 返回 **AsyncIterable**（不是 Promise），`for await` 消费，累加 `type === 'text-delta'` 的 `chunk.text`。
- `options` 形状（真实调用点 `dsh-deepread/lib/types/host/llm.js:155-190`）：`{ provider, model, system, messages: [{ role:'user', content:[{ type:'text', text }] }], temperature, maxTokens }`。`system` 是**顶层字符串**，与 messages 分离。
- **`provider` 与 `model` 永远必填，没有「继承会话」的默认值**；但可以显式读会话模型：`ctx.get('agentDefaultModel').currentSelection()` → `{ provider, model, reasoningEffort }`。本机该服务把模型固定为 `{provider: workbuddy-ai, model: deepseek-v4.1-flash, reasoningEffort: max}`。
- **陷阱**：Cordis 下未在 `inject` 声明就读 `ctx.llm` 会抛 `cannot get property without inject`；**必须用 `ctx.get('llm')`**（安全返回 `undefined`）。把 `'llm'` 写进 `inject` 会把插件加载门槛绑死在 LLM 服务上——LLM 只是锦上添花时应使用 `ctx.get`。
- 未确认：没有任何第一方类型定义（不存在 `@deepseek-ai/dsh-llm` 包），所有签名都是第三方再声明或 duck-typing 探测；但 deepread / vision-router / dsh-memory / cost-meter 四个独立插件一致，置信度高。

### 宿主环境与加载事实

- **本会话跑在 desktop profile 上**（实测环境变量：`DSH_PROFILE=desktop`、`DSH_PROFILE_DIR=C:\Users\<user>\.dsh\profiles\desktop`、`DSH_HOME=C:\Users\<user>\.dsh`）。即本插件的真实加载目标是 desktop profile。宿主 `desktopVersion = 0.2.0-rc.2`（`resources\runtime\primary-runtime\runtime.json`）。
- **desktop profile** 装了 26 个 bundle（含 `dsh-find-plugin`、`dsh-deepread`、`dsh-vision-router`、`dsh-mcp-connector` 等）。`dsh-idea-scout` 以 `file:` junction 挂在 desktop profile 的 `node_modules` 里，**但不在 `dsh.profile.bundles` 数组中，`cordis.patch.yml` 里也没有对应插入项** → 装了依赖但未激活。
- （旁证）`web` profile 的 `dsh.profile.bundles` 只有 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，`dependencies` 为空——本任务不以它为加载目标。
- **装插件 = 同时加 `dependencies` 和 `dsh.profile.bundles` 两项，缺一不生效。**（`dsh-plugin-shop` 的 `confirmBundleActivation` 佐证：只有 `bundles.includes(name) && Object.hasOwn(dependencies, name)` 才算成功。）
- **CLI 路径的三条硬约束（已实测）**：① `dsh --profile desktop --dump-config` → `error: profile "desktop" is managed exclusively by the Electron application`（exit 1），**dump-config 这条路对本任务的验证无效**；② `dsh plugin --profile desktop list` → `EPERM ... open 'C:\Users\<user>\.dsh\profiles\desktop\package.json.lock'`（沙箱是 Low 完整性令牌，profile 目录无 Low 标签 ⇒ 不可写）；③ 因此本会话内**改 profile 只能用宿主 `write`/`edit` 工具**，或在提权后重试 CLI。

## Requirements

- **R1 — 复用已验证的确定性内核（用户 m00522 裁定：移植进本仓库）。** find-ideas 的检索/池化/打分/降级行为必须与 idea-scout 已验证的行为一致，而不是重新发明：三查询长尾计划、`relevance × (1 + log10(max(stars, 10) + 1)) / 2` 代码内打分、`degraded` 降级契约、`pushed_at` 采集、`ctx.get('credentials').resolve('GITHUB_TOKEN')` 取 token 与匿名降级。
  - **移植对象是九个模块**：`github` / `query` / `select` / `types` / `cache` / `credentials` / `render` **+ `lexicon`（97 条词表兜底种子）+ `index`（三工具编排）**。九个模块全部成为本仓库自己的源码；本仓库是**独立可发布包**，idea-scout 作为前身退休。不采用「依赖 dsh-idea-scout」（它未发布 npm 且 `exports` 只暴露 `"."`），也不采用「就地演进 idea-scout 为 v0.2.0」（本仓库会空转）。
  - **移植基线 = 工作区状态，不是 HEAD**（理由与 provenance 哈希见「技术注记」）。移植前必须核对哈希；不匹配则停下问用户，不盲移植。
  - **随移植带入的两处红灯都是陈旧测试，不是行为缺陷（已实测定位，见 Background），移植时必须同步修正期望值。** `test/ranking.test.mjs:175`（期望值漏了 `pool_source`，**修法是把 `pool_source` 加进期望数组，不放宽成子串测试**）与 `test/bilingual-routing.test.mjs:144`（`assert.deepEqual` 比对了全部 fetch 调用，未排除 B6 新增的 3 次逐词探针，**修法是把断言限定在计划调用上并新增「探针不参与排序」的断言**，同文件 `:151` 的 `calls.length === 3` 同步处理）都不得带进新仓库——R7 与 AC7 要求测试全绿，**一个自带红灯的新仓库会立刻失去「证据可信」这个立身之本**。
  - **公开面不变（用户 m00636 裁定）**：沿用 idea-scout 的同一套工具名与参数形状——`scout_projects` / `rank_candidates` / `inspect_projects` 三者的名字与参数键保持不变。继任者必须能被旧的调用方式直接使用；因此 `test/ranking.test.mjs:165-169`（三工具已注册）与 `test/bilingual-routing.test.mjs` 的 `defs.get('scout_projects')` 等既有断言在移植后应当**继续成立**，而不是被改名连带改掉。**变的只有插件身份**（包名 / `export const name` / bundle 层 id：`dsh-idea-scout` → `dsh-find-ideas`）。工具名冲突的正解是让前身退休，而不是给继任者改名。
  - **前身退休与启用范围（用户 m00688 裁定 B）**：**先在克隆 profile 上做无头验证**（profile 排除 `node_modules` 后仅 0.99 MB，克隆成本极低），**验证通过后**才装进 live desktop profile，并**同时移除 idea-scout 的悬空 `file:` 依赖**。理由：idea-scout 当前本来就没进 `bundles`、未激活，移除只是清理一个悬空链接，不改变现有行为；回退也只是恢复两行。**绝不让两者同时激活**——工具名相同，会冲突。
  - **「已验证内核」的诚实边界（2026-10-15 复审）**：移植源的主路径已验证，但以下五条性质**未**被验证，且全部是证据可信问题，因此**本次移植就地修复**，不留给后续任务（对应 AC11）：
    - **融合排序未生效**：`src/github.ts:937-946` 累积 RRF 分数，`src/github.ts:961` 却按 `[...quota, ...fused.keys()]` 插入顺序取余席。复现（全 200★、limit 5）：跨两通道的 `x` RRF `0.03149801587301587` > 单通道 `a2` `0.015873015873015872`，`x` 仍被漏掉。修法：**保留 quota 席，余席按 RRF 分数排序**。
    - **候选身份两套视图**：`src/types.ts:673-694` 按 lowercase 建 Map 却遍历原始 `candidates`（同仓传两次→两行）；`src/types.ts:683-684` 排名 last-score-wins 而 `src/types.ts:501-514` `findScoreGaps` first-score-wins（两项最终都是 9 分，却仍报 1/9 的冲突）。修法：排序与全部诊断共用同一个 lowercase `full_name` 视图与同一份有效评分。
    - **缓存把部分批次回放成完整成功**：`src/index.ts:1258-1276` 的配额拒绝在 cache 查询**之前**；`src/index.ts:1366-1377` `cacheSet` 只存 inspections、`failures`/`degraded` 之后才生成；`src/index.ts:1327` 命中直接返回 `degraded: null`。场景：读第 1 个仓库成功、第 2 个被限流 → 缓存只含 1 个 → 再查同样的 2 个仓库时**看起来是完整成功**。修法：缓存记录 requestedRepos / failedRepos / completeness / fetchedAt / 各文件错误，命中重建「部分证据」而非完整成功。
    - **重复读 README + 多级截断无标记**：`src/index.ts:416` 已用专用接口读 README，`src/select.ts:468` 又把它选进第一槽经 contents **重读**（shallow 6 次请求里 1 次纯浪费）；`src/index.ts:463` 的 `file.text.slice(0, 1200)` 二次截断**完全未标记**，而 R5 的扫描器正搭在这个窗口上。修法：复用已读 README 填第一槽；tree / API / file / excerpt / render 五级截断逐级标记。
    - **自动选择器不是通用核心定位器**：`src/select.ts:148-151` 无条件排除 android/ios/macos/linux 与 scripts/tools/examples 等，`src/select.ts:415-426` 按 README/web/native/manifest 强分槽。实测（只读调用前身现有 `lib/select.js`）：Android 树（README + build.gradle.kts + 2 个 Java）只选中 README + Gradle；Python CLI 树（README + package.json + scripts/*.py）只选中 README + package.json；Tauri 对照正常选满 4 槽。修法：**软排除 + 零源码 fallback + 按仓库布局而非强 web/native 填槽**，`files` override 与 4 槽 / 6 请求 / 4500ms 预算不变。详见 `design.md §4.5`。
- **R2 — 插件内 LLM 翻译（本插件独有的职责）。** 非英文 idea 由插件自己调 LLM 提炼英文检索词，而不是把翻译责任推给调用方 agent。必须：用 `ctx.get('llm')`（可选依赖，缺失时降级为「要求调用方提供 keywords」而不是插件加载失败）；模型从 `ctx.get('agentDefaultModel').currentSelection()` 读，不在 config 里硬编码模型 id；对 LLM 输出做**校验与兜底**（返回的检索词必须含拉丁字母、条数与长度有界、CJK-only 视为非法）；LLM 不可用/超时/输出非法时**不得让工具调用失败**，而是回落到 idea-scout 的既有路径并在 `degraded.detail` 里说明**为什么**降级（比今天的裸拒绝更有信息量）。**调用顺序决策**：idea 已含拉丁字母、或调用方已提供含拉丁字母的 keywords → **不调 LLM**（零新增延迟与配额），调用方给的词优先于模型生成的词。
  - **混合 Han+Latin 的接线规则（2026-10-15 复审发现的自相矛盾）**：「idea 含拉丁字母 → 不调 LLM」这条裁定与前身守卫**直接冲突**：`src/index.ts:337-345` 判的是「任何汉字 **且** keywords 无拉丁字母」就拒绝，调用点 `src/index.ts:656-659`。实测输入 `本地优先的 Markdown 笔记应用，支持双向链接`（不给 keywords）→ 按裁定跳过翻译 → 落到旧守卫 → **仍然 `plan_failed`**，即 AC1 在混合输入上不成立。修法（不改「含拉丁不翻译」这条裁定）：**跳过翻译 ≠ 继续走旧拒绝分支**——为「跳过翻译」的输入构造确定性的规划器上下文（或给新编排一个「已通过」分支标识），不让它重新进入为「纯中文且无英文词」设计的旧守卫。测试必须覆盖四分支：纯中文 / 混合 Han+Latin / 纯英文 / 调用方已给 keywords。
  - **检索词预算必须诚实（2026-10-15 复审）**：翻译产出的词**不会全部进入查询**。规划器固定只吃 `latinSeed.slice(0, 2)`（宽查询）与 `latinSeed.slice(0, 3)`（长尾），中文通道用 **idea 的前两段**而不是翻译结果（`src/query.ts:555-579`）。实测：`blockchain explorer multi-chain transaction tracing` 与 `blockchain explorer multi-chain social feed` 得到**完全相同的三条查询**——「交易追踪」这个关键约束凭空消失。修法（零新机制）：① 翻译契约改为**至多 3 个词、按重要性排序**（前 2 词=领域核心、第 3 词=最关键能力/限定符），prompt 里写明这个预算；② 工具输出**报告实际进入查询的词与被丢弃的后缀**，让「翻译成功但关键约束没进检索」可见。
- **R3 — Markdown 表格输出（用户 m00624 裁定：表格替换逐行卡片）。** `rank_candidates` 的主渲染改为 Markdown 表格，表头至少覆盖用户 m00079 指定的七列：项目链接、最近更新时间、relevance 分数、stars 数、公式打分、开发语言、一句话简介。实现约束：
  - **替换而非并存**：`src/render.ts:218 renderRanked` 的逐行卡片被表格取代，不并行渲染两份——并存会让每次排序输出 token 翻倍，与本插件「省 token」的核心卖点相悖；也不加 `format` 参数（多一条分支就多一倍渲染测试面，且主 Agent 可能选错）。
  - **诚实性区块原样保留在表格下方**：排除统计（relevance=0 噪声 / relevance<`MIN_RELEVANCE` 弱相关 / 未匹配 `full_name`）、`noiseAdvice()` 评分分布告警、`【调用方说明区】`（调用方提供的文字，明确标注未经工具验证、不参与排序与评分）、`degraded` 提示，以及「排序与星级均由代码按公式计算，不可由模型指定」的声明（`src/render.ts:269`），全部保留。
  - **必须保住的结构性隔离**：现有卡片把「代码计算区」（`src/render.ts:255`）与「调用方说明区」（`src/render.ts:282`）分开渲染，这是防「模型自报数据」的核心设计（设计说明见 `src/render.ts:195-196` 与 `:200-206`）；表格不得把两类信息拉平到同一区域。
  - 简介列复用已有的 `src/render.ts:49 clipDescription` 做截断，避免撑破表格对齐。
  - **表格转义是替换渲染器引入的新风险**：`full_name` 与 `description` 来自 GitHub（adversarial 输入），其中的 `|` 会撕裂单元格，必须转义。`clipDescription` 已折叠空白，但不处理竖线。
  - **`note` 必须真正透传（2026-10-15 复审发现的断链）**：`note` 能让一致性检查认为「这个评分有理由」（`src/index.ts:900-913`），但 `rankCandidates` 构造结果时不透传它（`src/types.ts:707-725`），输出 schema 也没有它（`src/index.ts:943-967`），而渲染器却从 `row.note` 读（`src/render.ts:279-305`）→ **【调用方说明区】永远为空**。R3 承诺「诚实性区块原样保留」，实际保留的是一个空区块。修法：按与 relevance 相同的有效判决透传 `note` 并在 schema 声明，只在表格之外、标 `[未验证]`；测试必须是 execute→render 端到端，不能只手工构造行测渲染器。
  - **表格声明必须分成三类（2026-10-15 复审）**：`design.md §2.3` 的「以下每个数字均由代码算出，调用方不能指定或改动」**超出实现边界**。实测：传 `stars=99999`、`pushed_at=2099-01-01`、`pool_source=scout_projects`，工具照常出表、无任何告警（`src/index.ts:869-929` 接受完整自带候选、`src/index.ts:924-929` 的 `pool_source` 不校验、`src/index.ts:1034-1079` 直接使用）。准确表述分三类：**relevance = 调用方判断；stars / pushed_at / description = 传入元数据（来源声明未校验）；score / 评级 / 顺序 = 代码派生**。算术可复算 ≠ 输入是真的；工具不报警 ≠ 已核实。
- **R4 — 更新时间列。** 表格必须输出 `pushed_at`（数据已在 `src/github.ts:423` 采集、`src/types.ts:26, :192, :716` 透传，只是从未渲染）；**空值渲染明确占位（`—`），绝不渲染 `undefined`**——表格里 `undefined` 会同时污染可信度与列对齐。
- **R5 — 类/函数签名骨架提取（用户 m00612 裁定：有界启发式扫描器，零新依赖）。** `inspect_projects` 必须能在用户选中的仓库上提取**类/函数签名级骨架**（而非只列 manifest 文件名），并整理成 Markdown 交给主 Agent。实现约束：
  - **不新增任何依赖**（`dependencies` 必须为空）。本机实测无 tree-sitter / acorn / oxc-parser / @swc / ts-morph；唯一的解析资产 TypeScript 5.9.3（22.5 MB）在 idea-scout 里只是 devDependency，升为运行时依赖只惠及 TS/JS 两种语言，不划算。多语言精确解析被明确排除（否决理由见「技术注记」）。
  - **搭在已有地基上**：`src/select.ts:138 SOURCE_EXT_RE`（已枚举 30+ 源码扩展名）、`src/select.ts:235 pickArchitectureFiles()`（已做「哪些文件值得读」排序）、`src/index.ts:470 treeEvidence()`（已示范「统计 + 截断标记」）。
  - **在既有预算内工作**：`src/index.ts:184-185` 的 `INSPECT_BUDGET`（shallow 每仓库 4 文件 / 6 请求 / 4500ms）不变，签名扫描**只在已有的 1200 字符摘录窗口内**（`src/index.ts:463` `file.text.slice(0, 1200)`）进行，不新增请求。
  - **诚实标注**：输出必须声明这是启发式提取、摘录可能被截断、可能漏项，沿用 idea-scout「截断即标注、缺失不等于不存在」的既有模式。输出至少含：文件路径、类名、方法/函数名与签名。
  - **必须诚实命名为「局部声明证据」而非「架构骨架」（2026-10-15 复审）**：`src/index.ts:450-463` 是先读 4000/12000 字符再 `file.text.slice(0, 1200)`，所以 **1200 字符是文件头**——版权头 + import 就能吃满整个窗口，而类/函数主体通常在文件头之外；且这次二次截断在 `src/index.ts:463` **完全未标记**。签名也不能证明依赖方向、调用链、持久化边界或进程边界。因此：① 输出必须声明「这是文件头局部声明证据，不是完整架构」；② `SignatureHit` 补 `startLine` / `excerptChars` / `truncated` / `supported` 字段；③ **零命中不得读成「该仓库没有类/函数」**；④ 拓扑结论只在摘录内出现 import / 调用 / 接口等直接证据时才允许输出；⑤ 保留已有 `tree.sha` / `blob.sha`，但 **tree SHA ≠ commit SHA**，不得冒充 `blob/<commitSHA>/path#Lx-Ly`。
- **R6 — 降级与诚实性契约（继承 idea-scout 的既有不变量）。** 任何单点失败都不得让工具调用整体失败；返回部分结果 + `degraded: { reason, detail }`；**在做请求之前**就拒绝会超出剩余配额的源码读取，而不是返回看起来完整的截断结果。**逐词探针的配额守卫（2026-10-15 复审修正了资源桶）**：探针调的是 `/search/repositories`（`src/github.ts:812`），属于 **search** 资源桶；而 `getCoreQuota` 只读 `resources.core`（`src/github.ts:274-290`），core 是**非搜索**的独立桶（官方：[rate-limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)、[rate-limit](https://docs.github.com/en/rest/rate-limit/rate-limit)）。所以原判据「用 core 剩余守卫 search 探针」会**双向失效**：core 尚足而 search 已空时守卫仍放行；core 不足而 search 充足时错误跳过诊断。**core 继续保护源码读取；探针守卫改看 search 响应头 `x-ratelimit-remaining` / `x-ratelimit-reset`**（无需新增请求），按「拟执行探针数 + 重试预留 + 安全余量」判定，配额未知时明确标注未知。**「匿名 20→10 次/小时」与「有 token 即 5000/小时」这两条推导作废**：匿名 search 是 10 次/分钟、认证 30 次/分钟，与 core 的 60/5000 每小时是两笔账；认证也不等于搜索享 5000/小时。「每次检索 3→6 次请求」这个**事实**仍然成立。
- **R7 — 工程基线。** TypeScript strict（`strict` + `noImplicitOverride` + `noUncheckedIndexedAccess`）；`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools` 写 peerDependencies 而非 dependencies（**且 devDependencies 钉死精确版本，见「技术注记」的 latest 陷阱**）；纯 Host 半边（只通过 `output.render` 渲染，不写 client.js、不碰 typert 契约）；**`inject` 只声明 `'tools'`**（`llm` / `credentials` / `agentDefaultModel` 一律走 `ctx.get`，否则插件会因缺服务而整体加载失败）；测试只针对纯函数、**必须校验已编译产物**（`def.parameters` / `def.output.schema` 已是 JSON Schema，不可再过作者态编译器）。

## Acceptance Criteria

- [ ] **AC1** 给定一个纯中文 idea 且不提供 `keywords`，插件自己产出英文检索词并完成检索（对照：idea-scout 在同样输入下返回 `plan_failed` 拒绝执行）。
- [ ] **AC2** LLM 服务不可用（`ctx.get('llm')` 为 `undefined`）时，插件仍能加载并执行，返回部分结果 + `degraded.detail` 说明翻译不可用；**不抛异常、不拒绝加载**。
- [ ] **AC3** `rank_candidates` 输出的 Markdown 表格为**八列**（`#` 序号 + 链接、更新时间、relevance、stars、公式打分、语言、简介七个内容列）；**代码计算区声明按三类措辞**（relevance=调用方判断 / stars·pushed_at·description=传入元数据未校验 / 得分·评级·顺序=代码派生可复算），不得再声称「每个数字都由代码算出、调用方不能指定」；诚实性区块（排除统计、噪声告警、调用方说明区、`degraded` 提示）仍渲染在表格下方，两类信息未被拉平到同一区域。
- [ ] **AC4** 表格中的更新时间来自真实 `pushed_at`，空值有明确占位而不是渲染成 `undefined`。
- [ ] **AC5** 对用户选中的仓库，`inspect_projects` 返回类/函数签名级骨架（至少含：文件路径、类名、方法/函数名与签名），并渲染成 Markdown；输出声明这是启发式提取且可能漏项。
- [ ] **AC6** 检索失败 / 限流 / 配额不足时，工具返回结构化 `degraded` 而不是抛错；配额不足时**在发请求前**拒绝越界的源码读取；匿名且配额紧张时逐词探针被跳过且输出说明原因。
- [ ] **AC7** `tsc --noEmit` 与项目测试全绿（含 `test/source-integrity.test.mjs` 这个源码文本守门人）；测试断言针对 `lib/` 已编译产物。**复核红灯必须直接跑 `node test/<file>`（不带 `--test`）**——本项目测试自己打印 `FAIL`/`PASS`，`node --test` 的过滤会给出假阴性。
- [ ] **AC8** 插件可通过「`dependencies` + `dsh.profile.bundles` 双项」在 desktop profile 上加载，且不因缺少 `llm` / `credentials` / `agentDefaultModel` 而加载失败；**验证先在克隆 profile 上做无头验证**（判成功看 stderr 有无 `did not activate` / `AggregateError` / `has no create() factory` / `skipping profile bundle`），通过后才动 live profile。
- [ ] **AC9**（2026-10-15 复审新增）**混合 Han+Latin idea 不再落回旧拒绝分支**：输入 `本地优先的 Markdown 笔记应用，支持双向链接`（不给 `keywords`）能完成检索，而不是 `plan_failed`；四分支（纯中文无 keywords / 混合 Han+Latin 无 keywords / 纯英文 / 调用方已给 keywords）都有测试；工具输出报告**实际进入查询的词与被丢弃的后缀**。
- [ ] **AC10**（2026-10-15 复审新增）**证据链可引用且不越界**：每条签名证据带 `path` + `startLine` + `excerptChars` + `truncated` + `supported`；输出声明这是「文件头局部声明证据，不是完整架构」且**零命中不等于该仓库没有类/函数**；所有 GitHub 正文标为「未信任来源数据」并统一转义（换行 / `|` / 反引号 / HTML）；许可证未知时显式标注；`note` 经 execute→render 端到端出现在【调用方说明区】并标 `[未验证]`。
- [ ] **AC11**（2026-10-15 复审新增）**五条继承性证据完整性缺陷就地修复并各有反例测试**（`design.md §1.4` / §3.6）：RRF 余席排序、统一候选身份视图、缓存不得洗成完整成功、README 复用与五级截断标注、选择器通用化（Android / Python CLI / Tauri 三棵树至少一个源码文件入选）。**这五条不算「修前身的 P0/P1」**——它们会原样继承进新仓库，继承的缺陷就是新仓库的缺陷。
- [ ] **AC12**（2026-10-15 复审新增）**诊断不得强于证据**：逐词探针的 solo totals 表述为基数/宽泛度启发式（不是语义约束力）；未知标「未测」、零命中标「solo 无命中」、缓存命中显示「诊断未保存」；长尾失败文案改为「长尾通道覆盖未知」；长尾指标**分别**统计候选池与最终榜的低 star 数。

## 技术注记

### 移植 provenance（2026-10-15 实测，移植前必须核对）

| 项 | 值 |
|---|---|
| HEAD | `e4dfccf63abd60aee5819b03607e84ec7eeb6ac9` |
| sha256(tracked diff) | `cb10ca2605999217bb1e5173387aec1ad1bd4c4fa69e8bcccb1a0bd85a169ed1` |
| sha256(`test/bilingual-routing.test.mjs`) | `c309ab5d16d72d0809436e6d3e26176e7dab91613b8a44be72d80e493eb07258` |
| diffstat | 12 files changed, 1857 insertions(+), 249 deletions(-) |

**若哈希不匹配 → 停下问用户**，不要盲移植：工作区状态是权威基线，不是 HEAD。

### R5 的实现选项实况（2026-10-15 实测）

- **TypeScript 编译器 API 本地已有**：`work_space2\dsh-idea-scout\node_modules\typescript` = **5.9.3**，132 个文件 / **22.5 MB**。它当前是 idea-scout 的 **devDependency**（只服务 `tsc` 构建）；若要在**运行时**用编译器 API 解析 TS/JS 签名，必须把它升为 find-ideas 的**运行时 dependency**，代价是 desktop profile 里多出 22.5 MB，且只惠及 TS/JS 两种语言 → **否决**。
- **本机没有任何多语言解析器**：在 `work_space2\dsh-idea-scout\node_modules` 与 `C:\Users\<user>\.dsh\profiles\desktop\node_modules` 两处均**未命中** `tree-sitter`、`web-tree-sitter`、`acorn`、`oxc-parser`、`@swc`、`ts-morph`、`@ast-grep`、`lezer`。→ 多语言精确解析必须新增依赖（tree-sitter 还牵涉原生模块与构建链，Windows 风险高）→ **否决**。**用户 m00612 裁定选 A（有界启发式扫描器，零新依赖）。**

### 依赖与宿主线兼容（2026-10-15 实测）

- **peer range 已覆盖宿主线**：`^0.2.0-rc.1` vs 宿主 `0.2.0-rc.2` → **satisfies: true**；`^4.0.1` vs cordis `4.0.4` → **true**。沿用 idea-scout 那条枚举到 `^0.2.0-rc.1` 的 range 即可。
- **`@deepseek-ai/dsh-tools` 由内核运行时提供**：desktop profile 的 `node_modules/@deepseek-ai` 只有 `cosmokit` + `schemastery`，`.dsh-module-fallback/node_modules` 里也没有 `@deepseek-ai` → **只能写 peerDependencies**。
- **⚠️ devDependencies 必须钉死精确版本**：registry 实测 `@deepseek-ai/dsh-tools` 有 33 个版本且**含 `0.2.0-rc.2`**，但其 `dist-tags.latest` 指向 **`0.0.1-rc.1`**（远早于 0.2.x 线）。`npm install @deepseek-ai/dsh-tools`（不带版本）会装到那条旧线并静默失配宿主 API。其余 devDeps 实测可解析：`@deepseek-ai/cordis` latest `4.0.4`、`semver` `7.8.5`、`typescript` `7.0.2`、`@types/node` `26.6.5`。
- **工具链坑**：PowerShell 的 `Invoke-WebRequest` 在本机 TLS 栈报「基础连接已经关闭: 接收时发生错误」，查 registry 一律用 node fetch。`npm install` 失败时的回退方案：复用 `work_space2\dsh-idea-scout\node_modules`（已含 cordis 4.0.4 / dsh-tools 0.2.0-rc.2 / typescript 5.9.3 / @types/node / semver）。

## 建议验证（非 v0.1 阻塞，2026-10-15 复审提出）

**AC1–AC12 全部只检验「能不能跑通、输出是否诚实」，没有一条检验「检索结果到底相不相关」。** 一个永不报错、表格漂亮、措辞严谨的插件，也可能每次都返回不相关的仓库——而这恰恰是用户唯一真正在意的结果。这是当前方案最大的未验证风险。

因此建议在 v0.1 之外（或在 v0.1 完成后立即）做一次**小规模 golden set 评测**，这是判断「值不值得继续投入」的唯一实验：

- **5–10 个固定 idea**，覆盖不同类型：纯中文抽象 idea、混合 Han+Latin、含明确技术栈、长尾领域（避免选那些「GitHub 上一搜一大堆」的题）。
- 每个 idea **人工标出 2–3 个「确实值得参考」的仓库**作为期望命中。
- 跑一遍 `scout_projects` + `rank_candidates`，记录：期望仓库**是否进候选池**、**是否进最终榜**、排名位置；同时记录查询诊断（哪条查询命中、哪条空手）。
- 输出一张对照表，**明确记录未命中**。若期望仓库连候选池都进不去，问题在检索层（翻译词质量 / 查询形状）；若进了池但被挤出最终榜，问题在排序层（star 公式对长尾的压制，见 R3 的长尾可观测性）。

**为什么不做成 AC**：它需要人工标注，不适合放进自动化验收；且当前没有基线数据，无法设定阈值。它是一次**探索性测量**，不是一条可自动判定的验收标准。

## Out of Scope

- 不做 GUI 面板 / client 半边（UI 增强类插件在生态里已饱和；输出必须是结构化、agent 可读的）。
- 不做 GitHub 之外的检索源。
- 不修 idea-scout 自身的 P0/P1 缺陷（已记录在 `D:\workspace\work_space2\idea-scout-core-issues-and-plan.md`）。
  - **例外（2026-10-15 复审，用户裁定 A）**：R1「已验证内核」诚实边界里那**五条继承性证据完整性缺陷**（RRF 余席排序、候选身份视图、缓存完整性、README 重复读与截断标注、选择器通用化）**在本次移植就地修复**（AC11）。它们不是「前身待修的缺陷」，而是会被原样继承、并直接决定「证据可信」这个立身之本的行为。
  - **另外两条就地修正**属于本次新写的代码，不是「修前身」：混合 Han+Latin 接线（AC9，新编排与旧守卫的冲突）与探针守卫资源桶（AC6/`design.md §4.3`，新写的守卫用错了桶）。
- 不在本任务内做发布/CI 闭环。
