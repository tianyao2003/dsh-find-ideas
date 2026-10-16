# dsh-find-ideas

English | [中文](README.zh.md)

**A plugin that finds prior art** — before you build something, find out whether someone already built it.

Describe your idea in your own words. The agent searches GitHub for repositories that resemble it, ranks them with relevance judgements it supplies, then reads the source of the ones you pick — README, dependency manifest, directory tree, key files — so the comparison rests on code rather than on a one-line description.

Three tools, no npm runtime dependencies. Requires Node ≥ 22 and a DSH host.

## Install

```sh
# from GitHub (private repository — needs git credentials)
dsh plugin --profile web add github:tianyao2003/dsh-find-ideas

# or from a local checkout
dsh plugin --profile web add /path/to/dsh-find-ideas
```

Not published to npm.

### Configure a GitHub token (recommended)

GitHub allows **10 search requests per minute per public IP** unauthenticated, and that quota is shared by everyone behind the same egress IP. A token raises it to **30 per minute**, scoped to your account.

The plugin resolves the `GITHUB_TOKEN` reference through DSH's credential store. Set it in the environment that launches DSH:

```sh
export GITHUB_TOKEN=ghp_...          # bash
$env:GITHUB_TOKEN = 'ghp_...'        # PowerShell, current session
```

There is no in-chat command for this, deliberately: a registered tool would appear in every agent's tool list and could be called unprompted.

Without a token everything still works — `inspect_projects` refuses an anonymous batch it estimates above 10 requests and says how many repositories would fit.

## Usage

Restart `dsh web` after installing, then describe what you want to build — the agent calls the tools on its own:

- "I want to build a local-first Markdown note app with wiki links — does that already exist?"
- "Who else has written a DSH plugin that searches GitHub?"
- "Read the source of siyuan-note/siyuan and tell me how its plugin system is structured."

The usual flow is `scout_projects` → `rank_candidates` → `inspect_projects`, but the three are independent. The pool can come from anywhere, and the 0–10 relevance judgement is the agent's, not the plugin's — the tools compute, sort and read, but never judge semantic similarity themselves.

**Output is written in Chinese.** The labels below — `【代码计算区】`, `[未验证]` — are the literal strings the renderer emits; there is no locale switch. This is a complete card, rendered from a three-repository pool:

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

And when a call cannot be completed, it still returns a value:

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

## How it works

![dsh-find-ideas architecture](docs/dsh-find-ideas-architecture.png)

- **`scout_projects`** turns the idea into up to 3 GitHub search queries and returns a star-sorted pool — deliberately *not* ranked by relevance. A non-English idea is translated into English search terms first; when that cannot be done (a CJK idea, no Latin `keywords` from the caller, no LLM available) the call returns `plan_failed` instead of searching blindly.
- **`rank_candidates`** scores the pool with `relevance × (1 + log10(max(stars, 10) + 1)) / 2` and renders the card above.
- **`inspect_projects`** reads up to 5 repositories — README, manifest, tree summary and a few key files — and scans each file head for declarations.

### What the cards guarantee

- **Computed and supplied stay apart.** Every card declares which fields the code derived and which the caller passed in. Caller text is clipped, escaped and labelled `[未验证]`, and never enters the arithmetic.
- **"Not measured" is never rendered as zero.** When a check was skipped, ran only partly, or a cached result carries no diagnostics, the card says so instead of printing a zero.
- **Third-party text is untrusted data.** Repository excerpts are fenced and escaped so that a README line cannot impersonate card structure; link targets are limited to an allowlist of `github.com` and `raw.githubusercontent.com`.
- **Failures come back as values.** Nothing throws out of a tool: every failure returns a `reason` and a `detail` you can act on, and a partial result says why it is partial.

### What leaves your machine

Search queries and repository paths go to `api.github.com`; `inspect_projects` reads public repository content and never uploads your local source. The only other egress is the host LLM, used solely to translate an idea that contains no Latin letters when the caller supplied no Latin keywords — a purely English idea is not sent anywhere. Results are cached locally under `$DSH_HOME/cache/dsh-find-ideas/` for 24 hours.

## Compatibility

Requires Node ≥ 22. DSH plugin APIs are prerelease-versioned, so the declared `@deepseek-ai/dsh-tools` range names every shipped line through `0.2.0-rc.1`; `npm run check:peers` resolves the current host lines from the registry and fails the day one is not covered.

## Development

```sh
npm install
npm run build         # tsc -> lib/ ; run before npm test — the tests import lib/
npm test              # node test/run-all.test.mjs
npm run typecheck     # tsc --noEmit
npm run check:peers   # resolve the current DSH host lines from the registry
```

`test/` holds 24 `*.test.mjs` files. `test/run-all.test.mjs` runs the 23 that are not itself, and two of those (`baseline`, `stage2`) skip because the recorded GitHub responses they replay under `eval/runs/` were never ported — so a full local run verifies **21 files**. Skips are reported under `skipped (fixture absent, NOT verified)` and never counted as passes.

## License

MIT. See [LICENSE](LICENSE).
