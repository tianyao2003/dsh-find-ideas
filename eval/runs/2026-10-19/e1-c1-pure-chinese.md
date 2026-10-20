# E1 / C1（插件自译）— 纯中文 idea 实测与真实失败原因

- 日期：2026-10-19
- 插件运行版本：v0.3.0（工作树已含两处文案修复，见 e1-copy-fix-verify.md）
- 条件：`scout_projects` 只传 `idea`，不传 `keywords`（= 插件的设计主路径）
- idea：A1「我想把手机里几千张截图变成能搜索的笔记」、A2「把长视频自动切成短视频并加字幕」

## 结果

两条均走 `degraded: { reason: 'plan_failed' }`，0 候选，GitHub 一次请求都没发出。

## 真实失败原因（本次才拿到）

```
未翻译：模型返回的内容不满足检索词要求——模型没有返回任何内容（收到：空输出）。（规则：empty_output）
LLM 输出按不可信输入处理，不满足规则的输出一律不采用，也不会写进查询。请提供 keywords 后重试。
```

即失败在 `src/translate.ts` 的 `empty_output` 规则，**不是**此前推测的四种宿主侧原因：
- 不是 `llm_unavailable`（`ctx.get('llm')` 存在，插件确实拿到了 LLM 句柄）
- 不是 `no_model_selection`（模型 provider/model 有值，调用已发出）
- 不是 `aborted` / `timeout`（没有超时中止）
- 也不是 provider 报错（`llm_error`）

**实际情况：LLM 被成功调用，但返回空 content，插件按规则判非法并拒绝。** 在本次会话的模型通道（workbuddy-ai，会话中途从 deepseek-flash → workbuddy-ai/deepseek-v4.1-flash → step-5-preview 切换）下，这条通道对插件的结构化调用吐回空输出。

## 为什么之前拿不到这个原因

旧 `src/render.ts` 的 `explainEmpty()` 对除 `rate_limited` 外的所有失败一律渲染成：

```
检索请求失败，因此没有结果。… 这是网络或代理问题，不是没有匹配项目。
```

加上 `src/index.ts:1008` 的 `translationNote` 算了却没用，`src/translate.ts` 六种失败原因被压成一句「拒绝执行」。文案修复后（index.ts 把 translationNote 拼进 detail；render.ts 为 plan_failed 单独分支、明确「不是网络问题…GitHub 一次请求都没有发出」）才暴露真实原因。

## 产品结论

1. **翻译层是纯中文 idea 的唯一入口，且本次实测 0% 可用。** 两个 idea 都是 0 候选，没有降级到「用中文整句直接检索」，等于功能不可用。
2. **修复本身被验证有效**：同一 idea、同一宿主，修复后成功暴露失败原因。这正是 eval 的价值——不是「跑通了」，而是「知道为什么没跑通」。
3. **待修方向（未实施）**：`empty_output` 应有一次重试；若仍失败，可降级为「用 idea 里已有的拉丁词 + 词表」而不是直接 0 候选。当前行为对一个投 AI 产品实习的候选人的项目叙事是硬伤：需要调用方手动给 keywords 才能用。
4. **E1 口径影响**：C1（插件自译）只能报「不可用」，Recall 按 0 记但不作为检索质量证据；A1/A2 的有效 Recall 数据来自 C2（调用方给 keywords，见 e1-a1-keywords.md）。
