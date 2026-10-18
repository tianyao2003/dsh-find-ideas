# R4 执行计划：精简 npm 包体

> 依赖：**R1–R3 全部 commit 已落地**（打包的是最终 `lib/`）。预估改动：`package.json` 的 `files` 一个字段。

## 步骤

### S1 — 建基线

```powershell
$env:npm_config_cache = Join-Path $env:TEMP 'npm-cache-probe'
npm pack --dry-run --json | Out-File -Encoding utf8 .scratch\pack-before.json
```

**验收**：`.scratch\pack-before.json` 里 `entryCount === 91`、`unpackedSize === 2073969`、`size === 743374`。

> **坑**：`npm pack` 会触发 `prepare` → `npm run build`，所以必须先有可编译的 `src/`。R1–R3 完成后应已跑过。
> **坑**：本机 npm cache 目录 `C:\Users\longt\AppData\Local\npm-cache\_logs` 不可写会让 `npm pack` 失败，故重定向。

### S2 — 改 `files`

`package.json`：

```json
"files": [
  "lib/**/*.js",
  "lib/**/*.d.ts",
  "cordis.patch.yml",
  "README.md",
  "README.zh.md",
  "LICENSE",
  "docs/dsh-find-ideas-architecture.png"
]
```

去掉 `"lib"`、`"src"`、`"test"`、`"scripts"`。**只改这一个字段，不动 `scripts` / `main` / `types` / `exports` / `dependencies`。**

**验收**：`node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` 不抛错（JSON 合法）。

### S3 — 打包并核对体积

```powershell
npm pack --dry-run --json | Out-File -Encoding utf8 .scratch\pack-after.json
```

**验收**（三条都必须满足）：

- `entryCount ≤ 30`（预估 28）
- `unpackedSize ≤ 810000`（预估 792,487，实测 805,009）
- `size ≤ 400000`（预估 386,767，实测 391,681）

### S4 — 核对清单内容

```powershell
$p = Get-Content .scratch\pack-after.json -Raw | ConvertFrom-Json
$p.files.path -join "`n" | Set-Content .scratch\pack-after-paths.txt
```

三条独立 grep：

```powershell
Select-String -Path .scratch\pack-after-paths.txt -Pattern '^(src|test|scripts)/'   # 必须无输出
Select-String -Path .scratch\pack-after-paths.txt -Pattern '\.map$'                # 必须无输出
Select-String -Path .scratch\pack-after-paths.txt -Pattern 'docs/dsh-find-ideas-architecture\.png'  # 必须命中
```

**验收**：前两条零命中，第三条命中；`README.md` 与 `README.zh.md` 都在清单里。

### S5 — 可用性验证（AC4.4，**仓库内**）

```powershell
$probe = ".scratch\pack-probe\node_modules\dsh-find-ideas"
if (Test-Path $probe) { Remove-Item $probe -Recurse -Force }
New-Item -ItemType Directory $probe -Force | Out-Null
npm pack --pack-destination .scratch
tar -xzf (Get-ChildItem .scratch\*.tgz | Select-Object -First 1).FullName -C $probe --strip-components=1
```

然后 `.scratch\pack-probe\check.mjs`：

```js
import { pathToFileURL } from 'node:url'
const mod = await import(pathToFileURL('./node_modules/dsh-find-ideas/lib/index.js').href)
const defs = new Map()
await mod.apply({ tools: { register: (d) => defs.set(d.name, d), get: () => undefined } })
console.log('OK tools:', [...defs.keys()].sort().join(','))
```

在 `.scratch\pack-probe` 下运行。

**验收**：打印 `OK tools: inspect_projects,rank_candidates,scout_projects`（三个，不多不少，字母序）。

> **坑**：**不要**在 `$env:TEMP` 裸目录做这一步。peerDependency `@deepseek-ai/dsh-tools` 不在解析路径上会报 `ERR_MODULE_NOT_FOUND`，那是假失败（已实测两次）。

### S6 — 全量回归

```powershell
npm run check
node test/run-all.test.mjs
```

**验收**：汇总行 `27/29 test files passed, 2 skipped`；逐文件小计求和 = **6463 PASS / 0 FAIL**（`6458` + `test/ranking.test.mjs` 新增的 5 条断言）。

> **不要看终端最后一行 `45 PASS / 0 FAIL`**：`run-all` 用 `stdio: 'inherit'`，最后那行是 `translation-routing.test.mjs` 自己的小计。要看 `^\s*\d+ PASS / \d+ FAIL\s*$` 形态的 27 行再求和。

### S7 — 提交

```powershell
git add package.json
git commit -m "build(pkg): stop shipping dev-only files and source maps"
```

commit message 正文必须写明三条取舍：source map 全部失效（`src/` 不进包，map 指向断链）；包内 README 提到的 `test/`、`scripts/` 路径不存在；装包后 `npm test` 不可用。以及一条长期脆弱点：`lib/` 若出现非 `.js`/`.d.ts` 的运行时资产会被静默漏掉。

**验收**：`git log -1 --stat` 只含 `package.json`（外加本任务重写的 `test/ranking.test.mjs`——见执行记录）；`git revert --no-commit <sha>` 后 `npm pack --dry-run --json` 回到 94 文件 / 2,137,053 B / tarball 760,174 B，再 `git reset --hard`。

## 执行记录（实际落地与计划的差异）

| 项目 | 计划 | 实际 | 原因 |
|---|---|---|---|
| S1 基线 | 91 文件 / 2,073,969 B | **94 文件 / 2,137,053 B / tarball 760,174 B** | R1–R3 新增了 3 个测试文件，旧 `files` 把整个 `test/` 打进包，基线随代码增长。（2,138,731 B 是「旧 `files` + 新 ranking 断言」的数字；S1 真实基线用完整 revert 实测的 2,137,053 B） |
| S3 解包体积 | ≤ 800,000 B（预估 792,487） | **805,009 B** | 预估按设计当时的 `lib/`（801,157 B）算；R1–R3 让 `lib/` 长到 818,027 B（+16,870 B / 281 行）。经用户批准阈值改为 **810,000 B**，排查过程见 `prd.md` AC4.1 |
| S3 tarball | ≤ 400,000 B（预估 386,767） | **391,681 B** | 同上，随 `lib/` 增长；阈值未动，仍通过 |
| S4 清单核对 | 三条 grep | 三条均符合（`^(src\|test\|scripts)/` 零命中、`\.map$` 零命中、`docs/*.png` 命中） | — |
| S5 可用性 | 三工具注册齐全 | 通过（`inspect_projects,rank_candidates,scout_projects`） | — |
| S6 回归 | 逐文件求和「≥ 6377 + R1–R3 新增」 | **= 6463**（6458 + 5） | 本任务**确实改了一个测试文件**（非新增）：`test/ranking.test.mjs:488` 对 `files` 做精确字符串成员判断，改 glob 后必然误报。已按真实语义重写为「每个声明入口至少被一个 glob 覆盖」，断言数 1 → 5 |
| S7 提交 | `git add package.json` | `package.json` + `test/ranking.test.mjs` | 见上一行；不重写该断言则套件红 |
| 架构图压缩 | （不在计划内） | **未做** | 实测无损重编码只省 2,294 B（1.3%）仍超限；256 色调色板能降到 72,494 B 但 `pixel-identical: False`（最大通道差 62/255），属有损。用户选择「改阈值 + 记录理由」，不动图片 |

**结论**：唯一超出原计划的是「解包体积」与「回滚基线」两个数字，两者都由 R1–R3 的代码增长解释，不是打包缺陷；唯一的计划外代码改动是 `test/ranking.test.mjs` 的断言重写，它由 `files` 改 glob 直接逼出。

## 回滚点

| 位置 | 动作 |
|---|---|
| S2 之后 | `git checkout -- package.json` |
| S7 之后 | `git revert <sha>`，重新 `npm pack` 即恢复 94 文件 / 2,137,053 B / tarball 760,174 B（旧 `files` 的全部内容；已实测） |

## 复核红灯（出现即停下问）

- `entryCount` 突然变大 → `files` glob 写错（如漏了 `*.d.ts` 又误加了目录），先看清单差在哪。
- `unpackedSize` 超 810 KB → 先查是不是 `.map` 没排干净（`grep '\.map$'`），再查 `lib/` 是否新增了非 `.js`/`.d.ts` 资产。**不要直接放宽阈值**——本次改阈值是因为原估算基于旧 `lib/`，不是因为有文件误带。
- `import` 报 `ERR_MODULE_NOT_FOUND` → 先确认是不是在裸临时目录跑的；若是仓库内还报，检查 `exports` 是否被误改。
- 三工具只注册出两个 → `apply` 的桩写错（`register` 签名不对），不是包的问题。
