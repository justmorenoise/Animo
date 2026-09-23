# Security policy

## Supported versions

Animo is pre-1.0. Only the latest release on `main` receives fixes.

## Reporting a vulnerability

Please **do not open a public issue.** Report it privately, either through
GitHub's [private vulnerability reporting][gh] on this repository, or by email to
<info@morenoise.it>.

[gh]: https://github.com/justmorenoise/animo/security/advisories/new

Include what you did, what happened, and what you expected. You can expect an
acknowledgement within a few days; this is a small project, not a company with
an on-call rota.

## Scope

Animo runs entirely in the browser: there is no server, no account and no
telemetry. Your projects live in your own file system and in this origin's
IndexedDB. The interesting surface is therefore:

- **Opening a file.** A `.animo` is a zip that the app parses and validates
  (`validateProject`). A crafted file that escapes that validation, reads
  outside the project, or executes anything is in scope.
- **Importing a PSD.** Parsed by `ag-psd` in the page.
- **The preview iframe.** It runs the vendored DragonBones runtime over
  `postMessage`; a message that makes it do something outside its own document
  is in scope.
- **Exported files.** `animo-pixi.js` ships inside other people's games, so
  anything that makes it unsafe there matters more than a bug in the editor.

Out of scope: vulnerabilities in browsers themselves, and anything that needs
the user to paste code into the console.
