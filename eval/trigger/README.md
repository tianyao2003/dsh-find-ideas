# 触发语料与覆盖率检查

这一层回答一个问题：**v0.5.0 的提示词，有没有把真实用户会说的话覆盖进去？**

背景：0.4.1 之前，`scout_projects` 只在用户说了 "GitHub" 时才被想起——57 份会话日志里 11 次调用，11/11 的前一条用户消息都含这个词；四条有想法但没提 GitHub 的消息，0 次检索。0.5.0 把触发面从「关键词」改成「情境」，写在两处：系统提示词段落 `SCOUT_GUIDANCE`（`lib/activation.js` 导出）和工具描述。这两处都是散文，改一版读起来更顺，就可能悄悄丢掉某条边界。

## 语料是什么

`corpus.mjs` 导出 `TRIGGER_CASES`：每条是一个真实用户说法，带 `id`、`category`、`text`、`expect`（`search` / `no-search`）、`why`、`promptSignal`。

- 11 个类别：前六个是**该搜**的情境（想法+求建议、模糊想法、想要个工具、怎么开始、明说 GitHub、明说去搜），后五个是**不该搜**的边界（能力询问、纯技术问答、已经在做、本会话已搜过、用户说不搜）。
- `capability-question` 特殊：还没有想法，不能检索，但提示词必须让模型**主动介绍**这项能力。
- `promptSignal` 是 `SCOUT_GUIDANCE` 里必须出现的**逐字子串**（1–3 条）。只取提示词段落，不取工具描述——描述另有改动。
- 三条原始报告句必须逐字保留：`我想制作一个番茄钟你有什么建议嘛`、`你可以帮我做什么嘛`、`你可以去帮我查下我该怎么做嘛`。

## 怎么跑

```bash
node eval/harness/trigger-coverage.mjs            # 表格 + 汇总，全绿 exit 0
node eval/harness/trigger-coverage.mjs --verbose  # 逐条列出
node eval/harness/trigger-coverage.mjs --json     # 机器可读
node test/trigger-corpus.test.mjs                 # 同一规则的测试版（npm test 会跑）
```

## 覆盖率检查证明什么、不证明什么

**证明**：随包发布的 `SCOUT_GUIDANCE` 逐字包含了语料里每个情境的命名子串；语料本身仍满足形状规则（≥26 条、11 类齐全、每类 ≥2 条、id 唯一、`expect` 与类别一致、三条原始句在位）。

**不证明**：模型会把这些消息**正确分类**。子串出现不等于理解——段落里写着 "already building"，模型仍可能去搜。这是文本覆盖率，不是行为正确率。

## 发版前怎么跑真正的端到端评估（手动）

离线脚本替代不了模型。发版前手工做一次：

1. 开一个干净的 live session，逐条把 `corpus.mjs` 的 `text` 作为**新会话的第一条用户消息**发进去（每条一个 session，避免上下文污染）。
2. 记录 `scout_projects` 是否被调用（看会话日志的 `tool/call`）。
3. 与 `expect` 对照，算三个数：search 类命中率、no-search 类未调用率、总一致率。任何一个 < 100% 都要看具体是哪条、错在哪个方向。
4. 把结果写进发版记录（会话 id + 一致率 + 失败条目），不要只写「测过了」。

## 规则

- 真实日志里出现**新的用户说法**，先判断它属于哪个类别，再**追加**到 `corpus.mjs`；不要为了过检查去改旧 case 的 `promptSignal`。
- 改 `SCOUT_GUIDANCE` 时，如果某个情境的措辞变了，语料里的 `promptSignal` 要跟着改成新原文——这是提示词改了、检查仍然有效的前提。
- 语料只增不减：删 case 等于删除一条已知会漏的触发面。
