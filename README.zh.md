# dsh-find-ideas

[English](README.md) | 中文

**一个帮你找「前车之鉴」的插件**——动手造轮子之前，先看看别人是不是已经造过了。

用大白话描述你的想法。agent 会去 GitHub 上搜索相似的仓库，用它自己给出的相关性判断排序，再读你选中的那些仓库的真实源码——README、依赖清单、目录树、关键文件——所以比较的依据是代码，而不是一句仓库简介。

三个工具，无 npm 运行时依赖。需要 Node ≥ 22 与 DSH 宿主。

## 安装

```sh
# 从 GitHub 安装（私有仓库，需要 git 凭据）
dsh plugin --profile web add github:tianyao2003/dsh-find-ideas

# 或从本地目录安装
dsh plugin --profile web add /path/to/dsh-find-ideas
```

未发布到 npm。

### 配置 GitHub token（推荐）

GitHub 未认证时限制为**每公网 IP 每分钟 10 次**搜索请求，且同一出口 IP 背后的所有人共享这份额度。配置 token 后提升到**每分钟 30 次**，按账号计算。

插件通过 DSH 的凭据存储解析 `GITHUB_TOKEN` 引用。在启动 DSH 的环境里设置它：

```sh
export GITHUB_TOKEN=ghp_...          # bash
$env:GITHUB_TOKEN = 'ghp_...'        # PowerShell，仅当前会话
```

没有对话内的配置命令，这是刻意的：注册成工具后它会出现在每个 agent 的工具列表里，可能被无故调用。

没有 token 也能正常使用——只是 `inspect_projects` 会拒绝估算超过 10 次请求的匿名批次，并告诉你几个仓库装得下。

## 使用

安装后重启 `dsh web`，然后直接描述你想造什么——agent 会自己调用这些工具：

- 「我想做一个本地优先、支持 wiki 链接的 Markdown 笔记应用，已经有人做过了吗？」
- 「还有谁写过搜索 GitHub 的 DSH 插件？」
- 「读一下 siyuan-note/siyuan 的源码，讲讲它的插件系统是怎么组织的。」

常见流程是 `scout_projects` → `rank_candidates` → `inspect_projects`，但三者彼此独立：候选池可以从任何地方来，0–10 的相关性判断由 agent 给出。工具负责计算、排序和读取，自己不判断语义相关性。

**工具输出是中文的。** 下面这些标签——`【代码计算区】`、`[未验证]`——就是渲染器实际输出的字符串，没有语言开关。

一张完整的排名卡如下（由三仓库候选池渲染）：

<!-- card-sample:start -->
```
🎯 针对 idea 排序后的候选（共 3 个，按 relevance × (1 + log10(max(star,10)+1)) / 2 排序）
   "a local-first Markdown note-taking app with wiki links"
   候选池来源：scout_projects

【代码计算区】本区字段分三类，按类读取：
  · relevance：调用方自己的判断（0-10），工具不计算、也不校验它是否正确。
  · stars / pushed_at / description：调用方传入的元数据，来源未经工具核实；
    调用方自带候选时，工具不会去 GitHub 复查这三项。
  · 得分 / 评级 / 顺序：由上面两类派生，可按公式复算（评级是 relevance 的纯函数，本表不单列）。
  算术可复算，不等于输入是真的；工具没有报警，也不等于它核实过任何东西。

──────────────────────────────────────────────────────────────
| # | 项目 | 最近更新 | relevance | stars | 得分 | 语言 | 简介 |
|---|---|---|---|---|---|---|---|
| 1 | [siyuan-note/siyuan](https://github.com/siyuan-note/siyuan) | 2026-10-16T04:07:45Z | 9/10 | 46.8k | 22.7 | TypeScript | A privacy-first, self-hosted, fully open source personal knowledge management software |
| 2 | [logseq/logseq](https://github.com/logseq/logseq) | 2026-10-16T03:56:13Z | 8/10 | 45.2k | 19.8 | Clojure | A privacy-first, open-source platform for knowledge management |
| 3 | [tstapler/stelekit](https://github.com/tstapler/stelekit) | 2026-10-16T04:06:37Z | 6/10 | 7 | 6.1 | Kotlin | Local-first outliner |
──────────────────────────────────────────────────────────────
排序与星级均由代码按公式计算，不可由模型指定。

【代码计算区】评分分布：打分 3/3 个候选，噪声（relevance 0）0 个（0%），弱相关（1-2）0 个，入选 3 个。
【代码计算区】长尾：候选池里 star ≤ 100 的小项目 1 个，进入最终榜 1 个。

【调用方说明区】以下文字由调用方提供，未经工具验证，不参与排序与评分。
 · siyuan-note/siyuan：Same problem space: local-first Markdown notes with wiki-style links. [未验证]
 · logseq/logseq：Outliner rather than wiki links, but the same local-first store. [未验证]
 · tstapler/stelekit：Same idea, tiny project, worth reading for the data model. [未验证]
```

调用无法完成时，它同样返回一个值：

```
🎯 检索 idea："一个本地优先的笔记应用"

检索失败，无候选项目。

拒绝执行：idea 含中文，但 keywords 未提供。
  `一个本地优先的笔记应用` 需要英文检索词才能触达值得对标的项目：GitHub 搜索对多词做 AND 匹配，中文句子本身不是好查询，而 logseq、siyuan、Trilium 这类项目都用英文自我描述，中文查询在任何精度下都够不到它们。
  实测：`本地优先的 Markdown 笔记应用，支持双向链接` 单独检索返回 total_count: 0，而 `local-first markdown notes` 返回 30 条并命中 codexu/note-gen。
  请先把 idea 的核心概念翻成 3-6 个英文检索词，再带上 keywords 重新调用（例如把「本地优先的笔记应用」写成 `local-first note-taking`）。
  注意：本工具只能检查是否提供了英文检索词，无法判断翻译质量。
```
<!-- card-sample:end -->

## 工作方式

![dsh-find-ideas 架构](docs/dsh-find-ideas-architecture.png)

- **`scout_projects`** 把想法转成最多 3 条 GitHub 搜索查询，返回按 star 排序的候选池——刻意**不**按相关性排序。非英文想法会先翻译成英文检索词；做不到时（中文想法 + 调用方没给拉丁 `keywords` + 无可用 LLM）返回 `plan_failed`，而不是盲目搜索。
- **`rank_candidates`** 用 `relevance × (1 + log10(max(stars, 10) + 1)) / 2` 给候选池打分，并渲染出上面那张卡。
- **`inspect_projects`** 最多读 5 个仓库——README、依赖清单、目录树摘要和几个关键文件——并扫描每个文件的文件头找声明。

### 卡片给出的保证

- **算出来的与传进来的分得清。** 每张卡都会声明哪些字段由代码派生、哪些由调用方传入。调用方文本会被裁剪、转义并标注 `[未验证]`，永不参与算术。
- **「没测」永远不会渲染成零。** 被跳过的探测、只跑了一部分的探测、不带探测数据的缓存回放，各有各的措辞。
- **第三方文本是不可信数据。** 仓库摘录被围栏包住并转义，使 README 里的一行无法冒充卡片结构；链接目标只允许 `github.com` 与 `raw.githubusercontent.com` 白名单。
- **失败以返回值给出。** 工具不会抛异常：每条失败都返回可据以行动的 `reason` 与 `detail`，部分结果会说明为什么是部分的。

### 什么会离开你的机器

搜索查询与仓库路径发往 `api.github.com`；`inspect_projects` 读取公开仓库内容，从不上传你的本地源码。唯一的另一处出口是宿主 LLM，且仅在未提供拉丁关键词、需要翻译非英文想法时才会用到——纯英文想法不会被发往任何地方。结果会在本地 `$DSH_HOME/cache/dsh-find-ideas/` 缓存 24 小时。

## 兼容性

需要 Node ≥ 22。DSH 插件 API 使用预发布版本号，因此声明的 `@deepseek-ai/dsh-tools` range 覆盖到 `0.2.0-rc.1` 为止的每一条已发布宿主线；`npm run check:peers` 会从 registry 解析当前宿主线，一旦覆盖不到就直接失败。

## 开发

```sh
npm install
npm run build         # tsc -> lib/ ；必须在 npm test 之前跑——测试 import 的是 lib/
npm test              # node test/run-all.test.mjs
npm run typecheck     # tsc --noEmit
npm run check:peers   # 从 registry 解析当前 DSH 宿主线
```

`test/` 下有 24 个 `*.test.mjs`。`test/run-all.test.mjs` 跑除自身外的 23 个，其中两个（`baseline`、`stage2`）因 `eval/runs/` 夹具从未移植而跳过——所以本地完整跑一遍验证的是 **21 个文件**。跳过会列在 `skipped (fixture absent, NOT verified)` 标题下，绝不算作通过。

## 许可

MIT，见 [LICENSE](LICENSE)。
