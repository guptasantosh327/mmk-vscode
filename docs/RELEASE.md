# Releasing

The extension ships first, against the mongo-migrate-kit users already have (1.5.0).
mongo-migrate-kit's next release comes later, after the owner has tested it. The extension needs no
update for it: it detects what the project's mmk can do, and the applied-file warning and
read-only database users switch on by themselves.

## 1. Mongo Migrate Kit 1.0.1: the library's name, a new ID (now)

1.0.0 went out on 2026-10-18 as `guptasantosh327.mmk-vscode` ("mmk for VS Code"), on the VS Code
Marketplace only. 1.0.1 is the same extension named after the library, with the ID
`guptasantosh327.mongo-migrate-kit`. A new ID is a new listing, so the old one is retired by hand.

1. Put the date in `CHANGELOG.md` (`## 1.0.1 · <date>`).
2. Check that the namespace `guptasantosh327` exists on [Open VSX](https://open-vsx.org/), with a
   token. The Marketplace publisher exists already.
3. Push `main` to GitHub **before** publishing: the Marketplace page shows the README's images from
   the repository (`vsce` points relative image paths at it).
4. `npm ci && npm run package`, and install the `.vsix` once to check it
   (`code --install-extension mongo-migrate-kit-1.0.1.vsix`).
5. `npx vsce publish --packagePath mongo-migrate-kit-1.0.1.vsix` and
   `npx ovsx publish mongo-migrate-kit-1.0.1.vsix -p <token>`.
6. Tag it: `git tag v1.0.1 && git push origin v1.0.1`.
7. Retire `mmk-vscode`: on the [publisher page](https://marketplace.visualstudio.com/manage),
   **Unpublish** it (it can be published again later), or delete it for good with
   `npx vsce unpublish guptasantosh327.mmk-vscode`. Copies already installed keep working but get
   no updates.

## 2. mongo-migrate-kit's next release (later, after testing it)

**Testing it first:** `.vscode-test/mongo-migrate-kit-1.6.0-dev.0.tgz` in this repo (ignored by
git) is a build of the five branches below, merged. Install it into any project with
`npm install --no-save <path to the .tgz>`; `npm ci` (or `npm install`) puts the project's own
version back.

Merge these branches into `main`, in this order. The conflicts are all additions next to each
other: keep both sides.

| Branch | Request | Conflicts to expect |
| --- | --- | --- |
| `feat/config-json` | R2 | none |
| `feat/json-output` | R9, R10 | `CHANGELOG.md` (each branch adds an `Unreleased` heading: make it one) |
| `feat/read-only-reads` | R3 | `CHANGELOG.md` |
| `feat/status-checksum` | R5 | `CHANGELOG.md` |
| `feat/vscode-docs` | R8 | `CHANGELOG.md`, the docs sidebar |

**Don't merge** `feat/test-rollback` (R6) or `feat/lint` (R7): both were dropped.

**Before merging `feat/vscode-docs`:** its page, `docs/guide/vscode.md`, must call the extension
Mongo Migrate Kit and link `guptasantosh327.mongo-migrate-kit`, not the retired `mmk-vscode`.

Then in mongo-migrate-kit: `npm run typecheck && npm run lint && npm test && npm run docs:build`,
and `npm run release`, picking **minor** (1.6.0). `docs/guide/vscode.md` there names **1.6.0** as
the version with R3 and R5: if the release gets another number, change it first.

## 3. Mongo Migrate Kit 1.0.x after that release (docs and pinning only)

The released extension already works with it. This update only brings the docs and tests in step:

```bash
npm install --save-dev --save-exact mongo-migrate-kit@1.6.0
```

- **Imports instead of local declarations** (CLAUDE.md rule 2):
  - `WireStatusRow` in `src/mmk/contract.ts` becomes `Wire<StatusRow>` (R5's `checksum` is in
    `StatusRow`).
  - `ProjectConfig` can become mmk's `ConfigSummary` (R2; see its note in MMK-REQUESTS.md).
- **Contract tests:** with 1.6.0 pinned, `hasNextMmk()` is true on the `pinned` CI job, and the
  `1.5.0` job keeps running the 1.5 branches. Keep both: the extension still supports 1.5.x.
- **README:** move "Coming with the next mongo-migrate-kit" into the feature sections, naming the
  version, and record the applied-file GIF again
  (`MEDIA_SCENES=applied-edit node scripts/media/record.mjs`, see the script's header).
- `homepage` in package.json can point to mmk's new page,
  `https://mongo-migrate-kit.vercel.app/guide/vscode`, once the docs site is deployed.
- Set each request's status in MMK-REQUESTS.md to `released in mmk 1.6.0`, update CLAUDE.md §0,
  add a CHANGELOG entry, and publish as in step 1.

## Recording the README media again

The GIFs in `media/readme/` come from the real extension, recorded by `scripts/media/record.mjs`
(see its header). Record again after a UI change; never edit the images by hand.
