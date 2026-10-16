# Component Guidelines

> How components are built in this project.

---

## Overview

**Not applicable to this project.** There is no component framework — no React, no Vue, no JSX, no build step, no DOM. `package.json` has zero runtime dependencies (`"dependencies": {}`), and nothing under `src/` imports a UI library.

The equivalent concern — "how is a unit of presentation structured, and what does it receive?" — lives in **`src/render.ts`** and is specified in `.trellis/spec/frontend/index.md` and `.trellis/spec/frontend/type-safety.md`.

If you came here looking for the rules on how to build a piece of what the user sees, read `src/render.ts:1-14` and the renderer section of the frontend layer index. The short version: a renderer is a pure function from computed values to a string, it receives everything positionally, and it never reorders rows or invents a number.

---

## Component Structure

Not applicable — there are no components.

The nearest analogue is a renderer function in `src/render.ts` (`renderCandidates` `:349`, `renderRanked` `:539`, `renderInspections` `:953`, `renderSkeleton` `:812`). Each is a pure string builder with a positional signature, and each is exported so a test can call it directly rather than through a registered tool.

---

## Props Conventions

Not applicable — there are no props.

The nearest analogue is a renderer's **positional parameter list**, and there is one convention worth carrying over from it: **new parameters are appended, never inserted**, so every existing call keeps its meaning. `renderCandidates`' `lowStarInPool` parameter is the worked example — see the doc at `src/render.ts:357-364`, and `type-safety.md` §"Common Patterns" for why its `null` case must not default to `0`.

---

## Styling Patterns

Not applicable — there is no styling layer, no CSS, and no stylesheet of any kind.

The nearest analogue is **Markdown layout**, which lives entirely in `src/render.ts`: an eight-column table for ranked rows (`:242-243`), `─`.repeat(60) rules, `EMPTY_CELL = '—'` (`:28`) for a genuinely absent value, and `escapeCell` (`:97`) so a value containing `|` cannot break the table. Those rules are documented in the frontend layer index.

---

## Accessibility

Not applicable — the output is plain text read by a language model and printed to a terminal. There is no DOM, no ARIA, no keyboard navigation and no colour.

The nearest analogue is **legibility to the reader**, and it is taken seriously: the card distinguishes three causes of an empty result rather than printing a bare "no results" (`src/render.ts:315-346`), because a reader who cannot tell a quota problem from a genuine miss will conclude the wrong thing. See `logging-guidelines.md` §"Structured Logging".

---

## Common Mistakes

Not applicable in the component sense. For the mistakes that actually occur when building the presentation layer, see:

- `quality-guidelines.md` §"Forbidden Patterns" — including "reconstructing a URL from `full_name`" and "reporting an unmeasured value as `0`";
- `src/render.ts:30-46` — the 668,409-byte description incident that produced `MAX_DESCRIPTION_CHARS`;
- `src/index.ts:1352-1359` — the `note` field that was accepted as input and read by the renderer but never declared in the output schema, so it was dropped in between.
