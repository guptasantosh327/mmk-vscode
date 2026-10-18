# Releasing

**Order (owner, 2026-10-18):** mongo-migrate-kit 1.6.0 first, then the extension's **1.1.0**,
pinned to it. 1.1.0 is the first release as **Mongo Migrate Kit**: the rename (1.0.1, never
published), the migration console and the environments pipeline (Phase 7), and what
mongo-migrate-kit 1.6.0 switches on. It still works with mongo-migrate-kit 1.5.0.

## 1. mongo-migrate-kit 1.6.0 (owner, in MMK_REPO)

Everything the extension asked for is in mongo-migrate-kit's `main`: R2, R3, R5, R8, R9 and R10
(PRs #11–#15). Checked on `fdd4de3`: typecheck, lint, 622 tests, build and the docs build pass,
and so do this extension's contract and integration tests against a build of it.

1. In its `CHANGELOG.md` "Unreleased": move `mmk config [--json]`, `loadConfigWithSources()` and
   "A failed run says what ran first" from **Fixed** to **Added** (they're new), drop the blank
   line inside **Fixed**, and call `### Docs` `### Documentation`, as older releases do.
2. `npm run release`, picking **minor** (1.6.0). `docs/guide/vscode.md` there names 1.6.0 as the
   version with R3 and R5: if the release gets another number, change it first.

## 2. Pin mongo-migrate-kit 1.6.0 here (once it's on npm)

The shipped extension contains no mmk: this step changes only types and tests. Do it before
publishing, so CI proves 1.6 on every push from then on.

```bash
npm install --save-dev --save-exact mongo-migrate-kit@1.6.0
```

- **Imports instead of local declarations** (CLAUDE.md rule 2):
  - `WireStatusRow` in `src/mmk/contract.ts` becomes `Wire<StatusRow>` (R5's `checksum` is in
    `StatusRow`).
  - `ProjectConfig` becomes a `Pick` of mmk's `ConfigSummary` (R2).
- Those compile only against 1.6's types, so in `.github/workflows/ci.yml` run the **Typecheck**
  step only on the pinned job (`if: matrix.mmk == 'pinned'`). The `1.5.0` job still lints and runs
  every test suite, which is what proves 1.5 support.
- `test/contract/harness.ts`: `NEXT_MMK` is now the pin. Keep the 1.5 branches while
  `MIN_MMK_VERSION` is 1.5.0, and update the comment that says to delete them.
- Run every suite on the pin, then on 1.5.0 (`npm install --no-save mongo-migrate-kit@1.5.0`),
  then `npm ci`. Update CLAUDE.md §0 (the pinned version).

## 3. Publish Mongo Migrate Kit 1.1.0

1.0.0 went out on 2026-10-18 as `guptasantosh327.mmk-vscode` ("mmk for VS Code"), on the VS Code
Marketplace only. 1.1.0 has the ID `guptasantosh327.mongo-migrate-kit`. A new ID is a new listing,
so the old one is retired by hand.

1. Put the date in `CHANGELOG.md` (`## 1.1.0 · <date>`).
2. Check that the namespace `guptasantosh327` exists on [Open VSX](https://open-vsx.org/), with a
   token. The Marketplace publisher exists already.
3. Push `feat/console` (it holds `chore/rename-mongo-migrate-kit` too), open a pull request into
   `main`, let CI pass on both mmk versions, and merge it. `main` must be on GitHub **before**
   publishing: the Marketplace page shows the README's images from the repository (`vsce` points
   relative image paths at it).
4. `npm ci && npm run package`, and install the `.vsix` once to check it
   (`code --install-extension mongo-migrate-kit-1.1.0.vsix`).
5. `npx vsce publish --packagePath mongo-migrate-kit-1.1.0.vsix` and
   `npx ovsx publish mongo-migrate-kit-1.1.0.vsix -p <token>`.
6. Tag it: `git tag v1.1.0 && git push origin v1.1.0`.
7. Retire `mmk-vscode`: on the [publisher page](https://marketplace.visualstudio.com/manage),
   **Unpublish** it (it can be published again later), or delete it for good with
   `npx vsce unpublish guptasantosh327.mmk-vscode`. Copies already installed keep working but get
   no updates.

## 4. After publishing: mmk's page about the extension (R8)

https://mongo-migrate-kit.vercel.app/guide/vscode is live (the docs site deploys from mmk's
`main`), but it still calls the extension "mmk for VS Code" and links the retired
`guptasantosh327.mmk-vscode`. In MMK_REPO, on a `feat/` branch (CLAUDE.md rule 3):

- name it Mongo Migrate Kit and link `guptasantosh327.mongo-migrate-kit` on the Marketplace and
  Open VSX (those links work only once step 3 is done);
- add the migration console, the environments pipeline and environment colours;
- keep the compatibility table: 1.5.0 or later, 1.6.0 for the applied-file warning and read-only
  users.

Merging it publishes it. Then `homepage` in package.json can point to that page.

## Recording the README media again

The GIFs in `media/readme/` come from the real extension, recorded by `scripts/media/record.mjs`
(see its header). Record again after a UI change; never edit the images by hand.
