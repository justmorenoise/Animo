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

## How a fix is written

- **Decisions go in pure functions.** A rule that decides something (which
  nodes a command takes, where a span ends, whether a paste nests a symbol)
  lives in a function with no store and no DOM, in `core/` or exported next to
  its caller, and gets a table test. The command, tool or panel only applies
  the result. Examples: `convertPlan`, `groupPlan`, `endAfterResize`,
  `resizedEmptyLength`, `emptyRange`, `pastedParent`, `rowsNestHost`,
  `pointInParent`, `uniformFactor`, `atlasKey`, `validEditDepth`.
- **Check it in the app too**, not only in vitest: `preview_start` "animo",
  `window.animo.project.autosaver.stop()` first, load a fixture with
  `fetch('/tests/fixtures/projects/frog.animo')` +
  `animo.project.loadFrom(buf, { name }, false)`, then real clicks and drags
  (rule 3 above). The pane's console keeps errors across reloads: an error
  logged while Vite hot-reloads a half-edited pair of files stays listed.
- **A regression test must fail on the old code.** Check with
  `git stash push src/<file>`, run the test, `git stash pop` — never a
  command that reads stdin in between.

## Invariants the last bug hunt exposed

- **Structural commands act on the TOPMOST selected nodes** (`topmostSelected`,
  `groupPlan`). A node whose ancestor is selected moves with it; re-parenting
  it too flattened the rig.
- **`mergeWith` carries `before` as well as `after`** (`adoptBefore` in
  `core/history/Command.ts`): a node only a later step touched must still go
  back on undo.
- **Dirty tracking**: `History.push` drops `savedAt` once the saved step can no
  longer be reached (`>=`, not `>`). An async save compares
  `History.revision` before and after writing.
- **Every way into a symbol calls `wouldCreateCycle`**: library drop, paste,
  Paste Layers, Paste/drag Frames (`rowsNestHost`), convert, swap.
- **Partial spans stay partial**: Set Duration moves only the tracks that
  reached the old end; a frame drag keeps the frames after the range.
- **Bounds invalidation is transitive**: `invalidateBounds([id])` also drops
  every symbol measured through `id` (image or symbol). Any command that
  changes what a symbol shows, keys included, must invalidate it.
- **Placing at a pointer goes through the parent's space** (`pointInParent`,
  `reexpress`): a node's x/y are in its parent's frame.
- **The preview rebuild reuses the atlas** while `atlasKey` and the asset
  objects are unchanged; anything new the pages depend on must go in the key.
- **Export settings live in the document** (`Project.exportSettings`, see
  ARCHITECTURE ▸ Export settings). Absent = defaults = the old output; a new
  option needs a default that reproduces what was written before it.
- **A gesture that re-parents goes through `mayReparent`**, which refuses bones
  the IK solves unless the user turned the refusal off.
- **A transaction notifies once**, when it closes (`History.transaction`).
  Code inside one must not wait for a `doc` event to see its own changes.
- **No browser `prompt`/`confirm`/`alert`**: `view/widgets/dialogs.ts`
  (promises; re-check the target after the await). A step that can take over
  half a second runs under `busy(label, report => …)` and reports progress
  (ARCHITECTURE ▸ Dialogs and the progress card).
- **Library keys belong to the focused list** (ARCHITECTURE ▸ Folders and
  keys): it stops the keys it handles, so the stage never sees them. Folders
  are organisation only; names stay unique across the library.
- **Heavy pixel work runs on a worker** (`io/workers/`, see ARCHITECTURE ▸ Off
  the main thread) and falls back to the page on `WorkerCrashed`. The logic
  stays in a DOM-free module the worker imports (`resampleRgba`, `parsePsd`), so
  vitest tests it directly.

## Licensing

AGPL-3.0-or-later, with an MIT carve-out for `src/runtime/animo-pixi.js` and
everything the exporter writes — that file ships inside other people's games.
See [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md). Never move export-bound code
out of that file without checking the exception still covers it.
