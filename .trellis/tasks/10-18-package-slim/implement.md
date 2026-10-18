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
- `unpackedSize ≤ 800000`（预估 792,487）
- `size ≤ 400000`（预估 386,767）

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

**验收**：汇总行 `27/29 test files passed, 2 skipped`（与 R3 完成后一致，本任务不加测试文件）；逐文件求和 ≥ 6377 + R1–R3 新增。

### S7 — 提交

```powershell
git add package.json
git commit -m "build(pkg): stop shipping dev-only files and source maps"
```

commit message 正文必须写明三条取舍：source map 全部失效（`src/` 不进包，map 指向断链）；包内 README 提到的 `test/`、`scripts/` 路径不存在；装包后 `npm test` 不可用。以及一条长期脆弱点：`lib/` 若出现非 `.js`/`.d.ts` 的运行时资产会被静默漏掉。

**验收**：`git log -1 --stat` 只含 `package.json`；`git revert --no-commit <sha>` 后 `npm pack --dry-run --json` 回到 91 文件，再 `git reset --hard`。

## 回滚点

| 位置 | 动作 |
|---|---|
| S2 之后 | `git checkout -- package.json` |
| S7 之后 | `git revert <sha>`，重新 `npm pack` 即恢复 91 文件 |

## 复核红灯（出现即停下问）

- `entryCount` 突然变大 → `files` glob 写错（如漏了 `*.d.ts` 又误加了目录），先看清单差在哪。
- `unpackedSize` 超 800 KB → 十有八九是 `.map` 没排干净，`grep '\.map$'` 确认。
- `import` 报 `ERR_MODULE_NOT_FOUND` → 先确认是不是在裸临时目录跑的；若是仓库内还报，检查 `exports` 是否被误改。
- 三工具只注册出两个 → `apply` 的桩写错（`register` 签名不对），不是包的问题。
