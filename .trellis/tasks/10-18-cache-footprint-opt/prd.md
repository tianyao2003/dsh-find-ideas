# dsh-find-ideas：削减缓存体积、给内存设上限、缩小安装体积

> 父任务（umbrella）。**只负责需求集、子任务映射与最终集成评审**，不直接改代码。
> 实现授权来自用户对 2026-10-18 五步方案的明确批准（Step 0→4）；`task.py start` 只是状态迁移，不是授权来源。
> 本任务的四个子任务各自独立可验收，依赖关系写在 §子任务映射，**不靠树形位置暗示**。

## Goal

修掉四个**已实测**的资源缺陷，让「别人装到电脑上占多少」这个问题的答案从「装完 2.07 MB、跑起来几 MB 到几十 MB 且只增不减」变成「装完 ≤0.8 MB、常驻内存有上限、磁盘缓存有天花板」。

四条缺陷都不是新能力，是**已经量出来的浪费**：

1. **入口不截断 description**：`src/github.ts:444` 的 `description: String(item.description ?? '')` 原样存下 GitHub 返回的描述，而渲染层 `src/render.ts:47` 的 `MAX_DESCRIPTION_CHARS = 200` 只截渲染。缓存里存的是完整值 → 搜索缓存被少数投毒仓库撑大 21 倍。
2. **内存 Map 无上限**：`src/cache.ts:102` 的 `const memory = new Map<string, CacheEntry<unknown>>()` 只 `set` 从不淘汰，过期命中也不删，进程生命周期内单调增长。
3. **磁盘无 GC**：全 `src/` 无任何 `unlink` / `rm` / `prune` / `evict`；过期条目永久留在盘上，`.tmp-*` 残留也不清。
4. **开发物进 npm 包**：`files` 收了 `src` / `test` / `scripts`，加 `lib/**/*.map`，合计占解包体积约 60%。

## 实测基线（改动前的数字，全部为验收对照）

### 缓存与内存（`C:\Users\longt\.dsh\cache\dsh-find-ideas`，2026-10-18 采样）

| 指标 | 实测值 |
|---|---|
| 缓存目录总量 | 41 文件 / **11,215,236 B** |
| 其中 search 条目 | 31 个 / **10,926,619 B（97.4%）** |
| 其中 inspect 条目 | 10 个 / 288,617 B（最大单条 42,638 B） |
| 全部候选的 description 字符数 | 817 条候选，合计 **4,760,069 字符** |
| 空白归一化后分布 | p50=150、p90=349、p99=64,815、max=**241,896** |
| 超过 512 字的候选 | **74 条（9%）** |
| 单条最大缓存文件 | **1,466,729 B**（其 30 条候选 description 合计 617,799 字符） |
| 超过 24h 已过期但仍在盘上 | **26 文件 / 6,614,405 B**（永不删除的垃圾；2026-10-18 复测，会随日期增长） |
| 残留 `*.tmp-*` | **0 个**（本机未观测到，但代码路径确实会残留） |
| 体积集中度 | 11 个 >100 KB 文件占 97% |

**截断模拟**（对真实 31 条缓存重序列化，空白归一化 + 截断）：

| 上限 | 重序列化后总字节 | 相对现状 |
|---|---|---|
| 现状（不截断） | 10,926,619 | 1.00× |
| cap 200 | 445,230 | 0.041× |
| **cap 512（选定）** | **514,478** | **0.047×** |
| cap 1024 | 619,337 | 0.057× |
| cap 2048 | 806,772 | 0.074× |
| cap 4096 | 1,142,959 | 0.105× |

**内存实测**（`node --expose-gc`，两轮 GC 后取稳定值）：

- `import('./lib/index.js')`：heap **+2.84 MB**、external **+0.43 MB**（模块静态开销，与缓存无关）。
- 解析 1,466,729 B 那条缓存：raw string 1.20 MB + 对象图合计 2.59 MB；丢掉 raw 后**对象图驻留 1.20 MB**。
- 推论：若 11 条大条目全部驻留内存 Map，仅对象图约 13 MB，且**随使用无上限增长**。

### 包体（npm 0.2.1，`npm pack` 实测）

| 口径 | 实测值 |
|---|---|
| tarball（下载） | **742,840 B（0.71 MiB）** |
| 解包 | **2,072,582 B / 91 文件**（registry `unpackedSize` 2,073,420、`fileCount` 91） |
| `lib` 合计 | 782.4 KB（22 个 `.js`+`.d.ts` = 584.2 KB，22 个 `.map` = **198.2 KB**） |
| `src` | 476.1 KB |
| `test` | 555.8 KB |
| `scripts` | 21.7 KB |
| `docs/dsh-find-ideas-architecture.png` | **173,910 B** |
| 开发物合计 | 约 1.25 MB ≈ 解包的 **60%** |

`package.json` 的 `files` = `["lib","src","test","scripts","cordis.patch.yml","README.md","README.zh.md","LICENSE","docs/dsh-find-ideas-architecture.png"]`；`dependencies: {}`（零运行时依赖，必须保持）。

### 测试基线

- `npm run typecheck` 通过（无输出）。
- `npm test`（`test/run-all.test.mjs`）：**24/26 文件通过，2 skipped**；逐文件小计求和 = **6377 PASS / 0 FAIL**。
  - **陷阱（本任务探查时踩过，必须写下来）**：`run-all` 用 `stdio: 'inherit'` 顺序跑子进程，所以终端上**最后那行 `45 PASS / 0 FAIL` 不是套件总计**，是最后一个文件（`translation-routing.test.mjs`）自己的小计。套件级真相只有 `N/M test files passed` 那一行；PASS 总数必须逐文件求和。
  - 逐文件基线（`node test/<file>` 各自末行）：archived-visibility 27、bilingual-routing 91、cache 29、channel-visibility 48、credentials 54、declaration-honesty 47、diagnostics-honesty 50、evidence-chain 35、evidence-integrity 55、instruction-isolation 140、plan-failure 80、planner-properties **4592**、probe-guard 61、queries 197、ranking 83、render-budget 34、render-table 129、replay 35、retrieval-surface 28、selector-generalization 121、skeleton 142、source-integrity 27、translate 227、translation-routing 45；`baseline` 与 `stage2` 无小计（自跳过）。
- 2 个 skipped 是 `baseline.test.mjs` / `stage2.test.mjs` 因 `eval/runs/` 冻结记录缺失自跳过，属**已知基线**，与本任务无关。
- 测试从 `lib/` 导入（`pathToFileURL(join(pkgRoot,'lib',rel))`），**改源码后必须先 `npm run build`** 再跑测试。

## Requirements

四条需求一一对应四个子任务，编号全局唯一，子任务 PRD 直接引用这些编号。

- **R1 — description 在入口截断（子任务 `10-18-cache-description-cap`）**
  - 在 `toCandidate`（`src/github.ts:436`）写入缓存前就把 description 归一化并截到 **512** 字符。
  - 512 是**用户选定**的值（不是默认猜测）：实测只影响 9% 的候选，却把缓存从 10.9 MB 压到 0.51 MB。
  - **必须同时改写 `src/render.ts:30-46` 的注释**：原文写「It is applied at render time rather than at fetch time so the stored candidate keeps its full value for scoring」，这是**有意识的旧决策**，入口截断会直接推翻它。留着不改就是让注释说谎。
  - 打分只读 `description` 做相似度，与长度无关；截断后 similarity 不得改变（除超长样本外）。这是可验收的性质，不是假设。
- **R2 — 进程内缓存设上限（子任务 `10-18-cache-memory-ceiling`）**
  - `memory` Map 条目数上限 **64**，命中即刷新（LRU），过期命中即删除。
  - 新增可观测的 `cacheMemoryStats()`，让上限**可被测试断言**，而不是靠读代码相信。
  - 上限必须**不影响正确性**：淘汰只影响命中率，绝不能返回错值。
- **R3 — 磁盘缓存 GC（子任务 `10-18-cache-disk-gc`）**
  - `cacheSet` 成功后**机会式**清扫，每进程每小时最多一次，不给正常路径加可感知延迟。
  - 删三类：`mtime` 超 24h 的 `.json`、`mtime` 超 10 分钟的 `*.tmp-*`、总量超 **64 MB** 时按 `mtime` 从旧到新删。
  - 清扫失败（目录不可写、并发删、权限）**不得**让 `cacheSet` 失败——缓存是 best-effort，这条是既有契约（`src/cache.ts:238-240`）。
- **R4 — 精简 npm 包体（子任务 `10-18-package-slim`）**
  - `files` 去掉 `src` / `test` / `scripts`；`lib` 由目录改为显式 glob `lib/**/*.js` + `lib/**/*.d.ts`，从而排除 22 个 `*.map`。
  - **修正（2026-10-18 实测否证）**：原方案「用 `.npmignore` 排除 `lib/**/*.map`」**不成立**——`files` 列出目录时根 `.npmignore` 不生效（最小复现：`files:["lib"]` + 根 `.npmignore` 写 `lib/**/*.map`，打包结果仍含 `lib/a.js.map`）。子目录 `lib/.npmignore` 虽有效，但 `lib/` 被 `.gitignore` 忽略，该文件进不了 git，故也不可选。**只有显式 glob 可行**，详见子任务 PRD。
  - **保留** `docs/dsh-find-ideas-architecture.png`：`README.md:53` 与 `README.zh.md:53` 都引用它，删了就是坏图。
  - 打包后的插件必须仍能 `import` 并注册三个工具——体积指标不能替代可用性验证。

## Acceptance Criteria

父任务只在**四个子任务全部完成之后**验收；下列每条都要求附证据命令与输出。

- [ ] **AC1（集成）** 四项改动同时存在时，`npm run check` 与 `npm test` 全绿，且：
  - `run-all` 汇总行应为 `27/29 test files passed, 2 skipped`（基线 24/26；R1–R3 各新增 1 个测试文件，分母 +3、分子 +3，`skipped` 恒为 2 个——`baseline` 与 `stage2` 因 fixture 缺失自跳过）；
  - **逐文件小计求和 ≥ 6377 PASS / 0 FAIL**（新增测试只增加 PASS 数，任何单个文件的小计不得减少）；
  - 不得把终端最后一行 `45 PASS` 当作套件总计——那是 `translation-routing.test.mjs` 的小计。
- [ ] **AC2（集成）** 真实缓存目录的离线回放（不联网、不删原文件）证明：截断生效后 31 条 search 条目合计 **≤600 KB**、单条 **≤60 KB**。
- [ ] **AC3（集成）** 内存上限在压力下成立：连续写入 100 条 1 MB 级数据后 `cacheMemoryStats().entries ≤ 64`，进程 heap 增量 **<20 MB**。
- [ ] **AC4（集成）** 磁盘 GC 在真实目录上把「超过 24h 的条目」清到 **0**（其余未过期条目一个不动）。基线在 2026-10-18 是 26 个 / 6,614,405 B，但该数随日期增长，**断言必须写成「清后为 0」，不得写死 26**。
- [ ] **AC5（集成）** `npm pack` 实测：tarball **≤400 KB**、解包 **≤800 KB**、文件数 **≤30**；清单不含 `src/` `test/` `scripts/` `*.map`；在**仓库内**（非 `$env:TEMP` 裸目录）`import` 成功且三工具注册齐全；`README` 架构图仍在包内。
  - **实测预估（已用真实 `lib/` 内容跑通方案 A）**：28 文件 / 792,487 B / tarball 386,767 B —— 三项分别只剩 2 / 1% / 3% 余量，阈值不放松。
- [ ] **AC6（集成）** 四个子任务各自 AC 全绿，且**每个子任务一个独立 commit**（可单独 `git revert`）；`v0.2.1-baseline` tag 仍指向改动前 HEAD `1505487`。
- [ ] **AC7（集成）** 明确未改动的项逐条核对：tool 入参/出参/卡片格式未变、排序公式未变、`MAX_DESCRIPTION_CHARS = 200` 渲染行为未变、`INSPECT_BUDGET` 与 10 分钟 `SOURCE_TTL_MS` 未变、`dependencies` 仍为 `{}`、缓存目录位置未变。

## Out of Scope

- **不做 sha256 换键**（原 Step 5）。djb2 32 位碰撞在 41 个文件的规模下无实际风险，用户已明确不选。碰撞的真实后果是「两个 key 互相覆盖」→ 退化为一次 miss 或错误命中；后者才是问题，但需要构造碰撞才能触发，收益远小于改动面。
- **不改 tool 契约**：三个工具的名称、入参 schema、出参 schema、卡片/表格格式一律不动。`test/ranking.test.mjs` 钉住参数名集合、`test/render-table.test.mjs` 钉住「恰好八列」，动了就挂。
- **不改排序公式**：`relevance × (1 + log10(max(stars, 10) + 1)) / 2` 是中心契约，`design.md §2.3` 与测试都钉着。
- **不改 `MAX_DESCRIPTION_CHARS = 200` 的渲染行为**：渲染上限与存储上限是两个独立旋钮，R1 只动存储。渲染层继续负责「描述过长，原长 N 字符」的提示。
- **不动 `INSPECT_BUDGET` 与 `SOURCE_TTL_MS = 10 分钟`**：10 分钟是 `src/cache.ts:31-52` 逐字论证过的证据新鲜度取舍，不属体积问题。
- **不引入任何依赖**（含 SQLite / lru-cache）：`dependencies: {}` 是硬约束，LRU 用 Map 的插入顺序实现即可。
- **不换缓存目录、不改文件命名、不加缓存格式迁移逻辑**：R1 的 `CACHE_VERSION` 2→3 已经足够让旧条目自然失效。
- **不 push、不发版、不改 README 正文**：版本号与发布是独立动作。

## 技术注记

### 为什么 512 而不是 200 或 1024

- 200（= 渲染上限）会把「存储上限」和「显示上限」绑死，将来想放宽显示就得改缓存格式。
- 512 是 2 的幂、覆盖 p99（64,815 之上的尾部）之外的全部正常描述，实测只命中 9% 的候选，压缩比 0.047×。
- 1024 及以上压缩收益迅速衰减（0.057× / 0.074× / 0.105×），却仍留下 MB 级单条缓存。
- **512 是用户明确选定的值**，实现不得擅自改。

### 为什么 `CACHE_VERSION` 必须 2→3

截断后写入的条目与旧条目的 `data.description` 长度语义不同。旧条目继续被读，会让「热路径 description 与冷路径一致」这条 AC 无法成立：同一次查询，磁盘命中给长描述、网络新取给 512 描述，排序与渲染结果随之漂移。升版本 = 旧条目整体失效 = 一次 re-fetch 换一致性，与 `src/cache.ts:12-22` 已经为 1→2 写下的理由同构。

### 行号引用的风险

`.trellis/spec/` 内有 **334 处** `src/*.ts:NNN` 形式的行号引用（分布在 13 个文件），另有 `.scratch/verify-tree.mjs` 连裸 `:NNN` 一起校验。**没有任何测试检查这些引用**。本任务的改动**优先保持行数不变**；若不可避免地位移，必须在同一 commit 内更新受影响的 spec 引用，并跑 `.scratch/verify-tree.mjs` 确认 `PAST EOF: 0` / `nonexistent file: 0` / `NEEDS ADJUDICATION: 0`。

### 复核红灯的正确方式

直接跑 `node test/<file>`，**不带 `--test`**——本项目测试自己打印 `FAIL`/`PASS`，`node --test` 的过滤会给出假阴性。

## 子任务映射

| 子任务目录 | 需求 | 依赖 | 主要文件 |
|---|---|---|---|
| `10-18-cache-description-cap` | R1 | 无（**第一个做**） | `src/github.ts`、`src/render.ts`、`src/cache.ts`（仅版本号） |
| `10-18-cache-memory-ceiling` | R2 | 依赖 R1 的 commit（同一文件 `src/cache.ts`，避免并发编辑冲突） | `src/cache.ts` |
| `10-18-cache-disk-gc` | R3 | 依赖 R2 的 commit（同上，`src/cache.ts` 收尾） | `src/cache.ts` |
| `10-18-package-slim` | R4 | 依赖 R1–R3 全部完成（要打包的是最终 `lib/`） | `package.json`（仅 `files` 字段；不新增 `.npmignore`） |

**顺序理由**：R1/R2/R3 都碰 `src/cache.ts`，串行提交让每个 commit 都能单独 `git revert` 而不产生冲突。R4 打包的是 `lib/`，必须最后做，否则量的是旧构建产物。
