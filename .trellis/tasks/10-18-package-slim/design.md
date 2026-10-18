# R4 技术设计：精简 npm 包体

## 问题形状

`npm pack` 实测 91 文件 / 解包 2,073,969 B / tarball 743,374 B。其中**开发物占 60%**：

| 分组 | 文件 | 字节 | 装包用户需要吗 |
|---|---|---|---|
| `lib`（含 22 个 `.map`） | 44 | 801,157 | **是**（运行时），但 `.map` 只对调试有用 |
| `test` | 27 | 569,164 | **否** |
| `src` | 11 | 487,505 | **否**（`main` 指向 `lib`） |
| `scripts` | 3 | 22,210 | **否** |
| `docs`（1 PNG） | 1 | 173,910 | **是**（README 引用） |
| 其余 5 个 | 5 | 19,923 | 是 |

## 决策一：`.npmignore` 路线被实测否证

原计划「`files` 保留 `lib`，用 `.npmignore` 排掉 `lib/**/*.map`」。三种最小复现：

| 方案 | 配置 | 结果 |
|---|---|---|
| C | `files:["lib"]` + 根 `.npmignore` = `lib/**/*.map` | **失败**，`lib/a.js.map` 仍在包里 |
| B | `files:["lib"]` + `lib/.npmignore` = `*.map` | 通过 |
| A | `files:["lib/**/*.js","lib/**/*.d.ts"]` | 通过 |

方案 B 有效但**不可用**：`.gitignore` 忽略了 `lib/`，`lib/.npmignore` 永远进不了 git —— 换台机器 clone 下来打包就退化。这是决定性否决理由，不是偏好问题。

**方案 A 胜出**：不改 `tsconfig.json`、不新增文件、`files` 字段自解释（读一眼就知道包里有什么）。

## 决策二：为什么连 `.d.ts.map` 一起删

`tsconfig.json` 开了 `declaration: true` + `declarationMap: true` + `sourceMap: true`，22 个 `.ts` 产出 4 类文件。`.map` 共 22 个（`*.js.map` 与 `*.d.ts.map` 各 11），约 198 KB。

两类 map 都指向 `../src/*.ts`。既然 `src/` 不进包，**map 留着也是断链**——删掉是自洽的，不是过度精简。本地开发仍有 map（`tsconfig.json` 不变），只有装包用户失去「堆栈映射回 TS 源码」这一能力，代价可接受。

## 决策三：`src/` 和 `test/` 一起删的连带影响

- `src/` 删掉后，包内没有任何 TS 源码。`exports` 只暴露 `./lib/index.js` 与 `./lib/index.d.ts`，**不影响任何 import**。
- `test/` 删掉后，装包用户跑 `npm test` 会 `ENOENT`。这是预期——`npm test` 是**仓库**开发命令。
- `README.md:87-93` 列了 `npm run build` / `npm test` / `test/` 下 27 个文件。这些描述对装包用户已经失真，但父任务把「不改 README 正文」列为 Out of Scope，本任务只记录，不擅自改文案。

## 决策四：`docs/*.png` 必须留

`README.md:53` 与 `README.zh.md:53` 都是 `![](docs/dsh-find-ideas-architecture.png)`。npm 页面会把 README 渲染出来，删图就是坏图。173,910 B 换一张能在 npmjs.com 正常显示的架构图，值。

## 决策五：`scripts` 字段不动

`scripts.prepare = "npm run build"` —— 删 `scripts` 会让 `npm pack` 不再自动 build，也破坏仓库开发流程。`files` 里已经排除了 `scripts/` **目录**，但 `package.json` 的 `scripts` **字段**是另一回事，两者无关。

## 决策六：glob 用 `lib/**/*.js` 而非 `lib/*.js`

`lib` 目前是平铺的，两者等价。用 `**` 是为将来加子目录时不静默漏文件。

**代价**：若 `lib` 将来出现非 `.js` / `.d.ts` 的运行时资产（如 `.json` 配置），方案 A 会静默漏掉。这是本方案唯一的长期脆弱点，需写进 commit message 与父任务笔记，`package.json` 不支持注释无法就地提示。

## 精确预估（用真实 `lib/` 内容 + 方案 A 实跑）

| 指标 | 现状 | 预估 | 降幅 |
|---|---|---|---|
| 文件数 | 91 | **28** | −69% |
| 解包字节 | 2,073,969 | **792,487** | −62% |
| tarball | 743,374 | **386,767** | −48% |

28 文件构成：`lib/*.js` 11 + `lib/*.d.ts` 11 + `LICENSE` + `README.md` + `README.zh.md` + `cordis.patch.yml` + `package.json` + `docs/*.png`。

**注意余量很薄**：相对父任务 AC5 的阈值（≤30 文件 / ≤800 KB / ≤400 KB），分别只剩 2 文件、1%、3%。任何一项超标都要先查是不是误带了新文件，**不是放宽阈值**。

## 决策七：可用性验证必须在仓库内做

实测两次：

- `$env:TEMP\slim-probe` 下 `import('./lib/index.js')` → `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`。原因是 peerDependency 不在临时目录的解析路径上，**与精简无关**。
- 仓库内 `.scratch/pack-probe/node_modules/dsh-find-ideas` 下同法 import + `apply({tools:{register}})` → 成功注册 `scout_projects`、`rank_candidates`、`inspect_projects`。

→ AC4.4 必须写明「在能向上解析到仓库 `node_modules` 的目录做」，否则会得到假失败并误导判断。

## 契约不变项

- `main` / `types` / `exports` / `dsh.bundle.patch`。
- `tsconfig.json` 的三个 map 开关（本地开发仍有 map）。
- `dependencies: {}` 与 `peerDependencies` 的版本 range。
- `scripts` 字段与 `prepare`。
