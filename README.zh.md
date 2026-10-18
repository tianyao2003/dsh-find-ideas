# dsh-find-ideas

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/tianyao2003/dsh-find-ideas) [![CI](https://github.com/tianyao2003/dsh-find-ideas/actions/workflows/ci.yml/badge.svg)](https://github.com/tianyao2003/dsh-find-ideas/actions/workflows/ci.yml) [![version](https://img.shields.io/github/package-json/v/tianyao2003/dsh-find-ideas)](https://github.com/tianyao2003/dsh-find-ideas/blob/master/package.json) [![DSH](https://img.shields.io/badge/DSH-0.1.0--rc.2%20to%200.2.1--rc.1-blue)](#版本) [![stars](https://img.shields.io/github/stars/tianyao2003/dsh-find-ideas?style=flat)](https://github.com/tianyao2003/dsh-find-ideas/stargazers)

[English](README.md) | 中文

**动手造轮子之前，先看看有没有人已经做过。**

用一句话描述你的想法，agent 会去 GitHub 上搜索同类项目，按「相关性 × star 加权」打分排序后返回一张卡片。你从卡片里挑几个仓库，它再去读这些仓库的 README、依赖清单、目录树和关键文件，整理出一份可以借鉴的架构方案。

<img width="2502" height="1462" alt="image" src="https://github.com/user-attachments/assets/0a8d4b2f-dd72-4628-81c5-2c25cb0f1473" />

## 安装

```sh
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-find-ideas

# 或从 GitHub 安装
dsh plugin --profile web add github:tianyao2003/dsh-find-ideas

# 或从本地目录安装
dsh plugin --profile web add /path/to/dsh-find-ideas
```

已发布到 npm，包名 `dsh-find-ideas`。从 GitHub 装会在安装时跑一次构建，需要 pnpm 放行构建脚本；从 npm 装拿到的是编译好的产物，没有这一步。

### 配置 GitHub token（推荐）

GitHub 对未认证的搜索请求限制为**每个公网 IP 每分钟 10 次**，而且同一个出口 IP 背后的所有人共用这份额度。配置 token 后提升到**每分钟 30 次**，按账号计算。

插件通过 DSH 的凭据存储读取 `GITHUB_TOKEN`。在启动 DSH 的环境里设置它：

```sh
export GITHUB_TOKEN=ghp_...          # bash
$env:GITHUB_TOKEN = 'ghp_...'        # PowerShell，仅当前会话
```

没有 token 也能用，只是 `inspect_projects` 会拒绝预计超过 10 次请求的匿名批次。

## 使用

安装后重启 dsh，然后直接说出你的想法，agent 会自己调用三个内置工具：

- 「我想做一个本地优先的 Markdown 笔记应用，帮我看一下 GitHub 上的项目。」
- 「我想做一个 UI 增强的 DSH 插件，GitHub 上有哪些项目？」

`scout_projects` → `rank_candidates` → `inspect_projects` 三个工具彼此独立，不共享状态。0–10 的 relevance 由 agent 给出；工具只负责检索、计算、排序和读取，不判断语义相关性。排序公式是 `relevance × (1 + log10(max(stars, 10) + 1)) / 2`。排序卡片固定八列：序号、项目、最近更新、relevance、stars、得分、开发语言、简介。

## 工作方式

![架构图](docs/dsh-find-ideas-architecture.png)

- **`scout_projects`**：把想法拆成多条 GitHub 搜索查询，返回按 star 排序的候选池，刻意**不**按相关性排序。想法里不含拉丁字母时，会先翻译成英文检索词；如果做不到（调用方没给拉丁字母的 `keywords`、又没有可用的 LLM），就返回 `plan_failed`。
- **`rank_candidates`**：用 `relevance × (1 + log10(max(stars, 10) + 1)) / 2` 给候选池打分并生成卡片。
- **`inspect_projects`**：最多读 5 个仓库，包括 README、依赖清单、目录树摘要和几个关键文件。

### 卡片给出的保证

- **算出来的和传进来的分开。** 排序卡会声明哪些字段由代码算出、哪些由调用方（也就是调用工具的那个 agent）传入。调用方给的文字会被截断、转义并标上 `[未验证]`，永远不参与算术。
- **没测到的数量不会写成 0。** 查询词没单独测过，显示「未知（未测得）」；归档字段缺失，明说「数据缺失」；候选池总数没测过时，只报保留槽位的数量，不编造池子里的总数。
- **第三方文本一律当作数据。** 仓库摘录用代码块包住并转义，README 里的一行无法冒充卡片结构；能作为链接输出的，只有 `github.com` 和 `raw.githubusercontent.com`。
- **失败也走返回值。** 工具不抛异常：每次失败都返回可以据以行动的 `reason` 和 `detail`，结果不完整时会说明为什么不完整。
- **复述不能丢列。** 卡片自己写着：复述它时八列必须全部保留，删掉一行或一列是丢信息，不是把表格缩短。

### 数据去向

搜索查询和仓库路径会发到 `api.github.com`；`inspect_projects` 只读取 GitHub 上的仓库内容，不会上传你本地的代码。另一处出口是运行插件的 DSH 所用的模型，只有在想法不含拉丁字母、调用方又没给拉丁字母的 `keywords` 时，才用来翻译——纯英文的想法不会为了翻译而发给模型。搜索结果缓存 24 小时，源码读取结果缓存 10 分钟，都在本地 `$DSH_HOME/cache/dsh-find-ideas/`。

## 兼容性

需要 Node ≥ 22。DSH 插件 API 使用预发布版本号，而一个 range 分支跨不过小版本号，所以 `@deepseek-ai/dsh-tools` 的 peer range 按小版本逐条列出要支持的版本（每个小版本一条）；`npm run check:peers` 会从 npm registry 查出当前 DSH 宿主实际安装的 `dsh-tools` 版本，一旦 range 不接受它就报错。每个插件版本各自支持哪些 DSH 版本，见下面「版本」一节。

## 版本

| 版本 | 更新 | 适配的 DSH 版本 |
| --- | --- | --- |
| 0.2.1（当前） | 发布到 npm，功能与 0.2.0 相同。 | `0.1.0-rc.2` 到 `0.2.1-rc.1` |
| 0.2.0 | 卡片标出每行被几个查询命中、榜上有多少行是归档仓库，并把「复述时八列必须全部保留」写进卡片本身。 | `0.1.0-rc.2` 到 `0.2.1-rc.1` |
| 0.1.0 | 首个可用版本：`scout_projects` → `rank_candidates` → `inspect_projects` 三工具链路，以及把「算出来的」和「传进来的」分开的规则。 | `0.1.0-rc.2` 到 `0.2.0-rc.2` |

## 开发

```sh
npm install
npm run build         # tsc -> lib/ ；必须先跑，测试 import 的是 lib/
npm test              # node test/run-all.test.mjs
npm run typecheck     # tsc --noEmit
npm run check:peers   # 检查 peer range 是否覆盖当前的 DSH 版本
```

`test/` 下有 27 个 `*.test.mjs`。`test/run-all.test.mjs` 跑除自身之外的 26 个，其中两个（`baseline`、`stage2`）因为 `eval/runs/` 下录好的测试数据从未移植过来而跳过——所以本地完整跑一遍，验证的是 **24 个文件**。跳过的会列在 `skipped (fixture absent, NOT verified)` 下面，绝不算作通过。

## 贡献

欢迎 issue 和 PR ！ 

- **报问题 / 提需求**：开 issue，写清你输入的想法、期望的结果和实际结果。
- **改代码**：fork → 从 `master` 切分支 → 改代码并补测试 → `npm run check && npm test` 全绿 → 提 pull request。CI 在 Node 22 和 24 上跑的也是这两条命令。
- **一次只做一件事**：一个 PR 解决一个问题；提交信息用 `feat:` / `fix:` / `docs:` / `chore:` 等前缀。

## 许可证

MIT，见 [LICENSE](LICENSE)。
