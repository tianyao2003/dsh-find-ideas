# R1 执行计划：入口截断 description

> 依赖：无（第一个做）。预估改动：`src/github.ts` +12 行、`src/cache.ts` +8 行注释、`src/render.ts` 注释改写、新增 1 个测试文件。

## 步骤

### S1 — 建基线（不改代码）

```powershell
git status --short          # 期望：只有 .trellis/tasks/10-18-*/ 未跟踪
npm run build               # 确保 lib/ 与 src/ 同步
node test/run-all.test.mjs  # 记录 24/26 passed 与逐文件小计
```

**验收**：把逐文件 PASS 小计存进任务笔记，作为 AC1.7 的对照基线（父任务 PRD 有完整表）。

### S2 — 加截断函数

改 `src/github.ts`，在 `toCandidate`（`:436`）**之前**插入：

```ts
/** Stored descriptions are capped here; the render layer's 200-char budget is separate. */
const MAX_STORED_DESCRIPTION_CHARS = 512

/** Cap a description for STORAGE. Truncation only — never folds whitespace. */
function storedDescription(raw: string): string {
  return raw.length > MAX_STORED_DESCRIPTION_CHARS ? raw.slice(0, MAX_STORED_DESCRIPTION_CHARS) : raw
}
```

再把 `:444` 改成 `description: storedDescription(String(item.description ?? '')),`。

**验收**：`npm run typecheck` 无输出。

### S3 — 升 CACHE_VERSION

`src/cache.ts:23` 改 `const CACHE_VERSION = 3`，并在 `:12-22` 的注释块末尾补一段 2→3 的理由（照 1→2 的写法：说明 `data.description` 长度语义变了，旧条目继续读会让磁盘命中与网络新取给出不同长度）。

**验收**：`npm run build` 成功；`grep CACHE_VERSION src/cache.ts` 只出现一处定义。

### S4 — 改写 render.ts 的旧注释

`src/render.ts:30-46` 末句 `It is applied at render time rather than at fetch time so the stored candidate keeps its full value for scoring.` 必须替换。新注释说明两点：入口已截到 512（指向 `MAX_STORED_DESCRIPTION_CHARS`）；本常量只负责**展示**预算。**只改注释，不动 `MAX_DESCRIPTION_CHARS` 与 `clipDescription` 的任何代码。**

**验收**：`git diff src/render.ts` 只有注释行变动（`git diff --stat` 显示增删行数相等或近似）。

### S5 — 写测试 `test/cache-description-cap.test.mjs`

结构照 `test/cache.test.mjs`：**先** `process.env.DSH_HOME = mkdtempSync(...)`，**再** `await import(...)`。fetch 打桩照 `test/probe-guard.test.mjs`（存 `realFetch`，`finally` 还原）。

必须覆盖 AC1.2–AC1.5 四条：三种长度、不折叠空白、`similarity` 不变、版本 2 失效 / 3 命中。

**验收**：`node test/cache-description-cap.test.mjs` 全 PASS。

### S6 — 离线回放真实缓存（AC1.6）

`.scratch/replay-cap.mjs`（`.gitignore` 已忽略 `.scratch/`）：只读 `$env:DSH_HOME\cache\dsh-find-ideas`，对每条 `data.candidates[].description` 应用截断，在**临时目录**重新序列化并统计。**绝不写回原目录。**

**验收**：合计 ≤600 KB、单条 ≤60 KB、原目录前后文件数与字节数完全一致。

### S7 — 全量回归

```powershell
npm run check
node test/run-all.test.mjs
```

**验收**：汇总行 `25/27 test files passed, 2 skipped`；逐文件小计求和 ≥ 6377（新增文件的 PASS 另计）；`test/render-budget.test.mjs` 仍全绿。

### S8 — 提交

```powershell
git add -A
git commit -m "perf(cache): truncate stored descriptions at 512 chars"
```

commit message 正文必须写明两条行为变化：>512 字的描述渲染时「原长 N」变成 512；`render-budget.test.mjs:107` 因直调 `clipDescription` 而不受影响。

**验收**：`git log -1 --stat` 只含预期文件；`git revert --no-commit <sha>` 后 `npm test` 回到 24/26，再 `git revert --abort` 或 `git reset --hard`。

## 回滚点

| 位置 | 动作 |
|---|---|
| S2–S4 之间 | `git checkout -- src/` |
| S8 之后 | `git revert <sha>`；运行时 3 版条目全变 miss，一次 re-fetch |

## 复核红灯（出现即停下问）

- `npm run typecheck` 报 `toCandidate` 相关类型错误 → 说明 `storedDescription` 放错位置或签名不对。
- `test/cache.test.mjs` 挂了 → 极可能是 `CACHE_VERSION` 改动与既有 C0 断言冲突（C0 校验 `version` 字段）。先看 C0 是否硬编码了 `2`。
