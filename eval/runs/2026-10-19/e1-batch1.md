# E1 batch 1 — 2026-10-19

条件：`scout_projects` 只传 `idea`，**不传 keywords**；`limit` 默认 20。
插件版本：0.3.0。金集：`eval/labels.yaml` frozen（authority = A，115 条）。

## 逐 idea 记录

| idea | 输入特征 | 候选数 | gold 命中 | degraded | 备注 |
|---|---|---|---|---|---|
| A1 截图→可搜索笔记 | 纯中文 | 0 | — | `plan_failed` | 「拒绝执行：idea 含中文，但 keywords 未提供」 |
| A2 长视频→短视频+字幕 | 纯中文 | 0 | — | `plan_failed` | 同上 |
| B1 Next.js+Postgres local-first 笔记 | 含 Latin | 20 | 1/4 | `lexicon_miss` | 命中 `0xGG/crossnote-app`（第 6 位）；词表未覆盖「做一个」「多端同步」 |
| B2 Rust 全文搜索引擎（中文分词） | 含 Latin | 12 | 0/11 | `no_english_channel` | 唯一入查词是中文整句「写一个全文搜索引擎」 |

### B1 噪声样本（20 条里与笔记/markdown 无关的）

`iamzifei/vibethursday`、`hadiranweb/hadiran-web3`、`brittanyperera-glitch/delulu-template`、
`10xrpc-jpg/10X-RPC-WEBSITE`。入查词 `offline / note-taking / next / js / postgres / local-first`，
其中 `postgres` 单独 196k 结果，等于没有约束。

### B2 结果样本（12 条全部无关）

`fighting41love/funNLP`、`cirosantilli/china-dictatorship` 系列、`gege-circle/.github`。
无英文检索通道时，中文整句被当成一个查询词去 AND 匹配英文描述，命中必然是噪声。

## 代码路径诊断

1. `src/index.ts:996` 先跑 `translateIdea`；只有 `translationFailed` 才走 `src/index.ts:1010` 的拒绝分支，
   所以 A1/A2 的「拒绝执行」等价于**翻译失败**，不是「中文 idea 一律拒绝」。
2. 翻译的六种失败原因：`llm_unavailable`（无 `ctx.get('llm')`）、`no_model_selection`、`aborted`、
   `timeout`、`llm_error`、答案非法（`src/translate.ts:679-772`、`:785-800`）。
3. **缺陷 1（可观测性）**：`translationNote = describeTranslation(translation)`（`src/index.ts:1008`）
   在拒绝分支里没有被使用，`degraded.detail` 只有 `refuseChineseIdeaWithoutKeywords` 的固定文案
   （`src/index.ts:441-462`）。调用方因此分不清六种原因中的哪一种。
4. **缺陷 2（误导性建议）**：`src/render.ts:348-351` 对除 `rate_limited` 以外的所有 degraded 一律追加
   「这是网络或代理问题，不是没有匹配项目」。翻译失败被渲染成网络问题。
5. 宿主侧核查：`app.asar` 里确实存在 `ctx.get('llm')`（带 `listProviders()`）与
   `agentDefaultModel.currentSelection()`，所以 `llm_unavailable` 的概率低；更可能是
   `no_model_selection` / `llm_error` / `timeout` 之一，需要缺陷 1 修掉才能定位。
6. `src/translate.ts:673`：idea 里只要有一个拉丁字母就**跳过翻译**。所以 B1/B2 跑的是「无 LLM 的词表路径」，
   这批结果实际上就是消融实验里「无翻译」那一臂的数据。

## 对 E1 的结论

- 12 个 idea 里 10 个含拉丁词，会跳过翻译层，可以直接测计划与检索。
- 纯中文的 A1/A2 必须先解决翻译层，否则只能用「调用方给 keywords」的条件测，并单独记录该限制。
- batch 1 的同时顺带得到「无翻译」臂的真实数据：B1 1/4、B2 0/11。
