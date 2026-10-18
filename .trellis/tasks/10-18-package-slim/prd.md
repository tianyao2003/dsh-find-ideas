# dsh-find-ideas：精简 npm 包体（R4）

> 父任务：`.trellis/tasks/10-18-cache-footprint-opt`（R4）。
> 顺序：依赖 **R1–R3 全部完成**（要打包的是最终 `lib/`）。

## Goal

`files` 收了 `src` / `test` / `scripts`，加 `lib/**/*.map`，合计约占解包 2.07 MB 的 60%。把它们去掉，保留 README 架构图，并验证打包后的插件**仍能 import 并注册三个工具**。

## 实测基线（`npm pack --dry-run --json`，2026-10-18）

| 分组 | 文件数 | 字节 |
|---|---|---|
| `lib` | 44 | 801,157 |
| `test` | 27 | 569,164 |
| `src` | 11 | 487,505 |
| `scripts` | 3 | 22,210 |
| `docs`（1 张 PNG） | 1 | 173,910 |
| `LICENSE` / `package.json` / 两个 README / `cordis.patch.yml` | 5 | 19,923 |
| **合计** | **91** | **2,073,969**（tarball 743,374） |

`lib` 的 44 个文件里 **22 个是 `*.map`**（11 个 `.js.map` + 11 个 `.d.ts.map`），合计约 198 KB。

## 方案选择（已实测，不要重新试错）

三种候选，最小复现结果：

| 方案 | 做法 | 结果 |
|---|---|---|
| **A** | `files` 改成显式 glob：`lib/**/*.js`、`lib/**/*.d.ts` | **通过**，`.map` 被排除 |
| B | `files:["lib"]` + 在 `lib/` 内放 `.npmignore` 写 `*.map` | 通过，但 **`lib/` 被 `.gitignore` 忽略 → `.npmignore` 进不了 git**，不可选 |
| C | 根 `.npmignore` 写 `lib/**/*.map` | **失败**：`files` 列出目录时根 `.npmignore` 不生效 |

→ **采用方案 A**。不新增文件、不改 `tsconfig.json`、`files` 自解释。

## 需求

- **R4.1** `package.json` 的 `files` 改为：
  ```json
  ["lib/**/*.js", "lib/**/*.d.ts", "cordis.patch.yml", "README.md", "README.zh.md",
   "LICENSE", "docs/dsh-find-ideas-architecture.png"]
  ```
  去掉 `src`、`test`、`scripts`；`lib` 由目录改为两条 glob。

- **R4.2** **保留** `docs/dsh-find-ideas-architecture.png`：`README.md:53` 与 `README.zh.md:53` 都 `![](docs/dsh-find-ideas-architecture.png)`，删了就是坏图。

- **R4.3** `scripts` 字段**不动**（`npm test` / `npm run check` 是仓库开发者用的，包内保留字段无害，删字段会连带 `prepare` 失效）。

- **R4.4** 打包后必须仍可用：`import` 成功、`apply({ tools: { register } })` 注册出恰好 `scout_projects`、`rank_candidates`、`inspect_projects` 三个工具。

## 验收标准

- [ ] **AC4.1** `npm pack --dry-run --json` 输出：`entryCount ≤ 30`、`unpackedSize ≤ 800,000`、`size ≤ 400,000`。
  **实测预估：28 文件 / 792,487 B / 386,767 B —— 三项分别只剩 2 / 1% / 3% 余量**，任何一项超标都必须先查是不是误带了新文件，而不是放宽阈值。
- [ ] **AC4.2** 清单里 **不含** 任何 `src/`、`test/`、`scripts/` 路径，**不含** 任何 `*.map`。两条独立证据，分别 grep 清单。
- [ ] **AC4.3** 清单里 **含** `docs/dsh-find-ideas-architecture.png` 与两个 README。
- [ ] **AC4.4** 可用性（**必须在仓库内做，不能在 `$env:TEMP` 裸目录**）：
  - 把 `npm pack` 产出的 tarball 解到 `node_modules/dsh-find-ideas`（或 `.scratch/pack-probe/node_modules/dsh-find-ideas`，能向上解析到仓库 `node_modules`）；
  - `import` 后调 `apply({ tools: { register: (d) => defs.set(d.name, d), get: () => undefined } })`；
  - 断言 `[...defs.keys()]` 排序后等于 `['inspect_projects','rank_candidates','scout_projects']`。
  - **坑**：在 `$env:TEMP` 裸目录里做会得到 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-tools`——那是 peerDependency 不在解析路径上，**不是精简导致的**。已实测两次确认。
- [ ] **AC4.5** `npm run check` 全绿；`npm test` 汇总行应为 `27/29 test files passed, 2 skipped`（与 R3 完成后一致——本任务不加测试文件，只改 `package.json` 的 `files`）；逐文件小计求和 ≥ **6377 PASS / 0 FAIL**（逐文件明细见父任务 PRD）。
  - **不要看终端最后一行 `45 PASS / 0 FAIL`**：`run-all` 用 `stdio: 'inherit'`，最后那行是 `translation-routing.test.mjs` 的小计。
- [ ] **AC4.6** 一个独立 commit（`build(pkg): stop shipping dev-only files and source maps`）；`git revert <sha>` 后 `npm pack --dry-run --json` 回到 91 文件 / 2,073,969 B。

## 已知取舍（写进 commit message）

- **source map 全部失效**：`lib/*.js.map` 与 `lib/*.d.ts.map` 都指向 `../src/*.ts`。既然 `src/` 不再进包，两类 map 留着也是断链——所以一起删是自洽的，不是过度精简。代价：装包用户在堆栈里看到 `lib/index.js:1234` 而不是 TS 源码行。
- **包内 README 提到的 `test/`、`scripts/` 路径不存在**：`README.md:87-93` 列了 `npm run build` / `npm test` / `test/` 下 27 个文件。这些是**仓库**的开发说明，装包用户不会执行。父任务已把「不改 README 正文」列为 Out of Scope，此处只记录取舍，不擅自改文案。
- **装包后 `npm test` 不可用**：`test/` 不在包里，`npm test` 会 ENOENT。属预期。

## 不改动

- `tsconfig.json`（`declaration` / `declarationMap` / `sourceMap` 全保留，本地开发仍有 map）。
- `main` / `types` / `exports` / `dsh.bundle.patch`。
- `dependencies: {}`、`peerDependencies` 的版本 range。
- `scripts` 字段与 `prepare`。

## 风险与坑

- **`npm pack` 会触发 `prepare` → `npm run build`**：打包前必须先有可编译的 `src/`。R1–R3 完成后 `npm run check` 应已跑过 build。
- **npm cache 目录不可写会让 `npm pack` 失败**（本机实测过：`C:\Users\longt\AppData\Local\npm-cache\_logs` 写不进去）。复现时把 cache 重定向：`$env:npm_config_cache = Join-Path $env:TEMP 'npm-cache-probe'`。
- **`files` 里的 glob 必须写 `lib/**/*.js` 而不是 `lib/*.js`**：`lib` 目前是平铺的，两者等价，但 `**` 在将来加子目录时不会静默漏文件。
- 若哪天 `lib` 出现非 `.js`/`.d.ts` 的运行时资产（如 `.json`），方案 A 会静默漏掉它——这是本方案唯一的长期脆弱点，需在 `package.json` 邻近处留一句注释（JSON 不支持注释，故写进 commit message 与 `design.md`）。

## 回滚

`git revert <sha>`。`files` 是纯打包元数据，回滚后重新 `npm pack` 即恢复 91 文件。
