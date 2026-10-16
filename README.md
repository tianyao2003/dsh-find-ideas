# dsh-find-ideas

English | [中文](README.zh.md)

**A plugin that finds prior art** — before you build something, find out whether someone already built it.

Describe your project idea in your own words and the agent searches GitHub for repositories that resemble it. It ranks the pool using relevance judgements the agent supplies, then reads the actual source of the repositories you pick — README, dependency manifest, directory tree, key files — so the comparison rests on code rather than on a one-line description.

Three tools, zero runtime dependencies. Every ranked card separates code-computed numbers from caller-supplied text, labels what it did not verify, and every failure comes back as a value instead of an exception.

## Install

```sh
# from GitHub (private repository — needs git credentials)
dsh plugin --profile web add github:tianyao2003/dsh-find-ideas

# or from a local checkout
dsh plugin --profile web add /path/to/dsh-find-ideas
```

Not published to npm.

## Usage

Restart `dsh web` after installing, then just describe what you want to build — the agent calls the tools on its own:

- "I want to build a local-first Markdown note app with wiki links — does that already exist?"
- "Who else has written a DSH plugin that searches GitHub?"
- "Read the source of siyuan-note/siyuan and tell me how its plugin system is structured."

The agent walks the three tools in order: `scout_projects` builds a candidate pool, `rank_candidates` turns it into a ranked card, `inspect_projects` reads the source of the repositories you choose.

## How it works

![dsh-find-ideas architecture](docs/dsh-find-ideas-architecture.png)

- **`scout_projects`** turns the idea into up to 3 GitHub search queries and returns a star-sorted pool — deliberately *not* ranked by relevance. A non-English idea is translated first — and if the idea is CJK, no Latin keywords were given, and that translation is unavailable, the call is refused as `plan_failed` instead of searched blindly.
- **`rank_candidates`** scores the pool with `relevance × (1 + log10(max(stars, 10) + 1)) / 2`. Relevance is the caller's 0–10 judgement; the score, the rating and the order are computed in code and reproducible from the formula.
- **`inspect_projects`** reads up to 5 repositories — README, manifest, tree summary and a few key files — and scans each file head for declarations. It never returns an empty result: a file whose extension the scanner does not cover says so.

The diagram is a *reading* of the code, not a measurement of it. Where it disagrees with `src/`, the source wins. `docs/dsh-find-ideas.html` is the interactive version and `docs/dsh-find-ideas.candidate.json` is the input it was generated from, so the diagram is regenerated rather than hand-edited.

### What the cards guarantee

- **Computed vs. supplied.** Every ranked card carries a `【代码计算区】` declaration and, when the caller sent free text, a separate `【调用方说明区】`. Caller notes are clipped, escaped, labelled `[未验证]`, and never enter the arithmetic.
- **"Not measured" is not "measured zero".** Skipped probes, partial probe runs, and cache replays that carry no probe data each get their own wording instead of a silent zero.
- **Long-tail loss is counted twice.** `low_star_in_pool` and `low_star_in_kept` answer different questions: a pool with no small projects is a *retrieval* problem, a pool that lost them in the ranking is a *ranking* problem.
- **Third-party text is untrusted data.** Repository excerpts are fenced, escaped and given a `│` gutter so that a README line cannot impersonate card structure; link targets are limited to an exact-match allowlist of `github.com` and `raw.githubusercontent.com`.
- **Failures are values.** Every failure path returns a `degraded` note of shape `{ reason, detail }` — `rate_limited`, `quota_exceeded`, `time_budget_exceeded`, `plan_failed` and the rest — never a thrown exception.

### Rate limits and the GitHub token

GitHub's search endpoint allows **10 requests/minute per public IP** unauthenticated, and that quota is shared by every host behind the same egress IP. The plugin resolves the `GITHUB_TOKEN` credential through the host's `credentials` service; with one configured the limit becomes **30 requests/minute**, scoped to the account. Without a token everything still works — `inspect_projects` simply refuses anonymous batches estimated above 10 requests and says which repository count would fit.

## Compatibility

Requires Node ≥ 22. DSH plugin APIs are prerelease-versioned, and node-semver only lets a prerelease satisfy a range that carries a prerelease on the *same* `major.minor.patch` — so a peer range pinned to one host line silently stops matching the next one. The declared `@deepseek-ai/dsh-tools` range therefore names every shipped line through `0.2.0-rc.1`, and `npm run check:peers` resolves the current `latest`/`next` host lines from the registry and fails the day a new one is not covered.

## Development

```sh
npm install
npm run build         # tsc -> lib/ ; run before npm test — the tests import lib/
npm test              # node test/run-all.test.mjs
npm run typecheck     # tsc --noEmit
npm run check:peers   # resolve the current DSH host lines from the registry
```

`test/` holds 24 `*.test.mjs` files and `test/run-all.test.mjs` runs 23 of them. Two (`baseline`, `stage2`) skip in this repository: they replay fixtures from `eval/runs/` that were never ported, and the runner prints them under `skipped (fixture absent, NOT verified)` rather than counting a skip as a pass.

## License

MIT. See [LICENSE](LICENSE).
