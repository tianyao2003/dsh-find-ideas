# dsh-find-ideas

[English](README.md) | 中文

**一个帮你找「前车之鉴」的插件**——动手造轮子之前，先看看别人是不是已经造过了。

用大白话描述你的项目想法，agent 会去 GitHub 上搜索相似的仓库。它用自己给出的相关性判断把候选池排序，再读你选中的那些仓库的真实源码——README、依赖清单、目录树、关键文件——所以比较的依据是代码，而不是一句仓库简介。

三个工具，零运行时依赖。每张排名卡都把「代码算出来的数字」和「调用方提供的文本」分开，标注出哪些没有验证过，且所有失败都以返回值而不是异常的形式给出。

## 安装

```sh
# 从 GitHub 安装（私有仓库，需要 git 凭据）
dsh plugin --profile web add github:tianyao2003/dsh-find-ideas

# 或从本地目录安装
dsh plugin --profile web add /path/to/dsh-find-ideas
```

未发布到 npm。

## 使用

安装后重启 `dsh web`，然后直接描述你想造什么即可——agent 会自己调用这些工具：

- 「我想做一个本地优先、支持 wiki 链接的 Markdown 笔记应用，已经有人做过了吗？」
- 「还有谁写过搜索 GitHub 的 DSH 插件？」
- 「读一下 siyuan-note/siyuan 的源码，讲讲它的插件系统是怎么组织的。」

agent 会按顺序走完三个工具：`scout_projects` 建候选池，`rank_candidates` 出排名卡，`inspect_projects` 读你选中仓库的源码。

## 工作方式

![dsh-find-ideas 架构](docs/dsh-find-ideas-architecture.png)

- **`scout_projects`** 把想法转成最多 3 条 GitHub 搜索查询，返回按 star 排序的候选池——刻意**不**按相关性排序。非英文想法会先翻译；若想法是中文、又没给拉丁文关键词、翻译也不可用，则以 `plan_failed` 拒绝，而不是盲目搜索。
- **`rank_candidates`** 用 `relevance × (1 + log10(max(stars, 10) + 1)) / 2` 给候选池打分。relevance 是调用方给的 0–10 判断；分数、评级和顺序都由代码算出，可从公式复现。
- **`inspect_projects`** 最多读 5 个仓库——README、依赖清单、目录树摘要和几个关键文件——并扫描每个文件的文件头找声明。它从不返回空结果：扩展名不在扫描器覆盖范围内的文件会明确说明。

这张图是对代码的**解读**，不是对代码的测量。图与 `src/` 冲突时以源码为准。`docs/dsh-find-ideas.html` 是可交互版本，`docs/dsh-find-ideas.candidate.json` 是生成它所用的输入，所以图是重新生成而非手工修改的。

### 卡片给出的保证

- **算出来的 vs 传进来的。** 每张排名卡都带 `【代码计算区】` 声明；调用方提供了自由文本时，另有独立的 `【调用方说明区】`。调用方的备注会被裁剪、转义、标注 `[未验证]`，且永不参与算术。
- **「没测」不等于「测到零」。** 被跳过的探测、只跑了一部分的探测、以及不带探测数据的缓存回放，各有各的措辞，而不是悄悄显示成零。
- **长尾流失被计两次。** `low_star_in_pool` 和 `low_star_in_kept` 回答的是两个不同问题：池子里就没有小项目是**检索**问题，池子里有却在排名中丢掉了是**排名**问题。
- **第三方文本是不可信数据。** 仓库摘录被围栏包住、逐行转义，并加上 `│` 边栏，使 README 里的一行无法冒充卡片结构；链接目标只允许精确匹配 `github.com` 与 `raw.githubusercontent.com` 的白名单。
- **失败是值。** 每条失败路径都返回 `{ reason, detail }` 形状的 `degraded` 说明——`rate_limited`、`quota_exceeded`、`time_budget_exceeded`、`plan_failed` 等等——从不抛出异常。

### 限流与 GitHub token

GitHub 搜索接口在未认证时限制为**每公网 IP 每分钟 10 次**，且该额度由同一出口 IP 背后的所有主机共享。插件会通过宿主的 `credentials` 服务解析 `GITHUB_TOKEN` 凭据；配置后额度提升到**每分钟 30 次**并按账号计。没有 token 也能用——只是 `inspect_projects` 会拒绝估算超过 10 次请求的匿名批次，并告诉你几个仓库装得下。

## 兼容性

需要 Node ≥ 22。DSH 的插件 API 使用预发布版本号，而 node-semver 规定：只有当 range 里带有与该版本 **major.minor.patch 相同**的 prerelease 时，预发布版本才算满足该 range——所以把 peer range 钉在某一条宿主线上，下一条线一发布就会悄悄失效。因此声明的 `@deepseek-ai/dsh-tools` range 覆盖到 `0.2.0-rc.1` 为止的每一条已发布宿主线，`npm run check:peers` 会从 registry 解析当前 `latest` / `next` 两条线，一旦覆盖不到就直接失败。

## 开发

```sh
npm install
npm run build         # tsc -> lib/ ；必须在 npm test 之前跑——测试 import 的是 lib/
npm test              # node test/run-all.test.mjs
npm run typecheck     # tsc --noEmit
npm run check:peers   # 从 registry 解析当前 DSH 宿主线
```

`test/` 下有 24 个 `*.test.mjs`，`test/run-all.test.mjs` 跑其中 23 个。有两个（`baseline`、`stage2`）在本仓库会跳过：它们要回放 `eval/runs/` 里的夹具，而那些夹具从未移植过来；runner 会把它们列在 `skipped (fixture absent, NOT verified)` 标题下，而不是把跳过算作通过。

## 许可

MIT，见 [LICENSE](LICENSE)。
