# Directory Structure

> How frontend code is organized in this project.

---

## Overview

**Not applicable as a separate concern.** This project has no frontend source tree: no components directory, no assets, no stylesheets, no bundler, and no build step for a UI. `src/` is a single flat directory of eleven TypeScript modules, and the presentation layer is one of them (`src/render.ts`).

The directory rules that *do* apply — the flat layout, the one-way import rule, the file-naming convention — are the same for every module in the project and are specified once in [`backend/directory-structure.md`](../backend/directory-structure.md). Read that file.

This file exists so the frontend layer's index can point somewhere honest rather than leaving an unfilled template in the tree.

---

## Where the presentation layer lives

| Concern | Module |
|---------|--------|
| The Markdown card (this project's entire UI) | `src/render.ts` |
| Values that reach the card, scoring maths, ranking | `src/types.ts` |
| The tool schemas that gate what a caller may send | `src/index.ts` |

`src/render.ts` is a leaf of the dependency graph: it imports types and two constants, and **nothing in `src/` imports it except `src/index.ts`**. That one-way shape is what makes every renderer callable from a test without a host — see [`quality-guidelines.md`](./quality-guidelines.md) §"Testing Requirements".

---

## Why there is no separate frontend layout

The usual reason a frontend gets its own directory tree is that it has its own build, its own module resolution, and its own dependency set. None of those hold here:

- **One build.** `npx tsc -p tsconfig.json` compiles `src/` to `lib/`. There is no second pipeline.
- **One dependency set.** `package.json` declares zero runtime dependencies (`"dependencies": {}`), and nothing under `src/` imports a UI library.
- **One consumer.** The card is read by the calling model and printed to a terminal; there is no DOM and no browser (see [`component-guidelines.md`](./component-guidelines.md)).

Adding a `frontend/` or `ui/` directory would therefore create a boundary with nothing on the other side of it.

---

## Naming

Inherited from [`backend/directory-structure.md`](../backend/directory-structure.md), with no frontend-specific exceptions: modules are lowercase single words (`render.ts`, `select.ts`), and the file name states the concern rather than the layer.
