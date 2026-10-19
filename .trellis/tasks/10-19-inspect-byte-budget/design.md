# 技术设计：两段式漏斗与返回字节裁剪

> 配套 `prd.md`。本文档说明**怎么改**：每一刀的落点、数据流、红线与失败模式。
> 所有数字来自 `.scratch/ab-*.cjs` 在 12 份真实 dump 上的实测，不是估算。

## 0. 数据流现状（改动前）

```
inspect_projects.execute(args)
  ├─ inspectOne(fullName, budget, options)          src/index.ts:553
  │    ├─ getReadme()            → readmeExcerpt    （readmeChars = 4000/12000）
  │    ├─ getTree()              → tree.entries
  │    ├─ pickArchitectureFiles(entries, maxFiles)  src/select.ts:321
  │    │    └─ 过滤 LICENSE/CHANGELOG/lockfile/二进制/…  → 4 或 8 个 path
  │    └─ for path of files:                        src/index.ts:639-644
  │         const file = await getFile(...)
  │         const excerpt = file.text.slice(0, EXCERPT_WINDOW_CHARS)   // 1200
  │         excerpts.push({ path, text: excerpt })   ← 原样吐出（全文）
  │         skeletons.push(renderSkeleton(path, scanSignatures(path, excerpt)))
  │                                                   ← 同一个窗口再解析成签名
  └─ renderInspections(idea, inspections, degraded, cached)   src/render.ts:969
       ├─ preamble（banner 4 行）
       ├─ per repo:
       │    📦 header + 读取文件（N）全路径列表
       │    [骨架：文件头局部声明证据]   ← 每文件 5 行免责话
       │    [依赖清单摘录]
       │    [README 摘录]                ← 第 1 次
       │    [结构信息]                    ← 文件摘录：README 第 2 次 + 每文件 1200 字原文
       └─ footer（3 行 + 降级提示）
```

**冗余的根因有三处**，都在 `src/index.ts`：

1. `excerpts` 与 `skeletons` 吃同一个 1200 字符窗口（`639-644`），路径重合 94%。
2. `readmeExcerpt` 与 `excerpts` 里的 README 各渲染一遍（`render.ts:1018` 与 `1023`）。
3. `renderSkeleton` 每个文件都完整输出 5 行免责话（`render.ts:828`），
   201 个文件条目 → 115.2K 的重复。

## 1. M1 去冗余（4 刀，逐刀可核对）

### C1 — README 只输出一次（−75.9K）

**改哪里**：`src/index.ts` 的 `inspectOne`，在 `files` 循环里判断路径是否根 README。

```ts
// 现在
const excerpt = file.text.slice(0, EXCERPT_WINDOW_CHARS)
excerpts.push({ path, text: excerpt })

// 改成
const isReadme = isRootReadme(path)          // src/select.ts 里已有同类判定可复用
const excerpt = file.text.slice(0, EXCERPT_WINDOW_CHARS)
excerpts.push(
  isReadme
    ? { path, text: README_ALREADY_SHOWN }   // 单行占位，不吐正文
    : { path, text: excerpt },
)
skeletons.push(renderSkeleton(path, scanSignatures(path, excerpt)))
```

**关键点**：签名扫描仍用**完整 1200 字符窗口**，只是不再把原文吐出去。
`scanSignatures` 的输入不变，所以骨架段的声明结果逐字不变（AC2.2）。

`README_ALREADY_SHOWN` 是一行明确的话，不是空串：

```
（正文见上方 [README 摘录]，此处不再重复）
```

空串会让读起来像"这个文件是空的"，而事实是"已在上方给过"。

### C2 — README 摘录取正文首段（−94.7K）

**改哪里**：`src/render.ts`，新增纯函数 `extractReadmeLead(md, maxChars)`，
在 `inspectOne` 里对 `readmeExcerpt` 施加，或直接在渲染层施加（**选渲染层**，
理由见下）。

**为什么放渲染层而不是抓取层**：`INSPECT_BUDGET[depth].readmeChars`（4000/12000）
同时决定"抓多少"和"吐多少"。抓取层保留大值（缓存里存完整摘录，
`read_repo_files` 与未来的分析仍可用），展示层用 `README_LEAD_CHARS = 400`。
这样缓存语义不变（不需要 bump `CACHE_VERSION`），而返回字节照样降。

**跳过规则**（按顺序，逐行判定）：

| 形态 | 判据 |
|---|---|
| 标题行 | `/^\s{0,3}#{1,6}\s/` |
| 徽章行 | 含 `[![` / `![` / `<img` / `shields.io` / `badge` |
| HTML 注释 | `/^\s*<!--/` 到 `-->/` |
| 纯链接行 | 整行只有 `[...](...)` 或 `<https://...>` |
| license 声明 | `/^\s*(license\|licence\|copyright\|©)/i` |
| 分隔线 | `/^\s*([-*_]\s*){3,}$/` |
| 空行 | 跳过但**不终止**（段落分隔） |

取**第一个非跳过行开始、连续到下一个空行**的段落；若该段落超过 `maxChars`，
按句末标点（`。！？.!?`）就近截断，保留标点。

**失败模式（必须显式处理）**：整篇只有标题和徽章时，返回

```
（README 前 N 行只有标题与徽章，没有正文段落）
```

不得返回空串。这是 `declaration-honesty` 那类"零命中≠没有"的同一原则。

### C3 — 骨架免责话每卡一次（−60.1K）

**改哪里**：`src/render.ts:828` `renderSkeleton(path, hits)` 保持不动
（它的单文件契约被 `test/render-table.test.mjs` T8–T12 钉住），
**新增** `renderSkeletonCard(entries: { path, hits }[]): string` 作为渲染入口，
`renderInspections` 改为调它。

**新格式**：

```
   [骨架：文件头局部声明证据]
   ```
   │ 本卡 4 个文件：2 个有声明（7 条），1 个扫了 0 声明，1 个扩展名不在覆盖内（.lua）
   │ · src/main.ts
   │   class `Server` — #L12
   │   function `boot` — #L40
   │ · src/router.ts
   │   function `route` — #L8
   │ · src/store.lua
   │   （扩展名不在扫描器覆盖内：本文件没有被看过，不是"没有声明"）
   │ · src/util.ts
   │   （文件头 1200 字符窗口内零声明；窗口可能被 import 块占满，不代表文件主体没有函数）
   ── 说明：这是文件头局部声明证据，不是完整架构；窗口只有文件开头的 1200 字符，
      版权头与 import 常常就把它填满，文件主体里的类/函数通常不在窗口内，
      因此零命中不代表该仓库没有类或函数；签名列表也推不出依赖方向、调用链或进程边界。
   ```
```

**红线**：`SKELETON_DISCLAIMER` 常量仍必须出现在**每一个分支**上
（`test/render-table.test.mjs:378/393` 断言 `branches.every((b) => b.includes(SKELETON_DISCLAIMER))`）。
新的卡级渲染只在末尾输出一次，单文件渲染函数保留原有行为，测试因此不需要改断言方向，
只需把 T12 的"每文件一次"改成"每卡一次"。

### C4 — 零声明 / 不支持扩展名压计数行（−53.7K）

与 C3 同一处实现，单独 commit 是为了瀑布账可核对（C3 砍重复话术，C4 砍重复条目）。
C4 的额外动作是把**没有声明内容的文件条目**从"3 行/文件"压成"1 行/文件"，
并把计数提前到卡头（见上面格式的 `本卡 N 个文件：…`）。

## 2. M2 漏斗化（2 刀 + 1 个新工具 + 1 个上限参数）

### C7 — 非源码摘录只列路径（−101.3K）

**判据**：`src/select.ts:138` 的 `SOURCE_EXT_RE` 之外即非源码。
实测分布：`.md 50 / .json 11 / .toml 11 / .mod 8 / .txt 3 / 无扩展名 1`。

**折中**：非 README 的 `.md` 保留**首行标题**（`# Title`），不吐正文。
理由是"这个项目有哪些文档"本身是信息，而文档正文不是源码证据。

### C8 — 扫描器不认识的源码也只列路径（−26.2K）

**判据**：`SOURCE_EXT_RE` 认识但 `FAMILY_BY_EXT` 不认识 —— 差 24 个扩展名，
实测命中 `.lua 10 / .swift 3 / .rb 2 / .sh 1 / .cpp 1 / .h 1 / .vue 1`（共 19 个文件、23.3K）。

这些文件**列路径 + 明确标注"本文件没有被扫描"**，不吐原文。

### C9 — 新增 `read_repo_files`（第二段点读）

```ts
read_repo_files({
  repo: 'owner/name',              // 必填
  paths: ['src/main.ts', '…'],     // 必填，1–4 个
  focus: 'job queue persistence',  // 可选
  max_bytes: 8000,                 // 可选，默认 8000
})
```

**返回结构**（每文件）：

```
📄 src/main.ts  （sha 4f2a…c1，1200 字符窗口）
   https://github.com/owner/name/blob/4f2a…c1/src/main.ts#L1-L38
   ```
   │ <窗口原文>
   ```
```

`focus` 命中时：在文件里找 focus 的关键词（复用 `src/query.ts` 的分词），
命中行的前后 ±40 行作为窗口，链接的 `#L` 段指向该窗口。

**sha 的来源**：`TreeEntry` 目前没有 sha。`src/github.ts` 的 `getTree` 已经拿到
GitHub tree API 的 `sha` 字段，但 `toTreeEntry` 丢弃了。补一个可选字段即可
（可选字段不需要 bump `CACHE_VERSION`，`src/cache.ts:127-139` 的注释解释了原因）。

**拒绝而非丢弃**（沿用 inspect 的既有契约）：非法 repo、含 `..` 的路径、
超过 4 个 path、超过 `max_bytes` 的单文件 —— 一律 `degraded.reason` 说明规则，
`test/instruction-isolation.test.mjs` 的同类断言可以直接复用。

### C10 — `budget_bytes`（默认 24000）

**裁剪顺序**（先砍最不影响判断的）：

1. `[依赖清单摘录]` 压到 15 行（已经是 `untrustedBlock(..., 15)`）
2. `[README 摘录]` 从 400 字降到 200 字
3. 骨架段：每文件只留"有声明"的条目，零声明条目并入卡尾计数
4. 仍超限：每仓库只保留 `files_read` + 卡头计数，逐仓库提示"已裁剪，用 `read_repo_files` 补读"

**输出必须明说**：被裁剪时追加一行

```
   ⚠️ 本次返回已按 budget_bytes=24000 裁剪（原始 41.2K → 24.0K）：省略了 3 个文件的摘录，
      需要时用 read_repo_files(repo="owner/name", paths=["src/a.ts"]) 补读。
```

**默认路径不变**：未超限时输出必须逐字节等于无该参数时（AC4.2），
这样 C1–C8 的瀑布账不被 C10 污染。

## 3. 改动清单（文件级）

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/index.ts` | `inspectOne` 的 excerpt 分流；新工具注册；`budget_bytes` 参数 | 中：新工具与参数 |
| `src/render.ts` | 新增 `extractReadmeLead`、`renderSkeletonCard`；`renderInspections` 改调用 | 高：被 3 个测试文件钉住 |
| `src/skeleton.ts` | 导出 `isScannedExt` 之类判据；`FAMILY_BY_EXT` 不动 | 低 |
| `src/select.ts` | 导出 `isSourcePath` / `isRootReadme` 判据（若已有则复用） | 低 |
| `src/github.ts` | `TreeEntry` 加可选 `sha`；`getFile` 返回 sha | 低（可选字段） |
| `src/types.ts` | `Inspection` 若需新字段（如 `excerpts_elided`） | 低 |
| `test/render-table.test.mjs` | T8–T12 断言方向改为"每卡一次" | 中：改动既有断言 |
| `test/*.test.mjs` | 新增 `read_repo_files` 与 `budget_bytes` 的覆盖 | 低 |

## 4. 失败模式与对策

| 失败模式 | 对策 |
|---|---|
| 裁剪后 agent 不知道哪些文件被折叠 | 每个被折叠的文件仍在 `files_read` 里；卡头给计数；`budget_bytes` 触发时给补读示例 |
| 抽不出 README 段落被读成"README 是空的" | 显式返回"只有标题与徽章"的说明句 |
| 零声明被读成"没有函数" | 卡尾计数行保留"窗口内零声明 ≠ 文件没有函数"的措辞 |
| 新工具被滥用（一次读 20 个文件） | 硬上限 4 个 path + 8KB，超限拒绝并说明 |
| 默认路径被 `budget_bytes` 改变 | AC4.2 逐字节断言 |
| 骨架段测试大面积红 | C3/C4 分两个 commit，红的时候知道是哪一刀 |

## 5. 验收方法

```bash
# 1. 反解析 12 份真实 dump → Inspection[]
node .scratch/ab-fixture-inspections.cjs

# 2. 用改后的 renderInspections 重渲染，输出对比表
node .scratch/ab-fixture-inspections.cjs --compare

# 3. 质量检查
npx tsc --noEmit && npx tsc && node test/run-all.test.mjs

# 4. README 示例同步
npm run readme:sample && npm run readme:check
```

夹具的期望输出（逐刀累计）：

| 阶段 | 总字节 | 单次均值 | 相对基线 |
|---|---:|---:|---:|
| 基线 | 593.0K | 49.4K | 1.00× |
| C1 | 517.1K | 43.1K | 0.87× |
| C2 | 422.4K | 35.2K | 0.71× |
| C3 | 362.3K | 30.2K | 0.61× |
| C4 | 308.7K | 25.7K | **0.52×** |
| C7 | 207.3K | 17.3K | 0.35× |
| C8 | 181.1K | 15.1K | **0.31×** |
