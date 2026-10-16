# dsh-find-ideas v0.1 — 实施清单

> 规划阶段产物。**执行授权只来自用户对本方案的明确批准**（2026-10-15 复审更正：原文写「授权来自 `python ./.trellis/scripts/task.py start`」，但 `task.py start` 只是 Trellis 的状态迁移动作，不是授权来源）。批准后再执行 `task.py start` 把任务推进到实施态。
> 架构与契约见同目录 `design.md`；需求见 `prd.md`（R1–R7 / AC1–AC12）。本文件只记录**顺序、验证命令、风险点**。
> DSH 属 inline 工作流：不分派 implement/check 子代理，Phase 1.3 跳过。

## 0. 前置：环境与工作区

- [ ] **0.1** 确认工作区 ACL 仍可写（沙箱 Low 完整性已施加到全树）：
  `icacls . | Select-String Mandatory` 应见 `Low Mandatory Level`。
- [ ] **0.2** 确认 git 干净：`git status --porcelain` 只应有 `.trellis/tasks/10-15-find-ideas-v01/`。
- [ ] **0.3** 确认移植源未变（对照 `design.md §3.1` provenance 表）：
  `git -C D:\workspace\work_space2\dsh-idea-scout rev-parse HEAD` = `e4dfccf63abd60aee5819b03607e84ec7eeb6ac9`；
  `git diff | SHA256` = `cb10ca2605999217bb1e5173387aec1ad1bd4c4fa69e8bcccb1a0bd85a169ed1`。
  **若哈希不匹配 → 停下问用户**，不要盲移植（工作区状态是权威基线）。

## 1. 脚手架（R7）

- [ ] **1.1** 建 `package.json`：name `dsh-find-ideas`、version `0.1.0`、`type: module`、`main: lib/index.js`、`types: lib/index.d.ts`、`engines.node >=22`。
  - scripts 照搬 idea-scout：`typecheck` / `build` / `test` / `check` / `check:peers`。
  - **peerDependencies**：`@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-tools` 沿用 idea-scout 那条覆盖到 `^0.2.0-rc.1` 的 range（**已实测覆盖宿主 0.2.0-rc.2**）。
  - **devDependencies 全部钉死精确版本（不加 `^`）**：`@deepseek-ai/dsh-tools: 0.2.0-rc.2`、`@deepseek-ai/cordis: 4.0.4`、`typescript: 5.9.3`、`@types/node: 26.6.5`、`semver: 7.8.5`。
    ⚠️ `dsh-tools` 的 `dist-tags.latest` 是 `0.0.1-rc.1`，**不带版本号安装会装到旧线**。
    ⚠️ `typescript` 钉 **5.9.3**（与前身本地实际编译版本一致，已验证能编过这份源码）；registry latest 是 `7.0.2`，**不要**用 latest——换大版本会引入未验证的编译行为差异。
  - **`dependencies` 必须为空**（零新依赖是 R5 的硬约束）。
  - `dsh.bundle.patch: ./cordis.patch.yml`；`exports` 只暴露 `.` / `./cordis.patch.yml` / `./package.json`。
- [ ] **1.2** 建 `tsconfig.json`：照搬 idea-scout（target ES2023、module/moduleResolution NodeNext、declaration+declarationMap+sourceMap、**strict + noImplicitOverride + noUncheckedIndexedAccess**、verbatimModuleSyntax、erasableSyntaxOnly、allowImportingTsExtensions、rewriteRelativeImportExtensions）。
- [ ] **1.3** 建 `cordis.patch.yml`：`- insert:` / `- id: find-ideas` / `name: 'dsh-find-ideas'`。
- [ ] **1.4** 建 `.gitignore`：**必须含 `lib/`**（构建产物绝不手改）、`node_modules/`。
- [ ] **1.5** `npm install` → 若失败见 `design.md §5.4` 回退方案。

## 2. 移植九个模块（R1）

- [ ] **2.1** 逐文件移植 `types.ts` / `github.ts` / `query.ts` / `lexicon.ts` / `select.ts` / `cache.ts` / `credentials.ts` / `render.ts` / `index.ts`。
  - **基线 = 工作区状态**（含 1857 行在飞改动：双语路由 + 噪声/可疑度报告），**不是 HEAD**。
  - 保留 `erasableSyntaxOnly` 兼容写法；保留 `.ts` 扩展名 import（`rewriteRelativeImportExtensions` 负责改写）。
- [ ] **2.2** 改插件身份：`index.ts` 的 `export const name = 'dsh-idea-scout'` → `'dsh-find-ideas'`。
  **三个工具名与全部参数键保持不变**（R1 / `design.md §3.2`）。
- [ ] **2.3** 检查测试里对插件名的硬引用（如 `test/ranking.test.mjs`、`test/bilingual-routing.test.mjs` 的 `defs.get(...)`），确保断言在改名后**仍成立**。
- [ ] **2.4** 移植测试套件（13 个文件，含 `run-all.test.mjs`）。
  **`test/source-integrity.test.mjs` 必须一起移植**——它专门守源码文本不变量（无 U+FFFD、CJK/Latin 间距、实测数字未被改写），是本仓库「证据可信」的守门人。
- [ ] **2.5** 建 `README.md`（本仓库自己的，不复用 idea-scout 的）。
- [ ] **2.6** **移植时就地修复五条证据完整性缺陷**（`design.md §1.4` / AC11）。这五条会原样继承，**不是**「顺手改前身」：
  - **2.6.1 余席按 RRF 排序**：`github.ts` 里保留 quota 席，**其余席按 RRF 分数排序**（现状 `:961` 用 `[...quota, ...fused.keys()]` 插入顺序）。
  - **2.6.2 统一候选身份视图**：`types.ts` 的排序与**全部**诊断（含 `findScoreGaps`）共用同一个 lowercase `full_name` 视图与同一份有效评分（现状 `:673-694` 遍历原始 `candidates`、`:501-514` first-score-wins）。
  - **2.6.3 缓存完整性**：`index.ts` 缓存记录 requestedRepos / failedRepos / completeness / fetchedAt / 各文件错误；命中时**重建部分证据**，不得返回 `degraded: null`（现状 `:1327`）；**有效缓存先于网络配额拒绝**（现状 `:1258-1276` 顺序相反）；cache key 补 auth 可见性与 selector/scanner 版本。
  - **2.6.4 README 复用 + 五级截断标注**：`index.ts` 复用已读 README 填第一槽（`select.ts:468` 现在会重复读）；tree / API / file / excerpt / render 五级截断逐级标注范围。
  - **2.6.5 选择器通用化**：`select.ts` 软排除（`:148-151` 改为减分而非删除）+ 零源码 fallback + 补齐 `isEntryPoint` 语言集（`:436-443` 缺 `java`/`cs`）。**预算不变**：4 槽 / 6 请求 / 4500ms。详见 `design.md §4.5`。
  - **2.6.6** 为上面五条各写反例测试（`design.md §3.6` 表），不能只靠主路径回归。

## 3. 修正两处陈旧红灯（R1 / AC7）

- [ ] **3.1** `test/ranking.test.mjs:175`：期望数组加 `pool_source`（`['candidates','idea','keywords','limit','pool_source','scores']`）。
  **不放宽成子串测试**——`:176` 守「`stars`/`stars_rating` 不得回流」的断言必须原样保留。
- [ ] **3.2** `test/bilingual-routing.test.mjs:144`：断言限定在计划调用上（`calls.slice(0, expected.length)`）。
- [ ] **3.3** 同文件 `:151` 的 `calls.length === 3` 同步处理。
- [ ] **3.4** **新增**断言「探针调用不参与排序」——把 B6 探针从「测试没预期的噪声」变成「有测试保护的行为」。

## 4. 骨架扫描器（R5 / AC5）

- [ ] **4.1** 新建 `src/skeleton.ts`，导出 `scanSignatures(path, excerpt): SignatureHit[]` 与 `SignatureHit`（见 `design.md §2.4`）。
  - `SignatureHit` **必须**含 `startLine` / `excerptChars` / `truncated` / `supported` 四个新增字段——主 Agent 要能引用位置，也要能区分「没扫到」和「不在语言覆盖内」。
  - 零新依赖；行级正则覆盖 TS/JS、Python、Go、Rust、Java/C# 常见声明形态。
  - 用 `select.ts:138 SOURCE_EXT_RE` 判定语言；每文件命中数有上限；**不在覆盖内的扩展名返回 `supported: false` 而不是空数组**。
- [ ] **4.2** 接到 `index.ts` 的 `inspect_projects`：扫描点必须是**已有的 1200 字符摘录**（`src/index.ts:463` `file.text.slice(0, 1200)`）。
  **`INSPECT_BUDGET` 不变、不新增任何请求。**
- [ ] **4.3** `renderInspections` 渲染骨架为 Markdown（至少含：文件路径、类名、方法/函数名与签名），并**声明这是启发式提取、摘录可能被截断、可能漏项**。
  - **必须声明这是「文件头局部声明证据，不是完整架构」**，且**零命中不等于该仓库没有类/函数**（`design.md §2.4` 的约束表）。
  - **拓扑结论（依赖方向 / 调用链 / 持久化边界 / 进程边界）只在摘录内出现 import / 调用 / 接口等直接证据时才允许输出。**
  - 保留已有 `tree.sha` / `blob.sha`，但 **tree SHA ≠ commit SHA**，不得冒充 `blob/<commitSHA>/path#Lx-Ly`。
- [ ] **4.4** 新增测试：对多语言样本断言命中；对空/畸形摘录断言不抛错、不产生伪命中；对不支持扩展名断言 `supported: false`；对「文件头只有版权头+import」的样本断言零命中时输出仍带截断/覆盖声明。

## 5. 插件内翻译（R2 / AC1 / AC2）

- [ ] **5.1** 新建 `src/translate.ts`，导出 `translateIdea(idea, callerKeywords, signal?): Promise<TranslateOutcome>`（见 `design.md §2.2`）。
  - `ctx.get('llm')` 读取（**绝不写进 `inject`**）；`ctx.llm.stream(...)` 返回 **AsyncIterable**，`for await` 累加 `type === 'text-delta'` 的 `chunk.text`。
  - provider/model 从 `ctx.get('agentDefaultModel')?.currentSelection()` 读，**不硬编码模型 id**。
- [ ] **5.2** 实现决策表（`design.md §2.2`）：英文 idea / 调用方已给有效 keywords → **不调 LLM**。
- [ ] **5.3** 实现输出校验：至少一个含拉丁字母的词、词数 1..`MAX_QUERY_TERMS`、总长有界、剥围栏与引号、**CJK-only 视为非法**。LLM 输出按 adversarial 输入处理。
- [ ] **5.4** 超时 `AbortSignal.timeout(8000)` 并转发 `exec.signal`（调用方取消优先）。
- [ ] **5.5** 接到 `index.ts` 的 `scout_projects`：替换 `refuseChineseIdeaWithoutKeywords` 的**早退分支**（`src/index.ts:656-660`），保留它作为 LLM 不可用时的**回落路径**。
  ⚠️ **「跳过翻译」不得重新落进旧守卫**（`design.md §2.2` / AC9）：旧守卫判的是「**任何**汉字 **且** keywords 无拉丁字母」就拒绝，所以 `本地优先的 Markdown 笔记应用，支持双向链接`（不给 keywords）会「跳过翻译 → 仍被拒」。跳过翻译 **≠** 走旧拒绝分支：为这类输入构造确定性的规划器上下文（从 idea 里的拉丁词直接生成 seed，或给新编排一个「已通过」标识）。旧守卫**只保留给**「LLM 不可用且确实无任何拉丁字母」这一条回落路径。
- [ ] **5.6** `degraded.detail` 必须说明**为什么**降级（比今天的裸拒绝更有信息量）。
- [ ] **5.7** **prompt 必须写明检索词预算**（`design.md §2.2`）：至多 3 个词、按重要性排序——前 2 词 = 领域核心（进宽查询），第 3 词 = 最关键的能力/限定符（只进长尾）。
  **工具输出必须报告实际进入查询的词与被丢弃的后缀**（现状：`blockchain explorer multi-chain transaction tracing` 与 `... social feed` 产生**完全相同**的三条查询，关键约束凭空消失）。
- [ ] **5.8** 新增测试：纯中文 idea 无 keywords 时（a）LLM 可用 → 产出英文词；（b）`ctx.get('llm')` 为 `undefined` → 不抛错、返回 degraded；（c）LLM 返回非法输出 → 降级。**测试用 stub，不真调模型。**
- [ ] **5.9** 新增**四分支接线测试**（AC9）：纯中文无 keywords / **混合 Han+Latin 无 keywords**（不得 `plan_failed`）/ 纯英文 / 调用方已给 keywords。

## 6. 表格渲染（R3 / R4 / AC3 / AC4）

- [ ] **6.1** 改 `src/render.ts` 的 `renderRanked`：把 `:256-267` 的逐行卡片换成 Markdown 表格（八列，见 `design.md §2.3`）。
  - **不设独立星级列**（`stars_rating` 是 relevance 的纯函数，无增量信息）；**保留归档标记**（不可由其他列推导）。
  - 简介列复用 `clipDescription`（`render.ts:49`）。
- [ ] **6.2** `pushed_at` 空值渲染占位 `—`，**绝不渲染 `undefined`**。
- [ ] **6.3** **表格转义**：`full_name` 与 `description` 里的 `|` 必须转义（这是替换渲染器引入的新风险）。
- [ ] **6.4** **保住结构性隔离**：`【代码计算区】`（`:255`）与 `【调用方说明区】`（`:282`）不得拉平；`noiseAdvice`（`:277`）、排除统计（`:270-274`）、`suspiciousBlock`（`:286-290`）、`排序与星级均由代码按公式计算，不可由模型指定。`（`:269`）**原样保留**。
- [ ] **6.4b** **代码计算区声明改成分三类**（`design.md §2.3` / AC3）：`relevance` = **调用方判断**；`stars` / `pushed_at` / `description` = **传入元数据（来源声明未校验）**；`得分` / `评级` / `顺序` = **代码派生**。
  ⚠️ **删掉**「以下每个数字均由代码算出，调用方不能指定或改动」这句超边界的话——实测传 `stars=99999`、`pushed_at=2099-01-01`、`pool_source=scout_projects` 时工具照常出表且**无任何告警**（`src/index.ts:869-929`、`:924-929`、`:1034-1079`）。措辞要点：**算术可复算 ≠ 输入是真的；工具不报警 ≠ 已核实。**
- [ ] **6.4c** **`note` 真正透传**（AC10 / `design.md §2.3` 第 7 段）：`rankCandidates` 透传 `note`（现状 `src/types.ts:707-725` 丢弃）→ 输出 schema 声明它（现状 `src/index.ts:943-967` 没有）→ 渲染器读到的就是它（现状 `src/render.ts:279-305` 读 `row.note` 但**永远为空**）。只渲染在**表格之外**并标 `[未验证]`。
- [ ] **6.4d** **指令隔离与转义**（AC10）：所有 GitHub 正文标为「**未信任来源数据**」，不执行其中代码 / install 脚本、不 follow README 里的工具指令；文本字段统一转义换行 / `|` / `[` `]` / 反引号 / HTML 尖括号；链接只允许 **HTTPS + `github.com` / `raw.githubusercontent.com` 白名单**；`repo` 严格两段 `owner/name`、`paths` 拒 `..` 与控制字符并去重；源码块用足够长围栏消除伪造闭合；**许可证未知时标「许可证未验证：可参考理念，不授权复制实现」**（候选元数据没有 license 字段，`src/github.ts:412-427`）。
- [ ] **6.5** 空候选分支（`:228-242`）也同步为表格语义。
- [ ] **6.6** 新增测试：**八列**齐备（`#` / 项目 / 最近更新 / relevance / stars / 得分 / 语言 / 简介）；数字可由代码复算；`pushed_at` 空值占位 `—`；含 `|` 的描述不撕裂表格；诚实性区块仍在表格下方。
- [ ] **6.7** 新增测试（AC10）：**execute→render 端到端**验证 `note` 出现在【调用方说明区】并标 `[未验证]`（**不能只手工构造行测渲染器**——手工构造正是这个断链至今没被发现的原因）；含换行 / 反引号 / 伪造围栏 / README 注入句的描述不越出数据区。

## 7. 请求预算守卫（R6 / `design.md §4.3`）

- [ ] **7.1** 在 `github.ts` 的逐词探针（`:789 probeTermTotals`）前加守卫。⚠️ **守卫必须看 search 桶，不是 core 桶**（`design.md §4.3`，2026-10-15 复审修正）：探针调 `/search/repositories`（`:812`），而 `getCoreQuota` 只读 `resources.core`（`:274-290`），两者是**独立资源桶**（core 匿名 60/h、认证 5000/h；search 匿名 10/min、认证 30/min）。
  - 判据：`拟执行探针数 + 重试预留 + 安全余量 > search 剩余额` → 跳过探针。
  - 剩余额取自**已有的 search 响应头** `x-ratelimit-remaining` / `x-ratelimit-reset`（`:728-729` 本来就读了，**无需新增请求**）。
  - **配额未知时明确标注未知**，不假设充足。
- [ ] **7.2** 跳过时在输出里**说明跳过原因**（诚实性：读者要知道这轮没有逐词诊断）。
- [ ] **7.3** **core 继续保护源码读取**（这一条不变）。**「有 token 就无条件保留探针」作废**——认证不等于 search 享 5000/h；认证时同样按 search 剩余额判定。
- [ ] **7.4** 新增测试：**core 充足但 search 剩余 0 → 探针被跳过**（旧逻辑会放行）；search 充足 → 保留；匿名 + 紧张 → 跳过且输出有说明。
- [ ] **7.5** **诊断措辞不得强于证据**（AC12 / `design.md §2.7`）：solo totals 表述为**基数/宽泛度启发式**，不是语义约束力；未知标「未测」、零命中标「solo 无命中」、缓存命中显示「诊断未保存」；长尾失败文案改为「**长尾通道覆盖未知**」（删掉「只包含高 star、≤100 无法进池」这个已被反例推翻的绝对断言）。
- [ ] **7.6** **长尾可观测性**（AC12）：诊断**分开**统计「候选池低 star 数」与「**最终榜低 star 数**」。公式不改（用户既有裁定），但长尾流失必须可见。测试：低 star 候选在池里但被最终榜挤掉时，两个统计分别反映。

## 8. 构建与验证（AC7）

- [ ] **8.1** `npm run typecheck`（`tsc -p tsconfig.json --noEmit`）零错误。
- [ ] **8.2** `npm run build`。
- [ ] **8.3** `node test/run-all.test.mjs` → **全部通过**（含 `source-integrity`）。
- [ ] **8.4** 复核测试红灯时**必须** `node test/<file>`（**不带 `--test`**）：本项目测试自己打印 `FAIL`/`PASS`，`node --test` 的过滤会给出假阴性。按 `FAIL|AssertionError|PASS / N FAIL` 过滤。
- [ ] **8.5** `node test/source-integrity.test.mjs` 单独跑一次——它是源码文本守门人，`lib/` 绿不代表源码可编译。
- [ ] **8.6** `npm run check:peers`（若移植）：确认 peer range 仍覆盖 registry 上的宿主线。
- [ ] **8.7** **AC9（四分支接线）**：`node test/translation-routing.test.mjs` —— 纯中文无 keywords / **混合 Han+Latin 无 keywords 必须不出 `plan_failed`** / 纯英文 / 调用方已给 keywords。用 stub LLM，不真调模型。
- [ ] **8.8** **AC11（五条继承缺陷的反例）**：`node test/evidence-integrity.test.mjs` —— 每条反例独立可跑（`design.md §3.6` 表）：
  RRF 反例（`channels=[a0,a1,a2,x],[b0,b1,x,b3]`，全 200★、limit 5 → `x` 必须入榜）；候选身份（同仓传两次 → 一行；两个 9 分 → 诊断不报冲突）；缓存（先成功 1 个再限流 1 个 → 二次命中**不得**报 `degraded: null`，且有效缓存先于配额拒绝）；README（shallow 请求数不因重读 README 而增加）；选择器（Android / Python CLI / Tauri 三棵树，前两棵必须有源码槽）。
- [ ] **8.9** **AC10（证据链）**：`node test/evidence-chain.test.mjs` —— execute→render 的 `note` 端到端 + 注入样本（伪造围栏 / README 指令句 / `|` / 换行）。
- [ ] **8.10** **AC12（诊断强度）**：`node test/diagnostics-honesty.test.mjs` —— 零命中词标「solo 无命中」、未知标「未测」、缓存命中显示「诊断未保存」、长尾失败文案为「长尾通道覆盖未知」；**候选池低 star 数与最终榜低 star 数分开统计**（低 star 在池里被最终榜挤掉时两个数字必须不同）。
- [ ] **8.11** **AC3（三类声明）**：传 `stars=99999` / `pushed_at=2099-01-01` / `pool_source=scout_projects` 的注入样本 → 输出**必须**保留三类声明，且**不得**出现「均由代码算出、不可指定」这类断言。

## 9. 克隆 profile 无头验证（AC8，**动 live 之前**）

- [ ] **9.1** 克隆 desktop profile（排除 `node_modules` 后仅 0.99 MB）到临时目录。
- [ ] **9.2** 建 `node_modules` junction 指向真实依赖目录。
- [ ] **9.3** 在克隆 profile 的 `package.json` 里加 `dependencies` + `dsh.profile.bundles` **两项**。
- [ ] **9.4** `ELECTRON_RUN_AS_NODE=1` 跑 `resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js --profile <克隆> --no-open --port 0`。
- [ ] **9.5** **判成功看 stderr 有无** `did not activate` / `AggregateError` / `has no create() factory` / `skipping profile bundle`。
- [ ] **9.6** 验证 AC2 / AC8：在缺 `llm` / `credentials` / `agentDefaultModel` 的情形下插件仍加载。
  ⚠️ **不可用 `dsh --profile desktop --dump-config`**（desktop 被 Electron 独占，exit 1）。

## 10. 装进 live desktop profile + idea-scout 退休（用户 m00688 B）

- [ ] **10.1** **先向用户出示 §9 的验证结果，取得确认后再动 live profile。**
- [ ] **10.2** 用宿主 `write`/`edit` 工具改 `C:\Users\<user>\.dsh\profiles\desktop\package.json`：加 `dsh-find-ideas` 到 `dependencies` **和** `dsh.profile.bundles`（缺一不生效）。
  ⚠️ **`dsh plugin` CLI 在本会话不可用**（`EPERM ... package.json.lock`，沙箱 Low 完整性无法写 profile 目录）。
- [ ] **10.3** 移除 idea-scout 的悬空 `file:` 依赖（它本就不在 `bundles` 里，移除不改变现有行为）。
- [ ] **10.4** 重启 dsh 并确认三个工具出现在工具列表。
  ⚠️ **绝不让 find-ideas 与 idea-scout 同时激活**（工具名相同，会冲突）。
- [ ] **10.5** 若加载失败：恢复 `package.json` 备份（`.bak-shop-20260929-133401`、`.bak-v054`）或删掉那两处条目。

## 11. 收尾（Trellis Phase 3）

- [ ] **11.1** 更新 `.trellis/spec/`（Phase 3.3，`[required · once]`）。
- [ ] **11.2** `python ./.trellis/scripts/get_context.py --mode packages` 列出受影响包，读各包 spec index 的 Quality Check 段（**最后一轮必须全范围**，不只看最近改动）。
- [ ] **11.3** 提交（Phase 3.4，`[required · once]`）：**先出示批量提交计划 + 一次性确认**；禁止 `--amend`、禁止 push。
- [ ] **11.4** 提醒用户跑 finish-work。

## 验证命令速查

```powershell
npm run typecheck                    # tsc --noEmit
npm run build                        # tsc
node test/run-all.test.mjs           # 全套（判 exit code）
node test/source-integrity.test.mjs  # 源码文本守门人（必须单独跑）
node test/ranking.test.mjs           # 单文件复核（不要加 --test）
```

## 风险点与回滚

| 风险 | 触发信号 | 处置 |
|---|---|---|
| 移植源在动 | provenance 哈希不匹配（步骤 0.3） | **停下问用户**，不盲移植 |
| 装到旧线 dsh-tools | `npm ls @deepseek-ai/dsh-tools` 显示 0.0.1-rc.1 | 钉死精确版本重装 |
| 表格撕裂 | 描述含 `\|` 时列错位 | 步骤 6.3 转义 + 6.6 测试 |
| 插件加载失败 | stderr 有 `did not activate` / `AggregateError` | 查 peer range 与 `inject` 声明；`inject` 只应有 `tools` |
| 两插件冲突 | 工具名重复注册 | 确保 idea-scout 未进 `bundles` |
| live profile 改坏 | 启动异常 | 恢复 `.bak-*` 备份 |
| 沙箱写不了 profile | `EPERM ... package.json.lock` | 用宿主 `write`/`edit` 工具，不用 CLI |
| **混合输入被旧守卫拒掉** | 混合 Han+Latin idea 无 keywords → `plan_failed` | 步骤 5.5：跳过翻译 **≠** 走旧拒绝分支；旧守卫只留给「LLM 不可用且无任何拉丁字母」；8.7 四分支测试 |
| **探针守卫又用错桶** | core 充足而 search 剩余 0 时仍放行探针 | 步骤 7.1：守卫读 search 响应头；8.8 的 core 充足 / search 为 0 反例 |
| **缓存洗成完整成功** | 部分批次被限流后二次命中报 `degraded: null` | 步骤 2.6.3：缓存存 completeness/failedRepos；有效缓存先于配额拒绝；8.8 反例 |
| **note 又变空** | 输出没有【调用方说明区】内容 | 步骤 6.4c：三处一起改（types/schema/render）；6.7 端到端测试 |
| **签名扫描被读成完整架构** | 零命中被解读为「仓库没有类/函数」 | 步骤 4.3：声明「文件头局部声明证据」+ `supported` 字段；输出保留截断标注 |
| **长尾流失不可见** | 候选池有低 star 仓但最终榜没有，诊断不显示 | 步骤 7.6：池内 / 最终榜两个数字分开统计 |
| **翻译词被静默丢弃** | 输出没报告实际入查询词 | 步骤 5.7：报告实际入查询词与被丢弃后缀 |
