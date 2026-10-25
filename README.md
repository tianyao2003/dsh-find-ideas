# dsh-find-ideas

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/tianyao2003/dsh-find-ideas) [![CI](https://github.com/tianyao2003/dsh-find-ideas/actions/workflows/ci.yml/badge.svg)](https://github.com/tianyao2003/dsh-find-ideas/actions/workflows/ci.yml) [![version](https://img.shields.io/github/package-json/v/tianyao2003/dsh-find-ideas)](https://github.com/tianyao2003/dsh-find-ideas/blob/master/package.json) [![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2%20%7C%200.2.1--rc.3-blue)](#compatibility) [![stars](https://img.shields.io/github/stars/tianyao2003/dsh-find-ideas?style=flat)](https://github.com/tianyao2003/dsh-find-ideas/stargazers)

English | [中文](README.zh.md)

**Before you build it, check whether it already exists.**

Describe your idea in one sentence. The agent searches GitHub for similar projects, ranks them by relevance weighted with stars, and returns a card. Pick a few repositories from it and the agent reads their README, dependency manifest, directory tree and key files, then writes up a technical proposal you can borrow from.

<img width="2502" height="1462" alt="a ranked card and the repository inspection that follows it" src="https://github.com/user-attachments/assets/e17fcf47-6aa1-45ef-830f-dc3885121908" />

## Install

```sh
# from npm (recommended)
dsh plugin --profile web add dsh-find-ideas

# or from GitHub
dsh plugin --profile web add github:tianyao2003/dsh-find-ideas
```

### Configure a GitHub token (recommended)

GitHub limits unauthenticated search requests to **10 per minute per public IP**, and everyone behind the same egress IP shares that quota. A token raises it to **30 per minute**, counted per account.

The plugin reads `GITHUB_TOKEN` through DSH's credential store. Set it in the environment that launches DSH:

```sh
export GITHUB_TOKEN=ghp_...          # bash
$env:GITHUB_TOKEN = 'ghp_...'        # PowerShell, current session
```

Everything works without a token, but `inspect_projects` refuses an anonymous batch it estimates above 10 requests.

## Usage

Restart dsh after installing, then describe your idea — the agent calls the four built-in tools on its own:

- "I want to build a local-first Markdown note app — what's out there on GitHub?"
- "I want to build a UI-enhancing DSH plugin. Which projects exist?"

The four tools are independently callable and share no state beyond the caches and the local prior file; the prior is shown as context only and never changes ranking. `rank_candidates` accepts either the legacy single 0–10 `relevance` or explainable `problem_fit`, `workflow_fit` and `technical_fit` (0–5; unknown stays unknown), from which fixed weights derive the relevance; `borrowability` is shown separately and never enters the ranking. The ranking formula is `relevance × (1 + log10(max(stars, 10) + 1)) / 2`, and the card always keeps eight columns.

## How it works

![architecture](docs/dsh-find-ideas-architecture.png)

- **`scout_projects`** turns the idea into several GitHub search queries and returns a star-sorted pool — deliberately *not* ranked by relevance. When the idea contains no Latin letters it is translated into English search terms first; when that is impossible (the caller gave no Latin `keywords` and no LLM is available) it returns `plan_failed`.
- **`rank_candidates`** scores the pool with `relevance × (1 + log10(max(stars, 10) + 1)) / 2` and produces the card.
- **`inspect_projects`** reads up to 5 repositories (README, dependency manifest, tree summary and key files), costing about 6 requests per repo at `shallow` and about 10 at `deep`. The card is capped at 24 KB: one that fits is returned byte for byte, one that does not is trimmed cheapest-evidence-first (manifest, then README, then per-file excerpts, then the signature skeleton) with a note saying what was withheld and how to get it back — point-read it with `read_repo_files`, or send fewer repositories next time.
- **`read_repo_files`** point-reads up to 4 files of one repository at a single commit, returning a line window (`focus` centres it on the line matching your terms) plus a permalink with the commit and line range. `max_bytes` defaults to 8000 (4000–8192) and is a ceiling, not a suggestion.
- **`read_repo_files(view="architecture")`** performs a bounded architecture reconnaissance pass. It reports evidence-backed entry points, direct dependencies, route or command registrations, data model declarations, conservative two-hop call-chain evidence, external boundaries and observed test behaviours. Every item carries a path and line anchor when available; unsupported or unread areas are reported as unknown. It does not claim a complete call graph.

### The structure of the result

- Eight columns, always in that order: rank, project link, last updated, relevance, stars, score, language, one-line description.
- `relevance` is either the agent's own judgement or derived (0–10) from `problem_fit` / `workflow_fit` / `technical_fit`; with dimensions the card adds a separate section listing each dimension, `borrowability` and a confidence level, where `?` means unmeasured. `score` is computed from it and the star count, so the order cannot be set from prose.
- A number nobody measured is never written as `0`: a query term that was never tested on its own reads `未知（未测得）` ("unknown — not measured"), a missing archive count reads `数据缺失` ("data missing"). The card itself is written in Chinese, so these are the literal strings it emits.
- Repository text is quoted as data, so a line of README cannot impersonate card structure; links are only ever `github.com` or `raw.githubusercontent.com`.
- Nothing throws: a failure comes back as a `reason` and a `detail`, and a partial result says why it is partial.

### Caching

- In memory: up to 64 results, 5 minutes.
- On disk: search results 24 hours, source reads 10 minutes, capped at 64 MB and swept about once an hour.
- A bounded local prior file records repository names, timestamps, counts, commit/path metadata and hashed idea identifiers. It never stores source or raw idea text, is capped at 256 records/64 KB, and is shown as context only; it does not change ranking.
- All of it under `$DSH_HOME/cache/dsh-find-ideas/`, and deleting that directory is always safe.

### What leaves your machine

Search queries and repository paths go to `api.github.com`, and `inspect_projects` and `read_repo_files` only read repository content on GitHub — your local code is never uploaded. The one other destination is the model DSH already uses, and only to translate an idea with no Latin letters when the caller supplied no Latin `keywords`; a purely English idea is never sent anywhere for translation.

## Compatibility

Requires Node ≥ 22. The `@deepseek-ai/dsh-tools` peer range accepts every published version from `0.1.0-rc.6` on, which covers the current DSH release lines — `latest` (0.2.1-rc.2) and `next` (0.2.1-rc.3). `npm run check:peers` re-checks that against the npm registry.

## Version

| Version | What changed |
| --- | --- |
| 0.4.1 (current) | Explainable relevance dimensions (`problem_fit` / `workflow_fit` / `technical_fit`, 0–5, deriving a 0–10 relevance with fixed weights, while the legacy single relevance input stays accepted); an evidence-anchored `view="architecture"` for `read_repo_files`; and a bounded local prior (256 records/64 KB) that stores metadata only, is shown as context and never changes ranking. |
| 0.4.0 | Added `read_repo_files`; `inspect_projects` cards are capped at a fixed 24 KB and state the recovery paths when they overflow; the four tools' schemas are 1.7 KB smaller, repositories are read three at a time, and the card states its framing once instead of per file. A/B test: 44.8% fewer tool calls, 10.8% less tool-result payload, billed input essentially level. |
| 0.3.0 | Cache and package footprint. Descriptions are stored at 512 characters instead of unbounded, the in-memory cache is capped at 64 entries, the disk cache sweeps expired entries and stays under 64 MB, and the published package no longer ships `src/`, `test/`, `scripts/` or source maps — 805 KB unpacked instead of 2.07 MB. Tool names, parameters and output are unchanged. |
| 0.2.1 | Published to npm. Same functionality as 0.2.0. |
| 0.2.0 | The card shows how many query channels found each row and how many rows are archived repositories. |
| 0.1.0 | First usable version: the `scout_projects` → `rank_candidates` → `inspect_projects` chain. |

## Development

```sh
npm install
npm run build         # tsc -> lib/ ; run this first, the tests import lib/
npm test              # node test/run-all.test.mjs
npm run check         # typecheck + build + readme:check
npm run typecheck     # tsc --noEmit
npm run check:peers   # check the peer range against the current DSH versions
npm run eval:gate     # re-derive the experiment numbers from frozen data
```

## Contributing

Issues and pull requests are both welcome.

- **Report a problem or ask for a feature**: open an issue with the idea you typed, the result you expected and the result you got.
- **Change the code**: fork, branch off `master`, make the change with a test, run `npm run check && npm test` until green, then open a pull request. CI runs the same two commands on Node 22 and 24.
- **One change per PR**: a PR solves one problem; commit messages use prefixes such as `feat:` / `fix:` / `docs:` / `chore:`.

## License

MIT. See [LICENSE](LICENSE).
