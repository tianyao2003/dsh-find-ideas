# dsh-find-ideas

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/tianyao2003/dsh-find-ideas) [![CI](https://github.com/tianyao2003/dsh-find-ideas/actions/workflows/ci.yml/badge.svg)](https://github.com/tianyao2003/dsh-find-ideas/actions/workflows/ci.yml) [![version](https://img.shields.io/github/package-json/v/tianyao2003/dsh-find-ideas)](https://github.com/tianyao2003/dsh-find-ideas/blob/master/package.json) [![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2%20%7C%200.2.1--rc.2-blue)](#兼容性) [![stars](https://img.shields.io/github/stars/tianyao2003/dsh-find-ideas?style=flat)](https://github.com/tianyao2003/dsh-find-ideas/stargazers)

[English](README.md) | 中文

**动手造轮子之前，先看看有没有人已经做过。**

用一句话描述你的想法，agent 会去 GitHub 上搜索同类项目，按「相关性 × star」加权打分排序后返回一张卡片。你可以从卡片里挑几个仓库，agent 再去读它们的 README、依赖清单、目录树和关键文件，整理出一份可以借鉴的技术方案。

<img width="2502" height="1462" alt="排序卡片，以及随后对仓库的源码阅读" src="https://github.com/user-attachments/assets/0a8d4b2f-dd72-4628-81c5-2c25cb0f1473" />

## 安装

```sh
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-find-ideas

# 或从 GitHub 安装
dsh plugin --profile web add github:tianyao2003/dsh-find-ideas

# 或从本地目录安装
dsh plugin --profile web add /path/to/dsh-find-ideas
```

npm 包下载 391 KB，解包 805 KB、28 个文件，没有运行时依赖。从 GitHub 装会在安装时跑一次构建，需要 pnpm 放行构建脚本；从 npm 装拿到的是编译好的产物，没有这一步。

### 配置 GitHub token（推荐）

GitHub 对未认证的搜索请求限制为**每个公网 IP 每分钟 10 次**，而且同一个出口 IP 背后的所有人共用这份额度。配置 token 后提升到**每分钟 30 次**，按账号计算。

插件通过 DSH 的凭据存储读取 `GITHUB_TOKEN`。在启动 DSH 的环境里设置它：

```sh
export GITHUB_TOKEN=ghp_...          # bash
$env:GITHUB_TOKEN = 'ghp_...'        # PowerShell，仅当前会话
```

没有 token 也能用，只是 `inspect_projects` 会拒绝预计超过 10 次请求的匿名批次。

## 使用

安装后重启 dsh，然后直接说出你的想法，agent 会自己调用四个内置工具：

- 「我想做一个本地优先的 Markdown 笔记应用，帮我看一下 GitHub 上的项目。」
- 「我想做一个 UI 增强的 DSH 插件，GitHub 上有哪些项目？」

`scout_projects` → `rank_candidates` → `inspect_projects` → `read_repo_files` 四个工具彼此独立，不共享状态。0–10 的 relevance 由 agent 给出；工具只负责检索、计算、排序和读取，不判断语义相关性。排序公式是 `relevance × (1 + log10(max(stars, 10) + 1)) / 2`。排序卡片固定八列：序号、项目、最近更新、relevance、stars、得分、语言、简介。

## 工作方式

![架构图](docs/dsh-find-ideas-architecture.png)

- **`scout_projects`**：把想法拆成多条 GitHub 搜索查询，返回按 star 排序的候选池，刻意**不**按相关性排序。想法里不含拉丁字母时，会先翻译成英文检索词；如果做不到（调用方没给拉丁字母的 `keywords`、又没有可用的 LLM），就返回 `plan_failed`。
- **`rank_candidates`**：用 `relevance × (1 + log10(max(stars, 10) + 1)) / 2` 给候选池打分并生成卡片。
- **`inspect_projects`**：最多读 5 个仓库，包括 README、依赖清单、目录树摘要和几个关键文件。返回的卡片固定封顶 24 KB：装得下的卡片逐字节原样返回；装不下的按「最便宜的损失优先」裁剪（依赖清单 → README → 逐文件摘录 → 声明骨架），并附一行说明，写清被扣掉的是什么、以及怎么拿回来。没有可调的预算参数：两条补读路径是用 `read_repo_files` 点读，或者下次少传几个仓库。
- **`read_repo_files`**：在**同一个提交**上点读一个仓库里的最多 4 个文件，返回一段行窗口（`focus` 会把窗口落在命中词所在行附近）以及带提交号和行范围的永久链接。它读多少就只返回多少：字节预算是上限，不是建议值。

### 怎么看这张卡片

- 固定八列，顺序固定，每一行都保留全部列。
- `relevance` 是 agent 给出的 0–10 判断；`score` 由它和 star 数算出，所以顺序没法用一句话指定。
- 没测到的数量不会写成 `0`：查询词没单独测过显示「未知（未测得）」，归档数量缺失显示「数据缺失」。
- 仓库里的文字一律当数据引用，README 里的一行没法冒充卡片结构；能作为链接输出的只有 `github.com` 和 `raw.githubusercontent.com`。
- 工具不抛异常：失败会返回 `reason` 和 `detail`，结果不完整时会说明为什么不完整。

### 缓存

- 内存里最多 64 条，5 分钟。
- 磁盘上搜索结果存 24 小时、源码读取存 10 分钟，总量不超过 64 MB，大约每小时清理一次。
- 都在 `$DSH_HOME/cache/dsh-find-ideas/` 下，删掉这个目录永远安全。

### 数据去向

搜索查询和仓库路径会发到 `api.github.com`；`inspect_projects` 和 `read_repo_files` 只读取 GitHub 上的仓库内容，不会上传你本地的代码。另一处出口是运行插件的 DSH 所用的模型，只有在想法不含拉丁字母、调用方又没给拉丁字母的 `keywords` 时，才用来翻译——纯英文的想法不会为了翻译而发给模型。

## 兼容性

需要 Node ≥ 22。`@deepseek-ai/dsh-tools` 的 peer range 接受从 `0.1.0-rc.6` 起的所有已发布版本，覆盖当前两条 DSH 发布线——`latest`（0.2.0-rc.2）和 `next`（0.2.1-rc.2）。`npm run check:peers` 会拿 npm registry 上的实际版本再核一遍。

## 版本

| 版本 | 更新 |
| --- | --- |
| 0.4.0（当前） | 新增第四个工具 read_repo_files，给结果卡片设了上限。inspect_projects 单次最多返回 24 KB，超出会裁剪，并在卡片里说明扣下了什么、怎么补读：用 read_repo_files 点读，或少传几个仓库；没有可调预算参数。四个工具的 schema 小了 1.7 KB，仓库改为三个一批并行读，卡片版式只声明一次。AB实验：工具调用少 44.8%，工具结果载荷少 10.8%，计费输入基本打平。插件用更少、更准的调用替代大量裸调用。完整实验见 eval/runs/ab-v041-baseline/。 |
| 0.3.0 | 缓存与包体。简介按 512 字符存储而不是无限长，内存缓存上限 64 条，磁盘缓存会清理过期条目并保持在 64 MB 以内，发布包里不再包含 `src/`、`test/`、`scripts/` 和 source map——解包 805 KB，原来是 2.07 MB。工具名、参数和输出都没变。 |
| 0.2.1 | 发布到 npm，功能与 0.2.0 相同。 |
| 0.2.0 | 卡片标出每行被几个查询命中、榜上有多少行是归档仓库。 |
| 0.1.0 | 首个可用版本：`scout_projects` → `rank_candidates` → `inspect_projects` 三工具链路。 |

## 开发

```sh
npm install
npm run build         # tsc -> lib/ ；必须先跑，测试 import 的是 lib/
npm test              # node test/run-all.test.mjs
npm run typecheck     # tsc --noEmit
npm run check:peers   # 检查 peer range 是否覆盖当前的 DSH 版本
```

## 贡献

欢迎 issue 和 PR！

- **报问题 / 提需求**：开 issue，写清你输入的想法、期望的结果和实际结果。
- **改代码**：fork → 从 `master` 切分支 → 改代码并补测试 → `npm run check && npm test` 全绿 → 提 pull request。CI 在 Node 22 和 24 上跑的也是这两条命令。
- **一次只做一件事**：一个 PR 解决一个问题；提交信息用 `feat:` / `fix:` / `docs:` / `chore:` 等前缀。

## 许可证

MIT，见 [LICENSE](LICENSE)。
