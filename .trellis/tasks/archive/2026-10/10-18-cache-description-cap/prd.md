# dsh-find-ideas：在缓存入口截断 description（R1）

> 父任务：`.trellis/tasks/10-18-cache-footprint-opt`（R1）。
> 顺序：**第一个做**，无前置依赖。R2/R3 都要改 `src/cache.ts`，本任务只碰它的版本号常量。

## Goal

在 `toCandidate` 把 GitHub 描述写入缓存之前截到 **512 字符**，并把 `CACHE_VERSION` 2→3 让旧条目自然失效；同时改写 `src/render.ts:30-46` 那段「故意推迟到渲染时再截」的注释。

实测：真实缓存 31 条 search 条目 **10,926,619 B → 约 514,478 B**（0.047×），只影响 9% 的候选。

## 背景：为什么必须是入口

- `src/github.ts:444` 是 `description: String(item.description ?? ''),` —— 原样存下 GitHub 返回的描述。GitHub 不限制这个字段长度，实测单条最长 **241,896 字符**。
- `src/render.ts:47` 的 `MAX_DESCRIPTION_CHARS = 200` **只截渲染**，缓存里仍是全量。
- 817 条候选中 **74 条（9%）超过 512 字**，却贡献了 97% 的体积。
- `toCandidate` 是唯一填充搜索缓存的入口：`searchRepositories`（`src/github.ts:483`）→ `searchMerged` → `src/index.ts:1156` 的 `cacheSet`。`rank_candidates` 接受调用方自带的候选池，但那批数据**不入缓存**，所以不需要在别处再截一次。

## 需求

- **R1.1** 在 `src/github.ts` 内新增常量与函数：
  ```ts
  const MAX_STORED_DESCRIPTION_CHARS = 512
  function storedDescription(raw: string): string
  ```
  `storedDescription` 只在 `raw.length > 512` 时 `raw.slice(0, 512)`，否则原样返回。**不加任何截断标记**——标记是渲染层的职责，写进存储只会白占预算并让 `clipDescription` 二次标记。

- **R1.2** **只截断，不折叠空白。**
  折叠（`\s+` → `' '`）会改变 `similarity()`（`src/types.ts:579`，字符 bigram）的输入，让「≤512 字的候选打分逐字不变」这条可验证性质失效。渲染层 `clipDescription`（`src/render.ts:58`）本来就折叠，入口不折叠不会漏掉任何单行化需求。

- **R1.3** `toCandidate`（`src/github.ts:436`）的 `description` 字段改为 `storedDescription(String(item.description ?? ''))`。

- **R1.4** `src/cache.ts:23` 的 `CACHE_VERSION` 2→3，并在其上方注释里按 1→2 的写法补一条 2→3 的理由：截断后写入的条目与旧条目的 `data.description` 长度语义不同，旧条目继续被读会让「磁盘命中」与「网络新取」给出不同长度的描述。

- **R1.5** 改写 `src/render.ts:30-46` 的注释。原文末句是：
  > `It is applied at render time rather than at fetch time so the stored candidate keeps its full value for scoring.`

  这句是**有意识的旧决策**，本任务直接推翻它，留着不改就是让注释说谎。新注释要说明：入口已把存储截到 512（`src/github.ts` 的 `MAX_STORED_DESCRIPTION_CHARS`），本常量只管**展示**预算，两者是独立旋钮。

- **R1.6** 新增测试 `test/cache-description-cap.test.mjs`，沿用两处既有惯例：
  - `test/cache.test.mjs:41-44` 的 scratch `DSH_HOME`（必须在 import 之前设置）；
  - `test/probe-guard.test.mjs:40/374` 的 `globalThis.fetch` 打桩与还原。

## 验收标准

每条都要附命令与输出。

- [ ] **AC1.1** `npm run typecheck` 无输出；`npm run build` 成功。
- [ ] **AC1.2** 桩 fetch 返回三种描述，经 `searchRepositories('x', 1, {})` 后逐条断言：
  - 241,979 字符 → `candidate.description.length === 512`；
  - 300 字符 → 与输入**逐字相等**（长度与内容都不变）；
  - 恰好 512 字符 → 未被截（长度仍 512，末字符未丢）。
- [ ] **AC1.3** 截断不折叠：输入 `'a\nb'`，输出仍含 `\n`（`=== 'a\nb'`）。
- [ ] **AC1.4** 打分不变：对一批 ≤512 字描述两两调用 `similarity(a, b)`，与「经过 `storedDescription` 之后」的结果逐对相等。此断言直接调 `lib/types.js` 与 `lib/github.js`，不经缓存。
- [ ] **AC1.5** 版本升级生效：`cacheSet` 写一条 → 把磁盘 JSON 的 `version` 改回 `2` → `cacheClearMemory()` 后 `cacheGet` 必须 miss；把 `version` 改回 `3` 后必须命中。
- [ ] **AC1.6** 真实缓存离线回放（**只读**）：读 `C:\Users\longt\.dsh\cache\dsh-find-ideas` 的 31 条 search 条目，对每条候选的 `description` 应用 512 截断后**在临时目录**重新序列化，断言：
  - 合计 **≤600 KB**（预估 514,478 B）、单条 **≤60 KB**；
  - 817 条候选的 description 字符数合计从 4,760,069 降到 **≤500,000**；
  - 原目录文件数与字节数在测试前后**完全一致**（证明只读）。
- [ ] **AC1.7** `npm test` 汇总行仍为 `24/26 test files passed, 2 skipped`，`skipped` 仍是 `baseline.test.mjs, stage2.test.mjs`；**新增测试文件后变成 `25/27 ... 2 skipped`**（`test/run-all.test.mjs:25-27` 动态发现，不需注册）。
  - **不要看终端最后一行 `45 PASS / 0 FAIL`**：`run-all` 用 `stdio: 'inherit'`，最后那行是 `translation-routing.test.mjs` 自己的小计，不是套件总计。套件 PASS 总数要逐文件求和（基线 **6377**）。
- [ ] **AC1.8** 渲染层未变：`test/render-budget.test.mjs` 全绿，`MAX_DESCRIPTION_CHARS` 仍是 200。
- [ ] **AC1.9** 一个独立 commit（`perf(cache): truncate stored descriptions at 512 chars`）；`git revert <sha>` 后 `npm test` 回到 `24/26 passed`、逐文件求和 **6377 PASS**。

## 已知的行为变化（必须写进 commit message）

- 超过 512 字的描述，渲染出的「（描述过长，原长 N 字符）」里 **N 会变成 512**，不再是真实原长。原因：入口已截断，渲染层看到的就是 512 字的字符串。
  `test/render-budget.test.mjs:107` 断言 `/241979/` 出现，但它**直接调 `clipDescription`**，不经过缓存，因此不受影响——这条要写清楚，否则复核者会以为测试失效。
- `SUSPICION_QUOTE_CHARS = 120`（`src/types.ts:347`）的引用与 `similarity` 只对 **>512 字的 9% 候选**有变化。

## 不改动

- `MAX_DESCRIPTION_CHARS = 200`、`clipDescription` 实现、渲染格式、工具 schema、排序公式。
- 不折叠空白（见 R1.2）。
- 不动 `SOURCE_TTL_MS`（10 分钟）、`DISK_TTL_MS`（24h）、`MEMORY_TTL_MS`（5 分钟）。

## 风险与坑

- **不能成环**：`src/render.ts:19` 已经 `import { TAIL_STAR_CEILING } from './github.ts'`。若把截断函数放进 `render.ts` 再从 `github.ts` 引入，会形成 github→render→github 的循环。截断函数**必须留在 `github.ts` 内**（或 `types.ts`——它当前零 import，是干净叶子；但 `github.ts:19` 只有类型导入，改成值导入会新增一条运行时边，不如自建）。
- **行号漂移**：`.trellis/spec/` 有 334 处 `src/*.ts:NNN` 引用，没有任何测试校验它们。本任务改动尽量保持行数；若漂移，同一 commit 内更新并跑 `.scratch/verify-tree.mjs`，确认 `PAST EOF: 0` / `nonexistent file: 0` / `NEEDS ADJUDICATION: 0`。
- **必须先 build**：测试从 `lib/` 导入（`pathToFileURL(join(pkgRoot,'lib',rel))`），改源码后不 `npm run build` 跑的仍是旧代码。

## 回滚

`git revert <sha>` 即可。`CACHE_VERSION` 回到 2 后，3 版条目全部被当作 miss（一次 re-fetch），不会读出错值；删 `$DSH_HOME/cache/dsh-find-ideas` 永远安全。
