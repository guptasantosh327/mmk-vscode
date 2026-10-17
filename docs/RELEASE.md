# Releasing

The extension ships first, against the mongo-migrate-kit users already have (1.5.0).
mongo-migrate-kit's next release comes later, after the owner has tested it. The extension needs no
update for it: it detects what the project's mmk can do, and the applied-file warning and
read-only database users switch on by themselves.

## 1. mmk for VS Code 1.0.0 (now)

1. Merge `release/1.0` into `main`. The branches are stacked (`feat/environments` →
   `feat/applied-file-protection` → `feat/rollback-tests` → `release/1.0`), so it's a
   fast-forward.
2. Put the date in `CHANGELOG.md` (`## 1.0.0 · <date>`).
3. Check that the publisher `guptasantosh327` exists on the
   [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage) and the namespace on
   [Open VSX](https://open-vsx.org/), with a token for each.
4. Push `main` to GitHub **before** publishing: the Marketplace page shows the README's GIFs from
   the repository (`vsce` points relative image paths at it).
5. `npm ci && npm run package`, and install the `.vsix` once to check it
   (`code --install-extension mmk-vscode-1.0.0.vsix`).
6. `npx vsce publish` (or `npx vsce publish --packagePath mmk-vscode-1.0.0.vsix`) and
   `npx ovsx publish mmk-vscode-1.0.0.vsix -p <token>`.
7. Tag it: `git tag v1.0.0 && git push origin v1.0.0`.

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

Then in mongo-migrate-kit: `npm run typecheck && npm run lint && npm test && npm run docs:build`,
and `npm run release`, picking **minor** (1.6.0). `docs/guide/vscode.md` there names **1.6.0** as
the version with R3 and R5: if the release gets another number, change it first.

## 3. mmk for VS Code 1.0.x after that release (docs and pinning only)

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
