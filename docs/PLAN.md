# Plan — Mongo Migrate Kit for VS Code

Seven phases. **Each phase ends when its exit criteria pass**: lint, typecheck, unit, contract and
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
| 5 | ~~Rollback tests + lint~~ dropped | ~~A4~~ | ~~R6, R7~~ |
| 6 | Stable 1.0 release | — | R8 |
| 7 | Migration console + pipeline sidebar | C1–C13, B (canvas) | R11, R12 (both optional) |

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
   *Changed (owner, 2026-10-18):* a run that succeeds no longer gets a notification, and its
   progress shows in the status bar instead of a notification; the views show the result.
   Failures and runs that did nothing still get one.
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

*Built as:*
- `src/mmk/environments.ts` parses `mmk.environments` (names, `readOnly`, `color`; anything but
  `local` is read-only unless it says `"readOnly": false`) and holds the one rule every run goes
  through: `assertCanRun` lets a read-only environment run only commands that never write to a
  database (`status`, `list`, `dry-run`, `config`, `create`). The store calls it in
  `run()`, so the UI hiding write actions is a convenience, not the guard.
- Connections are per **project and environment** (`mmk.connection:<env>:<projectDir>` in
  `context.secrets`), so a monorepo's projects can point staging at different databases. A
  project without one shows "isn't set up" for that environment instead of an error.
- `MmkStore` reads every environment of every project (coalesced per environment) and keeps
  `environments[name]`; `rows` / `error` / `loading` are the selected one's. Reads of other
  environments follow file changes like local's. The config is read once per project, with the
  first environment that asks; if local has no connection string (which mmk 1.5's config bridge
  needs), a stored environment's connection is tried.
- Writes on any environment but `local` ask in a modal first, even `up`. `create` always runs on
  local (it never connects).
- Copy CLI command on another environment writes `MMK_URI='<staging connection string>'
  MMK_DB=<db> npx mmk …`: the connection string is never copied.
- A connection string found in `mmk.environments` (`uri`, `connectionString`, …) gets a warning
  with "Move to keychain", which stores it and removes it from the setting.
- The matrix (`src/mmk/matrix.ts`, `src/views/matrix/`) only lays out each database's own
  `status` verdicts; its notes compare those verdicts ("On staging, not prod", "Only on local so
  far", "Not on local yet", "Edited after it ran"). Its unit test is the C2 mockup's own data.
- "Compare files from: origin/main" copies that ref's migrations folder with `git ls-tree` +
  `git cat-file --batch` (byte for byte, no checkout, no index change) into a temp folder, runs
  `mmk status --dir <temp>` on each environment, and deletes the folder.
- The branch-switch warning only names files that **are on another branch's tip**
  (`git cat-file --batch-check <ref>:<path>` for every branch), so migrations whose files were
  deleted everywhere never nag. Each file is reported once per branch.
- Integration tests keep VS Code off the OS keychain with `--password-store=basic`.

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

*Built as:*
- `src/mmk/checksum.ts` is the mirrored hash (rule 1, exception 1). A clean document is hashed
  from its bytes on disk, exactly as mmk reads it, so mixed line endings (which VS Code
  normalizes in the editor) can't cause a false warning. A dirty one is hashed from its text,
  with the BOM put back when the file on disk has one: reading the file's first bytes replaces
  `TextDocument.encoding`, which `engines.vscode ^1.90` doesn't have. `checksum.contract.test.ts`
  checks LF, CRLF, BOM, BOM + CRLF and non-ASCII files against the checksum mmk wrote, read
  from the changelog directly (so it runs on 1.5 too), and against `StatusRow.checksum` from
  mmk 1.6.
- Every environment's rows are compared, not only the selected one: the warning names each
  environment whose recorded checksum differs (`src/mmk/applied-edits.ts`).
- The changed range is the diff against the file on disk while that is still the version that
  ran (an unsaved edit), otherwise against the version found in git. Until git answers, it's the
  line of `up()`.
- With an mmk that reports no checksums (1.5), nothing warns. mongo-migrate-kit 1.6.0 reports
  them (R5), and the warning switches on by itself.
- The applied version is found with one `git log --follow --name-only` and one
  `git cat-file --batch` over every version of the file. The newest commit whose content hashes
  to the recorded checksum wins, so a pure rename commit counts as that version.
- "Undo my edit" reverts the editor when the file on disk is still the version that ran, and
  otherwise restores it from git. "Restore applied version" replaces the text and saves the
  file. The diff's title actions show while `mmk.inAppliedDiff` is set (the active tab is a diff
  whose left side is `mmk-applied:`).

---

## Phase 5 — Rollback tests and lint (dropped)

**Dropped on 2026-10-18 by the owner**, to keep the extension and mongo-migrate-kit simple for
their users: neither was required for 1.0. Both were built first: `mmk test-rollback` (R6) and
`mmk lint` (R7) on their own mongo-migrate-kit branches, and Test Explorer items plus lint
diagnostics in the extension (commit `f45f47d` on `feat/rollback-tests`). The mongo-migrate-kit
branches are kept, unmerged, in case they come back; the extension code was removed in the 1.0
release branch. Design screen A4 and A3's *Test rollback* button aren't built.

The original goal was to find a broken `down()` before it's needed: run up → down → up on a
temporary database (R6) and flag risky patterns in migration files (R7).

---

## Phase 6 — Stable 1.0

**Needs from mmk:** **R8** (a docs page for the extension in mmk's docs site).

**Tasks:** a README with recorded GIFs of the real extension (no invented output); a compatibility
table (extension version ↔ minimum mmk version); the Marketplace listing (icon from mmk's monochrome
logo as SVG, categories, keywords); a CHANGELOG; publish with `vsce` + `ovsx`. **No telemetry.**
Say so in the README.

**Exit criteria:** 1.0.0 is published on both marketplaces, and the README shows each feature.

*Built as:*
- R8 is `docs/guide/vscode.md` in mongo-migrate-kit (branch `feat/vscode-docs`).
- The README's GIFs and screenshots are recorded from the real extension by
  `scripts/media/record.mjs`: a demo project with migrations applied on three databases of an
  in-memory replica set, VS Code launched with `--remote-debugging-port`, scenes played by
  `scripts/media/driver.cjs` (inside VS Code, through the extension's commands), frames captured and
  keys typed over the DevTools protocol, GIFs encoded with `gifenc` (installed `--no-save`, as
  mongo-migrate-kit does for its docs). B1's frame shows the warning in Problems: VS Code doesn't
  open a hover in a window that isn't focused.
- The icon is mmk's logo mark, white on its green, in `media/icon.svg`, rendered to
  `media/icon.png` by `scripts/media/render-icon.mjs` (headless Chrome).
- CI runs every suite on the pinned mongo-migrate-kit and on `MIN_MMK_VERSION` (1.5.0); a contract
  test keeps the matrix and the constant in step.
- Publishing is the owner's step: `docs/RELEASE.md` lists it, after releasing mongo-migrate-kit.

---

## Phase 7 — Migration console and pipeline sidebar

**Goal:** one place to see every migration on every environment and act on it, plus the
environments as a pipeline in the sidebar. Design: the canvas
<https://claude.ai/artifact/HkfYg1uFrqRcdXYekFnXSg>, page **C · Flows** (C1–C13 and the flow map)
and frame **B** on page **Directions**. Drawn in VS Code's theme colours only: the owner chose
them over the custom looks on page **C · Styles** (2026-10-18). `design/SCREENS.md` has the notes.

**Needs from mmk:** nothing that isn't released. Optional: **R11** (who holds the lock, from a
command that doesn't release it) and **R12** (the batch a run would record, in `dry-run`). Until
they're released, the console shows the lock only when a run reports `LOCK_ALREADY_HELD`, and the
plan says "as one new batch" without a number. *R11 was built for mongo-migrate-kit 1.6.0 at the
owner's request (2026-10-19); see "Lock UI" below.*

**Tasks**
1. **Console (C1–C4):** the environments matrix grows into the migration console, one editor tab
   per project. "mmk: Open migration console" opens it; "Compare all environments" opens it with
   *Only differences*. It has the project and branch, environment tabs (picking one selects it for
   every command, as the status bar does), filters (*All*, *Pending*, *Needs attention*, *Only
   differences*), files from your branch or `origin/main` (as in Phase 3), the migrations ×
   environments table (`buildMatrix`), a detail panel for the selected migration (its record on
   each environment, the actions the selected environment allows, the CLI command), and the
   selected environment's batches (`buildStatusModel`).
2. **Actions** run the existing commands with `{ dir, file }`: up, down, redo, dry run, copy CLI
   command, show applied version, create. The read-only rule, the confirmations and the results
   stay where they are.
3. **Roll back a batch (C9):** `mmk down --batch N --json` (mmk 1.5 has it), after a modal that
   names every file in the batch. A new command, `mmk.downBatch`, with a contract test for its JSON.
4. **Plan, running, result (C6–C8)** inside the console: the plan is `dry-run up`'s rows; *Apply*
   runs `up`; while it runs, mmk's own output streams into the panel (no Stop: halting a migration
   midway could leave data half-changed); the result lists each `RunResult`, and on a failure
   shows mmk's error as is, with what ran before it from R10's `details.results` (on 1.5, from a
   status read).
5. **When something needs you (C10–C12):** an edited file links to *Show applied version* (R5);
   `LOCK_ALREADY_HELD` shows mmk's message and *Release the lock…* (the existing unlock); an
   environment that can't be read shows mmk's error as is, with *Try again*, *Edit connection* and
   *Show output*. *Add environment* (C13) stays the existing command.
6. **Pipeline sidebar (B):** a webview view at the top of the mmk container: each environment as a
   step (pending count, read-only, the latest migration applied, the lock once R11 is released),
   the selected environment's pending migrations, and *Review N pending on <env>*, which opens the
   console's plan. The tree stays below it for keyboard users.
7. **Theme:** only `--vscode-*` variables and codicons, nothing hard-coded (CLAUDE.md §4 and §8).

**Tests:** unit tests for the console model (filters, the detail for each state and environment,
which actions are offered, history); a contract test for `down --batch`; integration tests that
open the console, select a migration, run up from it, offer no write action on a read-only
environment, and need the modal before rolling back a batch.

**Exit criteria:** from the console alone, plan and apply local's pending migrations, roll back a
batch and compare every environment, with nothing written to a read-only environment.

**PHASE 7 COMPLETE** (2026-10-18): every exit criterion is covered by an integration test
(plan and apply, batch rollback behind its modal, comparison, a read-only plan that writes
nothing). R11 and R12 stay optional and open.

**Lock UI** (owner, 2026-10-19: "the extension doesn't have any UI for the lock"): with R11
(`mmk lock --json`, mongo-migrate-kit 1.6.0) the store reads each environment's lock next to its
status (`readLock`; asked once and dropped on an mmk without the command). A lock in force shows
on the environment's pipeline card, as a notice in the console (*Release the lock…* on writable
environments, which runs the existing `mmk.unlock` with its modal), on the console's tab, in the
tree (click to release, writable only) and in the status bar (`$(watch) … · locked`). A lock mmk
reports stale isn't shown: the next run takes it over. The project's own run is never shown as a
lock. Icon: `watch`, since `lock` already means read-only. Tests: unit (parser, wording, models,
store), contract (`lock --json` while a slow run holds the lock; 1.5's unknown command), and an
integration test that shows another run's lock everywhere and releases it from the console.

*Built as:*
- **Task 1 and 2 (C1–C4):** `src/mmk/console.ts` builds the console from `buildMatrix` and
  `buildStatusModel`: tabs with each environment's pending and needs-attention counts, the four
  filters, the rows, the picked migration (the user's pick, else the first pending on the selected
  environment) with its record on each environment, the buttons the selected environment allows,
  the CLI arguments, the latest three batches, and a notice (read-only, or files edited after they
  ran). It decides nothing about migrations: every state is a matrix cell, so mmk's verdict.
- The matrix panel became `src/views/console/panel.ts` (`media/console/`); `mmk.openConsole`
  opens it and `mmk.compareEnvironments` opens it on *Only differences*. The webview's messages
  are checked field by field (`isConsoleMessage`), and an action runs only if the picked
  migration's detail offers it, through the existing `mmk.*` command with `{ dir, file }`.
- The CLI line is Copy CLI command's: `terminalCommand`, and on another environment `MMK_URI`
  as a placeholder and `MMK_DB` from the stored connection.
- **Task 3 (C9):** `mmk.downBatch` ("Roll back a batch…") runs `mmk down --batch N` on the
  selected environment after a modal naming every file in the batch (from its status rows); with
  no batch given it offers the environment's batches. A contract test pins the JSON (reverted
  newest first) and mmk's `INVALID_ARGUMENT` for a batch that isn't there.
- **Task 4 (C6–C8):** *Plan* reads `dry-run up` through the store (a read, allowed everywhere).
  *Apply* goes through `applyPending` in `src/commands/run.ts`: the same read-only refusal and
  remote confirmation as *Apply all*, but it returns the outcome instead of a notification.
  `buildResult` lays out mmk's results; when mmk stops early without them (1.5, before R10), what
  ran comes from the status read after the run, never from a guess. The store emits mmk's stderr
  lines (`onDidOutput`, credentials hidden), so a run from anywhere shows live in the console.
- **Task 5 (C10–C12):** edited files link to *Show applied version*; a result with
  `LOCK_ALREADY_HELD` offers *Release the lock…* (the existing unlock, with its modal); an
  environment that can't be read shows mmk's message as is, with *Try again*, *Edit connection*
  (not for local, whose connection comes from the project) and *Show output*. Counts and batches
  of an unreadable environment aren't shown.
- **Task 6 (B):** `src/mmk/pipeline.ts` builds the pipeline from the same matrix inputs as the
  console (`matrixInputs`); `src/views/pipeline.ts` is a `WebviewView` (`mmk.pipeline`) above the
  tree. *Review* opens the console and its plan; picking a migration opens the console on it.
- Both webviews were checked in headless Chrome with Dark Modern's colours (no script errors;
  C1–C4, C6–C8, C11, C12 and B as drawn). Integration tests drive them through `receive()`.
