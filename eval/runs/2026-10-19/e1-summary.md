# E1 检索金集实测汇总 — 2026-10-19

- 插件：v0.3.0（`eval/labels.yaml` 冻结于 plugin_version_at_label="0.3.0"）
- 金集：`eval/labels.yaml` `frozen.expected`，权威标注者 A 的 yes，共 **115 条**（12 个 idea）
- 标注一致性：κ = 0.338（240 条），AI 盲标仅用于标 `disputed`
- 本文件回答的问题：**插件默认路径（只传 idea）能不能把金集里的项目捞进候选池？**

## 1. 两处文案缺陷修复（同时被本次实测验证有效）

| 缺陷 | 位置 | 修复 | 验证 |
|---|---|---|---|
| 翻译失败六种原因被压成一句 | `src/index.ts:1008` 算了 `translationNote` 没用 | detail 改为 `translationNote === null ? refusal : `${refusal}`\n\n${translationNote}`` | A1/A2/E3 现在返回 `empty_output` |
| 翻译失败被渲染成网络故障 | `src/render.ts:348-351` 通用分支一律追加「这是网络或代理问题」 | 新增 `plan_failed` 分支，明确「不是网络问题…GitHub 一次请求都没有发出」 | 同上 |

- `npx tsc --noEmit` / `npm run build` / `node scripts/readme-sample.mjs --check` 全 EXIT=0
- `npm test` → **45 PASS / 0 FAIL**，27/29 文件通过，2 个 skip（`test/baseline.test.mjs`、`test/stage2.test.mjs`，缺 `eval/runs/` 冻结夹具）
- `.scratch/verify-copy-fix.mjs` 7 条断言全 PASS（直接 import `../lib/render.js`）

## 2. 纯中文 idea 的真实失败原因（C1 路径）

三条纯中文 idea（A1、A2、E3）在**修好文案后**重测，暴露真实原因：

```
未翻译：模型返回的内容不满足检索词要求——模型没有返回任何内容（收到：空输出）。（规则：empty_output）
```

- **不是** `llm_unavailable`：`ctx.get('llm')` 存在，插件拿到了 LLM 句柄
- **不是** `no_model_selection`：provider/model 有值，调用已发出
- **不是** `aborted` / `timeout`：没有超时中止
- **不是** `llm_error`：provider 没有报错
- **实际情况**：LLM 被成功调用但返回空 content，`src/translate.ts` 按规则判非法并拒绝。会话中途模型切换（deepseek-flash → workbuddy-ai/deepseek-v4.1-flash → step-5-preview）时尤其容易触发。

→ C1 路径下 3 个 idea 的 gold（25 条）**完全不可达**，Recall 记 n/a（不是 0，因为 0 会被误读为「检索了但没捞到」）。

## 3. E1 主表：Recall@pool（带随机基线）

> 口径：gold 占每个 20 条池子约 48%，随机抽 k 条期望命中 `|gold| × k / 20`。**Recall 必须与随机基线一起读**。

| idea | 臂 | 候选 | gold | 命中 | Recall | 随机基线 | Δ |
|---|---|---|---|---|---|---|---|
| A1 | C1 插件自译 | 0 | 7 | — | n/a | 0 | — |
| A1 | C2 keywords | 20 | 7 | 0 | 0 | 7 | −7 |
| A2 | C1 插件自译 | 0 | 5 | — | n/a | 0 | — |
| A2 | C2 keywords | 20 | 5 | 1 | 0.20 | 5 | −4 |
| B1 | C1 词表 | 20 | 4 | 1 | 0.25 | 4 | −3 |
| B1 | C2 keywords | 20 | 4 | 1 | 0.25 | 4 | −3 |
| B2 | C1 词表 | 12 | 11 | 0 | 0 | 6.6 | −6.6 |
| B3 | C1 词表 | 20 | 11 | 0 | 0 | 11 | −11 |
| C1 | C1 词表 | 20 | 13 | 2 | 0.154 | 13 | −11 |
| C2 | C1 词表 | 20 | 10 | 0 | 0 | 10 | −10 |
| D1 | C1 词表 | 20 | 13 | 0 | 0 | 13 | −13 |
| D2 | C1 词表 | 20 | 8 | 0 | 0 | 8 | −8 |
| E1 | C1 词表 | 20 | 5 | 0 | 0 | 5 | −5 |
| E2 | C1 词表 | 14 | 15 | 0 | 0 | 10.5 | −10.5 |
| E3 | C1 插件自译 | 0 | 13 | — | n/a | 0 | — |
| E3 | C2 keywords | 20 | 13 | 5 | 0.385 | 13 | −8 |

### 汇总

| 路径 | idea 数 | 候选 | gold | 命中 | Recall | 随机基线 |
|---|---|---|---|---|---|---|
| **C1 插件默认（只传 idea）** | 12 | 166 | 115 | 3 | **0.026** | 81.1 |
| C1 词表白名单（含拉丁词） | 9 | 166 | 90 | 3 | 0.033 | 81.1 |
| C1 纯中文（plan_failed） | 3 | 0 | 25 | 0 | n/a | 0 |
| **C2 调用方给 keywords** | 4 | 80 | 29 | 7 | **0.241** | 29 |

唯一命中的 3 个（C1 路径）：`0xGG/crossnote-app`（B1）、`trycompai/crm` + `melgarafael/DeskcommCRM`（C1）。

## 4. 三条失败机制（都在插件自己声明的降级提示里，只是从没人量过）

1. **`lexicon_miss`：中文功能词没有英文检索词。**
   - D1「做一个、插件」未覆盖 → 只查 `journal` + `obsidian`，返回 20 条里 19 条与 Obsidian 无关（`coreos/go-systemd`、`caj2pdf`、`ToonCrafter`、`figures4papers`）
   - D2「做一个、扩展、选中代码就能生成单元测试」未覆盖 → 只有 `vs` + `code` 两条通道，返回 `microsoft/vscode`、`code-server`、`awesome-vscode` 这类平台词
   - B3「写一个、让它能查公司内部文档」未覆盖 → 只有 `claude` + `server`，返回的全是 Claude Code 生态周边，`mcp` 单独检索为 null
   - C2「问答」未覆盖 → `confluence` 命中但 `notion`/`ai`/`personal` 全为 null
   - **关键**：插件的降级提示已明说「结果可能偏向中文描述的项目」，E1 证明这不是警告而是既成事实。

2. **`no_english_channel`：整个 idea 没有任何英文检索词。**
   - E2（agent 框架）唯一查询是中文整句「做一个支持多智能体协作和工具调用的」→ 14 条候选全是 `cirosantilli` 系列 + `funNLP`，而 gold 里 15 条有 11 条在池外未被检索到（`crewAIInc/crewAI`、`microsoft/autogen`、`openai/openai-agents-python`、`OpenBMB/ChatDev` 等全部没出现）。
   - 插件自己的文案：中文查询在任何精度下都触不到用英文自我描述的项目。

3. **`plan_failed`（empty_output）：LLM 被调用但返回空。**
   - 3/12 个 idea（25/115 = 21.7% 的 gold）完全不进入检索阶段。
   - 这是 E1 之前没被发现的 P0 级缺口：12 个 idea 里 3 个直接不可用。

## 5. C2 有效但不足

E3 用 keywords 拿到 5/13（0.385），是全表最高；A1 拿到 0/7（我给的 `screenshot search notes OCR` 里 `search` 几乎不构成约束、`notes` 为 null）；A2 1/5；B1 与 C1 持平（1/4）。

- C2 的 Recall 0.241 高于 C1 的 0.026，因为**调用方给的词恰好是词表缺的词**。
- 但这 4 个词是我临时拟的，不是受控变量。E1 的结论只能是「C2 有救、C1 不可用」，不能把 C2 的 0.241 当作产品 Recall。

## 6. 已经免费拿到的 E2 消融数据（无需另跑）

`src/translate.ts:673`：idea 里只要有一个拉丁字母就跳过翻译。所以 12 个 idea 里 9 个本来就是「无翻译」臂：

| 臂 | 覆盖 idea | gold | 命中 | Recall |
|---|---|---|---|---|
| 无翻译（词表） | 9 | 90 | 3 | 0.033 |
| 计划失败（翻译层） | 3 | 25 | 0 | n/a |

翻译层是本产品唯一能处理纯中文 idea 的机制，而它在本机环境的可用率是 0/3。

## 7. 还没做的

1. **C1 白名单 4 个 idea（B3/C1/C2/D1/D2/E1/E2）都只跑了一次**，`pass^5` / Jaccard 无法计算——GitHub 索引每天都在变，E1 定义里「重复跑」本来就要落在冻结夹具上（`test/baseline.test.mjs` / `test/stage2.test.mjs` 仍 skip）。
2. **Recall@board@10 需要 rank_candidates**，即要我先给 20 条候选逐条 relevance 0–10 + note。这是 L2b 层（判分质量），与 L2a（召回）分开测，尚未开始。
3. **E3 的长尾金集未达**：gold 13 条里 5 条命中，缺口 8 条（`omnivore-app/omnivore` 已归档、`usememos/memos`、`sissbruecker/linkding` 等）——需要 `in:readme` 第二通道验证天花板假设。
4. 未做 E3（端到端任务）、E4（故障一致性）。

## 8. 对产品决策的一句话结论

> E1 的 Recall@pool = 3/115（2.6%），随机基线 81.1/115（70.5%）——**插件的检索质量显著差于随机抽样**。原因是三个可定位、可修复的机制：翻译层在本机 0% 可用（empty_output）、词表未覆盖中文功能词、纯中文 idea 无英文通道。降级提示把这些机制都说对了，但没有任何一个数字能告诉用户「你的 gold 有 97% 没被触达」。
