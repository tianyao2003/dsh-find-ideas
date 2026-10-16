# dsh-find-ideas

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

[English](README.md) | 中文

**动手之前，先看看别人是不是已经做过了？**

用一句话描述你的idea，agent 会去 GitHub 上搜索相关的项目，基于相关性和 stars 加权打分排序后返回给你。再读你选中的那些仓库——README、依赖清单、目录树、关键文件等，输出可供借鉴的架构设计方案。

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

没有 token 也能正常使用，但 `inspect_projects` 会拒绝估算超过 10 次请求的匿名批次。

## 使用

安装后重启 dsh，然后直接描述你的 idea——agent 会自己调用 3 个内置工具：

- 「我想做一个本地优先的 Markdown 笔记应用，帮我看一下 GitHub 上的项目。」
- 「我想做一个 UI 增强的 DSH 插件，GitHub 上有哪些项目？」

`scout_projects` → `rank_candidates` → `inspect_projects` 三者彼此独立。0–10 的 relevance 由 agent 给出；工具只负责检索、计算、排序和读取，不判断语义相关性。排序公式为 `relevance × (1 + log10(max(stars, 10) + 1)) / 2`。卡片共 8 列：序号、项目、最近更新、relevance、stars、得分、语言、简介。

工具输出为中文，没有语言开关。

## 工作方式

![dsh-find-ideas 架构](docs/dsh-find-ideas-architecture.png)

- **`scout_projects`** 把想法转成多条 GitHub 搜索查询，返回按 star 排序的候选池——刻意**不**按相关性排序。非英文想法会先翻译成英文检索词；做不到时（中文想法 + 调用方没给拉丁 `keywords` + 无可用 LLM）返回 `plan_failed`。
- **`rank_candidates`** 用 `relevance × (1 + log10(max(stars, 10) + 1)) / 2` 加权公式给候选池打分。
- **`inspect_projects`** 最多读 5 个仓库——README、依赖清单、目录树摘要和几个关键文件。

### 可信度

- **算出来的与传进来的分得清。** 每张卡都会声明哪些字段由代码派生、哪些由调用方传入。调用方文本会被裁剪、转义并标注 `[未验证]`，永不参与算术。
- **「没测」永远不会渲染成零。** 被跳过的探测、只跑了一部分的探测、不带探测数据的缓存回放，各有各的措辞。
- **第三方文本是不可信数据。** 仓库摘录被围栏包住并转义，使 README 里的一行无法冒充卡片结构；链接目标只允许 `github.com` 与 `raw.githubusercontent.com` 白名单。
- **失败以返回值给出。** 工具不会抛异常：每条失败都返回可据以行动的 `reason` 与 `detail`，部分结果会说明为什么是部分的。

### 网络请求与数据去向

搜索查询与仓库路径发往 `api.github.com`；`inspect_projects` 读取公开仓库内容，不会上传你的本地代码。唯一的另一处出口是宿主 LLM，且只在 idea 不含拉丁字母、调用方又没给拉丁 `keywords` 时用于翻译——纯英文 idea 不会被发往任何地方。检索结果与打分在本地 `$DSH_HOME/cache/dsh-find-ideas/` 缓存 24 小时。

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

## 许可证

MIT， [LICENSE](LICENSE)。
