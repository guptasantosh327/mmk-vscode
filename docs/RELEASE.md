# Releasing 1.0

The extension is built and tested against an unreleased mongo-migrate-kit: the requests in
[MMK-REQUESTS.md](MMK-REQUESTS.md) are built, each on its own branch in mongo-migrate-kit. Releasing
is the owner's step, in this order: mongo-migrate-kit first, then the extension.

## 1. Release mongo-migrate-kit

Merge the request branches into `main`, in this order. The conflicts are all additions next to
each other: keep both sides.

| Branch | Request | Conflicts to expect |
| --- | --- | --- |
| `feat/config-json` | R2 | none |
| `feat/json-output` | R9, R10 | `CHANGELOG.md` (each branch adds an `Unreleased` heading: make it one) |
| `feat/read-only-reads` | R3 | `CHANGELOG.md` |
| `feat/status-checksum` | R5 | `CHANGELOG.md` |
| `feat/test-rollback` | R6 | `CHANGELOG.md`; two private fields of `MigratorKit` next to each other |
| `feat/lint` | R7 | `CHANGELOG.md`, `src/types/index.ts`, `src/core/migrator.ts` (the `node:fs` import and the new methods), `tests/integration/cli.test.ts`, the docs sidebar, `docs/reference/cli.md`, `docs/guide/ci-cd.md` (keep `mmk lint`, then `mmk test-rollback`) |
| `feat/vscode-docs` | R8 | `CHANGELOG.md`, the docs sidebar |

Then in mongo-migrate-kit: `npm run typecheck && npm run lint && npm test && npm run docs:build`
(the combined build passed 670 tests), and `npm run release`, picking **minor** (1.6.0).
`docs/guide/vscode.md` and this extension's README name **1.6.0** as the version with
R3/R5/R6/R7: if the release gets another number, change both.

## 2. Pin it here

```bash
npm install --save-dev --save-exact mongo-migrate-kit@1.6.0
```

Then, in one commit:

- **Imports instead of local declarations** (CLAUDE.md rule 2), now that mmk exports the types:
  - `WireStatusRow` in `src/mmk/contract.ts` becomes `Wire<StatusRow>` (R5's `checksum` is in
    `StatusRow`).
  - `RollbackTestReport`, `RollbackTestResult`, `RollbackFailure`, `RollbackStep`, `LintReport`
    and `LintFinding` in `src/mmk/contract.ts` become imports from `mongo-migrate-kit` (R6, R7).
  - `ProjectConfig` can become mmk's `ConfigSummary` (R2; see its note in MMK-REQUESTS.md).
- **Contract tests:** with 1.6.0 pinned, `hasNextMmk()` is true on the `pinned` CI job, and the
  `1.5.0` job keeps running the 1.5 branches. Keep both: the extension still supports 1.5.x.
- **`MIN_MMK_VERSION`** stays `1.5.0` (features that need 1.6.0 detect it and say so). To require
  1.6.0 instead, raise it, change the CI matrix's `1.5.0` to `1.6.0`, delete the 1.5 branches of
  the contract and integration tests, and update the README's compatibility table and the "too
  old" welcome text.
- Set each request's status in MMK-REQUESTS.md to `released in mmk 1.6.0`, and update CLAUDE.md §0.

Run everything: `npx biome check src test && npx tsc --noEmit && npm test && npm run
test:contract && npm run test:integration`.

## 3. Publish the extension

1. Put the date in `CHANGELOG.md` (`## 1.0.0 · <date>`).
2. Check that the publisher `guptasantosh327` exists on the
   [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage) and the namespace on
   [Open VSX](https://open-vsx.org/), with tokens for both.
3. Push `main` first: the Marketplace page shows the README's images from GitHub
   (`vsce` points relative image paths at the repository).
4. `npm run package` and try the `.vsix` once (`code --install-extension mmk-vscode-1.0.0.vsix`).
5. `npx vsce publish` and `npx ovsx publish mmk-vscode-1.0.0.vsix -p <token>`.

## Recording the README media again

The GIFs and screenshots in `media/readme/` come from the real extension, recorded by
`scripts/media/record.mjs` with the next mongo-migrate-kit installed (see its header). Record
again after a UI change; never edit the images by hand.
