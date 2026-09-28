# Contributing to Animo

Thanks for looking. Issues, bug reports and pull requests are all welcome.

## Before you open a PR

Read **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** first. It is long, but it
is not a style guide. It is a record of the things in this codebase that fail
*silently* when you get them wrong: the DragonBones 5.5 contract, the Flash
transform model, how undo stores values, why the preview is ground truth. Most
review comments on a first PR are already answered in there.

Three rules the code depends on, and one grep that checks the first:

1. **`core/` imports nothing from `view/`, `app/` or `io/`, and touches no DOM.**
   That is what lets the risky logic run under vitest in Node.

   ```bash
   grep -rn 'from "@/\(view\|app\|io\)' src/core/    # must print nothing
   ```

2. **A command replaces values, it never mutates them.** `core/doc/freeze.ts`
   enforces it in tests; turn it on in the browser too with
   `localStorage["animo.freezeValues"] = "1"`.

3. **Verify interactive fixes with real mouse input.** A synthetic
   `element.click()` bypasses pointerdown/pointerup and passes even when the
   thing is broken (see the DOM trap section in the architecture doc).

## Working on it

```bash
npm install
npm run dev          # Vite on :5180, Chrome or Edge
npm test             # vitest
npx tsc --noEmit     # typecheck alone, faster than a build while iterating
npm run build        # tsc --noEmit && vite build
```

A PR should keep `npm run build` and `npm test` green. New behaviour that can be
expressed as a pure function belongs in `core/` with a test beside it; that is
where the suite earns its keep.

## Commit messages and comments

Comments explain *why*, not *what*: the surrounding code is written that way
and a PR that reads differently is harder to review than one that is simply
wrong. No comment is better than a comment restating the line below it.

## The CLA

Animo is AGPL-3.0-or-later, and a commercial licence is sold to fund the work
(see [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md)). That only stays possible if
one party holds the rights to relicense, so **every contributor signs a
Contributor Licence Agreement** before their first PR is merged:
[CLA.md](CLA.md). It is short, it does not take your copyright away, and it is
the same arrangement Qt, Grafana and Elastic use.

Signing takes one comment. On your first pull request a bot links the CLA and
asks you to reply with:

    I have read the CLA Document and I hereby sign the CLA

The signature is recorded once and covers all your future pull requests. Until
then the CLA check stays red and the PR cannot be merged.

If you would rather not sign, open an issue describing the change instead. A
good bug report is worth as much as a patch.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
