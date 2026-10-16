# Plan — mmk for VS Code

Six phases. **Each phase ends when its exit criteria pass**: lint, typecheck, unit, contract and
integration tests are green. At that point, say `PHASE N COMPLETE`, update `CLAUDE.md` §0, and wait
for the go-ahead. Don't start the next phase early. This is the same discipline as mongo-migrate-kit's
own build.

Some phases need a change in mongo-migrate-kit first. Those are listed as **"Needs from mmk"** with an
ID from `docs/MMK-REQUESTS.md`. A phase can't finish until its requests are **released** in mmk
(or available through `file:../mongo-migrate-kit` while developing). If one isn't, stop and say so.

| Phase | What ships | Screens | Needs from mmk |
|---|---|---|---|
| 1 | Foundation: scaffold, running mmk, contract tests | — | R1 (optional) |
| 2 | Local workflow (first pre-release) | A1, A2, A3 | R2, R9, R10 (all optional) |
| 3 | Environments + matrix | C1, C2 | R3, R4 (optional) |
| 4 | Applied-file protection | B1, B2 | R5 |
| 5 | Rollback tests + lint | A4 | R6, R7 |
| 6 | Stable 1.0 release | — | R8 |

---

## Phase 1 — Foundation

**Goal:** the extension can find a project's mmk, run it, and parse its JSON reliably. No real UI
yet, apart from one temporary command.

**Tasks**
1. **Scaffold.** Run the generator (`npx --package yo --package generator-code -- yo code`:
   TypeScript, esbuild, npm) **in a temporary folder**, then move its files into this repo's root.
   Keep `CLAUDE.md`, `docs/`, `design/` and `.claude/`. Add `.claude/settings.local.json` to `.gitignore`.
2. **Tooling.** Strict `tsconfig` (copy the flags from MMK_REPO `tsconfig.json`), biome (copy
   MMK_REPO `biome.json`), vitest, `@vscode/test-cli` + `@vscode/test-electron`, and
   `mongo-migrate-kit` pinned as a devDependency.
3. **CI** (GitHub Actions): biome, `tsc --noEmit`, unit, contract, and integration tests under
   `xvfb-run` on Ubuntu.
4. **Manifest.** Activation on `workspaceContains:**/mmk.config.{js,ts,json}`,
   `untrustedWorkspaces.supported: false`, `extensionKind: ["workspace"]`.
   **Decision (made in Phase 1):** projects configured only through environment variables are
   found by their `package.json`, with no manual command. The extension also activates on
   `workspaceContains:**/package.json` (instead of `onStartupFinished`, so it never activates in a
   folder without one, such as an empty folder or a Python repo) and then checks cheaply: a
   directory is a project when it has an mmk config file, or when its package.json depends on
   mongo-migrate-kit and no config-file project sits above, at or below it (`findProjectRoots` in
   `src/mmk/locate.ts` has the monorepo rules). A Node project without mmk activates the extension
   but gets nothing: no project, no UI.
5. **`src/mmk/locate.ts`:** find project root(s), including monorepos and multi-root workspaces.
   Find `node_modules/.bin/mmk` by walking up from the root. Pick Node from the `mmk.nodePath`
   setting, then `PATH`. *Built as:* the walk finds `node_modules/mongo-migrate-kit` and runs its
   `bin.mmk` script with that Node (`node <script> …`). `.bin/mmk` itself can't be used: on Windows
   it's a `.cmd` shim that `execFile` can't start without a shell, and its `#!/usr/bin/env node`
   line would ignore `mmk.nodePath`.
6. **`src/mmk/cli.ts`:** `run(args, { cwd, env, timeoutMs, signal })` using `execFile`. Parse stdout
   as JSON. On exit code 1, parse `{ error: { code?, message, details? } }` into a typed error
   (`code` is absent when the failure isn't one of mmk's own errors). Send stderr (mmk's
   human-readable log) to the output channel. Kill the process on timeout or cancel.
   *Found while building:* `status --check` exits 1 with rows, not an error document, so the
   error is detected by shape, not exit code. A `console.log` in a migration, hook or config lands
   on stdout before mmk's JSON (R9), so the parser reads the last JSON document and logs the rest.
7. **`src/mmk/contract.ts`:** `Wire<T>` over types imported from `mongo-migrate-kit`, plus small
   runtime guards for the fields the extension actually reads.
8. **`src/mmk/compat.ts`:** read `mmk --version` (or `mmk version --json` once R1 ships) and compare
   it with `MIN_MMK_VERSION`.
9. **Logging:** a `LogOutputChannel` named "mmk", with credentials masked (same behaviour as
   `MMK_REPO/src/utils/redact.ts`).
10. **Temporary command** "mmk: Show status (debug)": prints `status --json` to the output channel.

**Tests**
- Unit: JSON and error parsing, locating mmk in fixture folders (single project, monorepo, missing
  mmk), redaction, version comparison.
- Contract: real mmk + mongodb-memory-server. Assert the shapes of `status`, `list`, `dry-run up/down`,
  `up <file>`, `down <file>`, `create`, `unlock`, and the error document.
- Integration: activates in `test/fixtures/workspace`, stays inactive in an empty folder, and stays
  inactive in an untrusted workspace. *Built as:* the untrusted case runs on the packaged `.vsix`
  installed into a fresh profile (`test/integration/run-installed.mjs`), with a trusted run as
  the control. VS Code exempts an extension loaded with `--extensionDevelopmentPath` from
  Workspace Trust, and `@vscode/test-electron` always passes `--disable-workspace-trust`.

**Exit criteria:** in the fixture workspace, "mmk: Show status (debug)" prints the same rows as
running `mmk status` in a terminal, and every test suite is green in CI.

---

## Phase 2 — Local workflow (first pre-release)

**Goal:** create, run and roll back migrations on the local database without opening a terminal.
Design screens **A1, A2, A3**.

**Needs from mmk:** nothing that isn't released. The extension needs the resolved migrations
folder and file extensions, and must not re-implement config loading to get them. **R2**
(`mmk config --json`) is the clean answer and is used when the project's mmk has it. Until then,
the config bridge asks mmk 1.5's public `MigratorKit.resolveConfig()` (CLAUDE.md rule 1), so
Phase 2 works with the mmk users already have.
Optional: **R9** (stdout holds only the JSON document; the parser already copes with a
migration's `console.log`, so this doesn't block) and **R10** (results of the files that ran
before a failure, for A3).

**Tasks**
1. **Sidebar** (`TreeDataProvider` in a "mmk" activity-bar container): environment picker row,
   then *Pending on local*, *Edited after it ran*, and *Applied on local* grouped by batch, each with
   counts. A welcome view covers: mmk not installed, mmk too old, untrusted workspace, no config.
2. **Refresh:** a `FileSystemWatcher` on the migrations folder, after every command, and manually.
   Debounce it.
3. **Status bar item:** `mmk: local · N pending`. Clicking it opens the environment picker
   (local only until Phase 3).
4. **Create migration** (A1): a `QuickInput` with the name and a JS/TS toggle button, then
   `mmk create <name> --json [--ts|--js]`, then open the returned `path`. The preview shows
   `<timestamp>-<slug>.js`, because the real timestamp comes from mmk.
5. **Run links** (`CodeLensProvider`, local only), placed above `up()` and `down()`:
   *Pending on local | Run up on local | Dry run* before it runs, and *Applied on local · batch N ·
   duration | Redo | Run down on local* after. Each runs `mmk up|down|redo <file> --json` inside
   `window.withProgress`.
6. **Confirmations:** `down`, `redo` and `--force` ask in a modal first. `--force` always passes `--yes`,
   because the extension confirmed already.
7. **Results:** a notification with mmk's outcome (A3), and mmk's log in the output channel.
8. **Explorer badges** (`FileDecorationProvider`): `●` pending on local.
9. **Copy CLI command** on every action.
10. **Lock held:** show the holder from the error. Offer "Unlock…" (modal) → `mmk unlock --yes --json`.

**Tests:** unit tests for the tree model built from `StatusRow[]`; integration tests for
create → run up → applied in tree → run down in the fixture workspace with mongodb-memory-server;
a test that the modal confirmation is required for down.

*Built as:*
- `MmkStore` (`src/mmk/store.ts`) holds each project's resolved config and `status --json`.
  Reads are coalesced and debounced, commands run one at a time per project, and every command
  is followed by a read. Background reads log at debug level; commands log `$ mmk …` and mmk's
  output at info.
- The config comes from `mmk config --json` when the project's mmk has it, and otherwise from
  the config bridge: mmk 1.5's own `MigratorKit.resolveConfig()`, run in a child process on the
  user's Node (`src/mmk/project-config.ts`). Contract tests prove the bridge on the pinned 1.5.0.
- The create preview mirrors mmk's `slugify`, the second documented exception in CLAUDE.md rule 1,
  with a contract test against the real `mmk create`.
- Sidebar dates come from `YYYYMMDDHHmmss-` file names (display only). Three batches show, and
  the rest fold into "N older batches".
- No "untrusted workspace" welcome view: VS Code disables the whole extension in Restricted
  Mode, so none of its views exist there. VS Code's own Restricted Mode banner covers it.
- The A3 notification leaves out "transaction committed": mmk's run result doesn't say whether
  a transaction was used, and the extension doesn't guess.
- `down` on a file mmk reports as edited (`CHECKSUM_MISMATCH`) offers "Roll back anyway…": a
  second modal, then `down <file> --force --yes`. `LOCK_ALREADY_HELD` offers "Unlock…".
- Integration tests answer the modals through `MmkTestApi.setConfirm`, which `activate()` returns
  only in test mode. The workflow tests run in a copy of the fixture under `.vscode-test/`.

**Exit criteria:** the A1 → A2 → A3 flow works end to end. Publish **0.1.0 as a pre-release**
(`vsce publish --pre-release`, plus `ovsx`).

---

## Phase 3 — Environments

**Goal:** compare your branch with staging and prod safely. Design screens **C1, C2**.

**Needs from mmk:** **R3** (read commands never write on connect, so read-only database users work).
**R4** is optional.

**Tasks**
1. **Environment model:** `mmk.environments` in settings holds only names, read-only flags and
   colors. Each environment's URI and database live in `context.secrets`, keyed by workspace and
   environment name. `local` means "the project's own config / `.env`", with nothing stored.
2. **"mmk: Add environment":** name → masked URI input → database (pre-filled from the URI path) →
   test connection (`status --json`) → read-only (on by default for anything not `local`).
   Also "Edit" and "Remove".
3. **Injection:** pass `MMK_URI` / `MMK_DB` as environment variables to `execFile`. They win over the
   config file and `.env` (mmk loads `.env` with `override: false`).
4. **Switcher** (C1): a `QuickPick` from the status bar or sidebar (name, host with password masked,
   pending count, read-only note) plus "Compare all environments…", "Add environment…" and
   "Edit environments". Status bar background follows the environment (CLAUDE.md §8).
5. **Read-only enforcement:** for read-only environments, run links only offer *Dry run* and
   *Copy CLI command*, and write commands refuse in code, not just in the UI.
6. **Matrix** (C2, webview): files × environments, with states *Applied · date*, *Pending*,
   *Edited after it ran*, and **Applied, file not in your branch** (`fileMissing`). Add a notes column
   ("On staging, not prod", "Only on local so far"), an "Only differences" filter, and refresh.
7. **"Compare files from: your branch | origin/main":** for origin/main, copy that ref's migrations
   folder into a temp folder (`git archive`, without changing the user's checkout) and run
   `mmk status --dir <temp> --json`. Delete the temp folder afterwards.
8. **Branch-switch warning:** after a checkout (git extension API), if local has an applied migration
   whose file isn't in this branch, say so and name the branch it likely came from.

**Tests:** contract tests with a read-only MongoDB user (auth-enabled memory server); unit tests for
the matrix model; integration tests that a read-only environment can't run `up`.

**Exit criteria:** add staging with a read-only user, see the matrix with correct notes, and be unable
to write to staging from anywhere in the UI.

---

## Phase 4 — Applied-file protection

**Goal:** catch edits to migrations that have already run, before they're saved. Design screens
**B1, B2**.

**Needs from mmk:** **R5** (the recorded checksum in `status --json`; today it only says
`checksumOk`).

**Tasks**
1. **Diagnostic** (`DiagnosticCollection`, source `mmk`, code `applied-edited`): on open and on every
   change to a migration file, hash the buffer text the way mmk does and compare it with the
   recorded checksum of each environment from its last status. Show a warning on the changed range,
   a hover (B1 copy), a Problems entry, an Explorer `!` badge, and a run link
   "Applied on … · edited since | Show applied version".
2. **Applied version:** walk `git log --format=%H --follow -- <file>`, hash `git show <sha>:<path>`
   for each, and take the first match. Open `vscode.diff` (left side = a
   `TextDocumentContentProvider` on a `mmk-applied:` scheme, right side = the working file).
3. **Actions** on the diff's editor title: *Restore applied version* (a `WorkspaceEdit` replacing the
   file text) and *Create a new migration*. The mockup's banner becomes these title actions plus an
   information message, because a diff editor can't host a banner.
4. **Hashing traps:** VS Code strips a UTF-8 BOM from document text, but mmk's `readFileSync(utf8)`
   keeps it, so add it back when the document's encoding is `utf8bom`. CRLF line endings must be
   hashed as they are on disk. Contract fixtures cover BOM, CRLF and LF files.

**Tests:** contract test that the extension's hash equals mmk's recorded checksum for each fixture;
unit tests for the git search on a fixture repo with history; integration test that typing in an
applied file raises the diagnostic before save.

**Exit criteria:** editing an applied file warns before saving, and "Show applied version" opens the
matching commit's version.

---

## Phase 5 — Rollback tests and lint

**Goal:** find a broken `down()` before it's needed. Design screen **A4**.

**Needs from mmk:** **R6** (`mmk test-rollback --json`) and **R7** (`mmk lint --json`). Both are
designed and built in MMK_REPO first.

**Tasks:** a `TestController` with one test item per migration and steps up / down / up again.
Show failures as a `TestMessage` at the failing line (A4), with results in Test Explorer and the
Test Results panel. Show lint findings as diagnostics (source `mmk`, code = the lint rule).

**Exit criteria:** the A4 example (`dropIndex` using the default index name after `up()` created a
custom name) fails in Test Explorer with mmk's message at line 12.

---

## Phase 6 — Stable 1.0

**Needs from mmk:** **R8** (a docs page for the extension in mmk's docs site).

**Tasks:** a README with recorded GIFs of the real extension (no invented output); a compatibility
table (extension version ↔ minimum mmk version); the Marketplace listing (icon from mmk's monochrome
logo as SVG, categories, keywords); a CHANGELOG; publish with `vsce` + `ovsx`. **No telemetry.**
Say so in the README.

**Exit criteria:** 1.0.0 is published on both marketplaces, and the README shows each feature.
