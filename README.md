# dsh-find-ideas

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/tianyao2003/dsh-find-ideas) [![CI](https://github.com/tianyao2003/dsh-find-ideas/actions/workflows/ci.yml/badge.svg)](https://github.com/tianyao2003/dsh-find-ideas/actions/workflows/ci.yml) [![version](https://img.shields.io/github/package-json/v/tianyao2003/dsh-find-ideas)](https://github.com/tianyao2003/dsh-find-ideas/blob/master/package.json) [![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2%20%7C%200.2.1--rc.2-blue)](#compatibility) [![stars](https://img.shields.io/github/stars/tianyao2003/dsh-find-ideas?style=flat)](https://github.com/tianyao2003/dsh-find-ideas/stargazers)

English | [中文](README.zh.md)

**Before you build it, check whether it already exists.**

Describe your idea in one sentence. The agent searches GitHub for similar projects, ranks them by relevance weighted with stars, and returns a card. Pick a few repositories from it and the agent reads their README, dependency manifest, directory tree and key files, then writes up an architecture you can borrow from.

<img width="2502" height="1462" alt="a ranked card and the repository inspection that follows it" src="https://github.com/user-attachments/assets/e17fcf47-6aa1-45ef-830f-dc3885121908" />

## Install

```sh
# from npm (recommended)
dsh plugin --profile web add dsh-find-ideas

# or from GitHub
dsh plugin --profile web add github:tianyao2003/dsh-find-ideas

# or from a local directory
dsh plugin --profile web add /path/to/dsh-find-ideas
```

The npm package is 391 KB to download, 805 KB unpacked, 28 files, and has no runtime dependencies. Installing from GitHub runs the build once at install time and needs pnpm to allow build scripts; the npm package ships the compiled output, so there is no such step.

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

`scout_projects` → `rank_candidates` → `inspect_projects` → `read_repo_files` are independent and share no state. The 0–10 relevance is the agent's judgement; the tools only search, compute, sort and read, and never judge semantic similarity. The ranking formula is `relevance × (1 + log10(max(stars, 10) + 1)) / 2`. A ranked card always has eight columns: rank, project, last updated, relevance, stars, score, language, description.

## How it works

![architecture](docs/dsh-find-ideas-architecture.png)

- **`scout_projects`** turns the idea into several GitHub search queries and returns a star-sorted pool — deliberately *not* ranked by relevance. When the idea contains no Latin letters it is translated into English search terms first; when that is impossible (the caller gave no Latin `keywords` and no LLM is available) it returns `plan_failed`.
- **`rank_candidates`** scores the pool with `relevance × (1 + log10(max(stars, 10) + 1)) / 2` and produces the card.
- **`inspect_projects`** reads up to 5 repositories — README, dependency manifest, tree summary and a few key files.
- **`read_repo_files`** point-reads up to 4 files of one repository at a single commit, returning a line window (`focus` centres it on the line matching your terms) plus a permalink with the commit and line range. It reads no more than it returns: the byte budget is the ceiling, not a suggestion.

### Reading the card

- Eight columns, always in that order, and every row keeps every column.
- `relevance` is the agent's 0–10 judgement; `score` is computed from it and the star count, so the order cannot be set from prose.
- A number nobody measured is never written as `0`: a query term that was never tested on its own reads 未知（未测得）, a missing archive count reads 数据缺失.
- Repository text is quoted as data, so a line of README cannot impersonate card structure; links are only ever `github.com` or `raw.githubusercontent.com`.
- Nothing throws: a failure comes back as a `reason` and a `detail`, and a partial result says why it is partial.

### Caching

- In memory: up to 64 results, 5 minutes.
- On disk: search results 24 hours, source reads 10 minutes, capped at 64 MB and swept about once an hour.
- All of it under `$DSH_HOME/cache/dsh-find-ideas/`, and deleting that directory is always safe.

### What leaves your machine

Search queries and repository paths go to `api.github.com`, and `inspect_projects` and `read_repo_files` only read repository content on GitHub — your local code is never uploaded. The one other destination is the model DSH already uses, and only to translate an idea with no Latin letters when the caller supplied no Latin `keywords`; a purely English idea is never sent anywhere for translation.

## Compatibility

Requires Node ≥ 22. The `@deepseek-ai/dsh-tools` peer range accepts every published version from `0.1.0-rc.6` on, which covers the current DSH release lines — `latest` (0.2.0-rc.2) and `next` (0.2.1-rc.2). `npm run check:peers` re-checks that against the npm registry.

## Version

| Version | What changed |
| --- | --- |
| 0.3.0 (current) | Cache and package footprint. Descriptions are stored at 512 characters instead of unbounded, the in-memory cache is capped at 64 entries, the disk cache sweeps expired entries and stays under 64 MB, and the published package no longer ships `src/`, `test/`, `scripts/` or source maps — 805 KB unpacked instead of 2.07 MB. Tool names, parameters and output are unchanged. |
| 0.2.1 | Published to npm. Same functionality as 0.2.0. |
| 0.2.0 | The card shows how many query channels found each row and how many rows are archived repositories. |
| 0.1.0 | First usable version: the `scout_projects` → `rank_candidates` → `inspect_projects` chain. |

## Development

```sh
npm install
npm run build         # tsc -> lib/ ; run this first, the tests import lib/
npm test              # node test/run-all.test.mjs
npm run typecheck     # tsc --noEmit
npm run check:peers   # check the peer range against the current DSH versions
```

`test/` holds 30 `*.test.mjs` files. `test/run-all.test.mjs` runs the 29 that are not itself, and two of those (`baseline`, `stage2`) skip because the recorded test data under `eval/runs/` was never ported — so a full local run is **27 files and 6463 assertions**. Skips are listed under `skipped (fixture absent, NOT verified)` and never counted as passes.

## Contributing

Issues and pull requests are both welcome.

- **Report a problem or ask for a feature**: open an issue with the idea you typed, the result you expected and the result you got.
- **Change the code**: fork, branch off `master`, make the change with a test, run `npm run check && npm test` until green, then open a pull request. CI runs the same two commands on Node 22 and 24.
- **One change per PR**: a PR solves one problem; commit messages use prefixes such as `feat:` / `fix:` / `docs:` / `chore:`.

## License

MIT. See [LICENSE](LICENSE).
