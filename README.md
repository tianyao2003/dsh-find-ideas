# dsh-find-ideas

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)

English | [中文](README.zh.md)

**Before building an idea, find out whether someone already has.**

Describe your idea in one sentence. The agent searches GitHub for related projects, ranks them by relevance weighted with stars, and returns the result. It then reads the repositories you pick — README, dependency manifest, directory tree, key files — and writes up an architecture you can borrow from.

## Install

```sh
# from GitHub
dsh plugin --profile web add github:tianyao2003/dsh-find-ideas

# or from a local checkout
dsh plugin --profile web add /path/to/dsh-find-ideas
```

Not published to npm.

### Configure a GitHub token (recommended)

Unauthenticated, GitHub allows **10 search requests per minute per public IP**, and that quota is shared by everyone behind the same egress IP. A token raises it to **30 per minute**, counted per account.

The plugin resolves the `GITHUB_TOKEN` reference through DSH's credential store. Set it in the environment that launches DSH:

```sh
export GITHUB_TOKEN=ghp_...          # bash
$env:GITHUB_TOKEN = 'ghp_...'        # PowerShell, current session
```

Everything still works without a token, but `inspect_projects` refuses an anonymous batch it estimates above 10 requests.

## Usage

Restart dsh after installing, then describe your idea — the agent calls the three built-in tools on its own:

- "I want to build a local-first Markdown note app — what's out there on GitHub?"
- "I want to build a UI-enhancing DSH plugin. Which projects exist?"

`scout_projects` → `rank_candidates` → `inspect_projects` are independent of each other. The 0–10 relevance is the agent's; the tools only search, compute, sort and read, and never judge semantic similarity. The ranking formula is `relevance × (1 + log10(max(stars, 10) + 1)) / 2`. A card has 8 columns: rank, project, last updated, relevance, stars, score, language, description.

**Tool output is written in Chinese** — there is no locale switch.

## How it works

![dsh-find-ideas architecture](docs/dsh-find-ideas-architecture.png)

- **`scout_projects`** turns the idea into several GitHub search queries and returns a star-sorted pool — deliberately *not* ranked by relevance. A non-English idea is translated into English search terms first; when that is impossible (a Chinese idea, no Latin `keywords` from the caller, no LLM available) it returns `plan_failed`.
- **`rank_candidates`** scores the pool with `relevance × (1 + log10(max(stars, 10) + 1)) / 2`.
- **`inspect_projects`** reads up to 5 repositories — README, manifest, tree summary and a few key files.

### What the cards guarantee

- **Computed and supplied stay apart.** Every card declares which fields the code derived and which the caller passed in. Caller text is clipped, escaped and labelled `[未验证]`, and never enters the arithmetic.
- **"Not measured" is never rendered as zero.** A skipped check, a partly-run check and a cached replay without diagnostics each get their own wording.
- **Third-party text is untrusted data.** Repository excerpts are fenced and escaped so a README line cannot impersonate card structure; link targets are limited to an allowlist of `github.com` and `raw.githubusercontent.com`.
- **Failures come back as values.** Nothing throws out of a tool: every failure returns a `reason` and a `detail` you can act on, and a partial result says why it is partial.
- **A restatement keeps every column.** The card says so itself: keep all eight columns when you restate it — dropping one is losing information, not shortening the table.

### What leaves your machine

Search queries and repository paths go to `api.github.com`; `inspect_projects` reads public repository content and never uploads your local code. The only other egress is the host LLM, used only to translate an idea with no Latin letters when the caller supplied no Latin `keywords` — a purely English idea is never sent anywhere. Results and scores are cached locally under `$DSH_HOME/cache/dsh-find-ideas/` for 24 hours.

## Compatibility

Requires Node ≥ 22. DSH plugin APIs are prerelease-versioned, so the declared `@deepseek-ai/dsh-tools` range names every shipped line through `0.2.0-rc.1`; `npm run check:peers` resolves the current host lines from the registry and fails the day one is not covered.

## Version

| Version | Update |
| --- | --- |
| 0.2.0 (current) | The card states how many query channels found each row, what share of the pool is archived, and that a restatement must keep all eight columns. |
| 0.1.0 | First usable version: the three-tool chain, plus the card rules that keep computed fields and caller-supplied text apart. |

## Development

```sh
npm install
npm run build         # tsc -> lib/ ; run before npm test — the tests import lib/
npm test              # node test/run-all.test.mjs
npm run typecheck     # tsc --noEmit
npm run check:peers   # resolve the current DSH host lines from the registry
```

`test/` holds 27 `*.test.mjs` files. `test/run-all.test.mjs` runs the 26 that are not itself, and two of those (`baseline`, `stage2`) skip because the recorded GitHub responses they replay under `eval/runs/` were never ported — so a full local run verifies **24 files**. Skips are reported under `skipped (fixture absent, NOT verified)` and never counted as passes.

## Contributing

Stars are welcome, and so are contributions — issues and pull requests alike.

- **Report a problem or ask for a feature**: open an issue with the idea you typed, the result you expected and the result you got (tool output is Chinese; paste the card).
- **Contribution flow**: fork, branch off `master`, make the change with a test, run `npm run build && npm run check && npm test` until green, then open a pull request.
- **Pull request rules**: one change per PR; a change to card wording also updates the contract in `.trellis/spec/` and its tests; commit messages use the `feat:` / `fix:` / `docs:` prefixes.

## License

MIT. See [LICENSE](LICENSE).
