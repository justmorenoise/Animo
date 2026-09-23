# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

**Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing anything.**
It is the real project documentation: what Animo is, how it is layered, and —
mostly — the things that fail *silently* when you get them wrong. The DragonBones
5.5 contract, the Flash transform model, the undo rules, the preview as ground
truth, the DOM trap that has bitten twice. Find the section covering what you
are about to touch and read it first.

## Prose

Remove all mannered prose. Comment only non-obvious logic or non-trivial
decisions.

## Commands

```bash
npm run dev        # Vite on :5180 — open in Chrome or Edge
npm test           # vitest run
npm run build      # tsc --noEmit && vite build
npx tsc --noEmit   # typecheck alone; faster than a build while iterating
```

## The three rules a change must not break

1. `core/` imports nothing from `view/`, `app/` or `io/`, and touches no DOM:

   ```bash
   grep -rn 'from "@/\(view\|app\|io\)' src/core/    # must print nothing
   ```

2. A command **replaces** values, it never mutates them (`core/doc/freeze.ts`
   enforces it under vitest; `localStorage["animo.freezeValues"] = "1"` turns it
   on in a dev build).

3. Verify interactive fixes with **real mouse input**. A synthetic
   `element.click()` bypasses pointerdown/pointerup and passes even when the
   thing is broken.

## Licensing

AGPL-3.0-or-later, with an MIT carve-out for `src/runtime/animo-pixi.js` and
everything the exporter writes — that file ships inside other people's games.
See [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md). Never move export-bound code
out of that file without checking the exception still covers it.
