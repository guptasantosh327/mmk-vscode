# CLAUDE.md — Mongo Migrate Kit for VS Code

> Read this file **completely** before writing code. It loads every session.
> The plan is in `docs/PLAN.md`, the design in `design/SCREENS.md`, and the core changes this
> extension needs from mongo-migrate-kit in `docs/MMK-REQUESTS.md`.

---

## 0. Status & how to resume

> Keep this block short and current. Update it at the end of every phase.

- **1.1.0 ready to publish** (2026-10-18, branch `feat/console`, stacked on
  `chore/rename-mongo-migrate-kit`, not pushed). The first release as **Mongo Migrate Kit**, the
  library's name, with a new ID, `guptasantosh327.mongo-migrate-kit` (owner's decision); 1.0.1,
  the rename alone, was never published. It brings Phase 7 (the migration console and the
  pipeline sidebar, `docs/PLAN.md`) and what mongo-migrate-kit 1.6.0 switches on. 1.0.0 went out
  as `guptasantosh327.mmk-vscode` ("mmk for VS Code"), retired after 1.1.0 ships. In-editor labels
  stay `mmk`, the CLI's name. **Release order (owner, 2026-10-18):** mongo-migrate-kit 1.6.0
  first, then pin it here (`docs/RELEASE.md` step 2), then publish 1.1.0, then fix mmk's docs
  page about the extension (R8 follow-up, step 4). The extension still supports 1.5.0: there the
  applied-file warning, read-only database users and the lock UI stay off. **R11** (`mmk lock`)
  is built on MMK_REPO branch `feat/lock-command` for 1.6.0 (owner held the release for it,
  2026-10-19), with the extension's lock UI on `feat/console`. R12 is open, not built. Phase 5
  (rollback tests, lint) was built and then dropped.
- **Developing against unreleased mmk:** see `docs/MMK-REQUESTS.md` (top): merge the request
  branches into mmk's `main` in a throwaway clone, stamp it with the next version plus `-dev.0`,
  `npm pack`, then `npm install --no-save <tarball>` here. Contract tests switch on `NEXT_MMK` in
  `test/contract/harness.ts`. `npm ci` puts the pin back; check both before committing.
- **Repo:** github.com/guptasantosh327/mmk-vscode (push over HTTPS; `gh` here is logged in as
  santosh-lodha, which can read the repo's CI runs but not push).
- **mmk version the contract tests pin:** 1.5.0, until 1.6.0 is on npm (`docs/RELEASE.md` step
  2). CI runs every suite on the pin and on `MIN_MMK_VERSION` (1.5.0), and a contract test keeps
  that matrix and the constant in step.
- **MMK requests released:** R2, R3, R5, R8, R9 and R10 in mongo-migrate-kit 1.6.0 (PRs
  #11–#15; the owner publishes it, 2026-10-18). R8's page is live but still names the old
  extension: fix it after 1.1.0 ships. R11 is built for 1.6.0 on `feat/lock-command`, waiting to
  be merged. R4 (optional) isn't built. **R6 and R7 were dropped**
  (owner, 2026-10-18): their branches `feat/test-rollback` and `feat/lint` stay unmerged, and
  Phase 5 (rollback tests, lint) isn't in the extension.
- **Extension ID:** `guptasantosh327.mongo-migrate-kit` (`publisher`.`name`). The publisher exists
  on the VS Code Marketplace; Open VSX needs a matching namespace. The ID in tests
  (`test/integration/helpers.ts`, `test/integration/run-installed.mjs`) and
  `scripts/media/driver.cjs` follows it. `name` matches the devDependency mongo-migrate-kit; npm
  allows that, and nothing resolves it to the extension itself as long as package.json has no
  `exports`.
- **Commits** carry only the owner's name: no Claude co-author trailer.
- **Test hooks:** `activate()` returns `MmkTestApi` (store, idle, sidebar text, setConfirm,
  environments, checkBranch) only in `ExtensionMode.Test`; integration tests use it to answer the
  modals and read the tree. Commands that ask questions also take an argument object that skips
  them (`mmk.createMigration`, `mmk.addEnvironment`).
- **README media:** recorded from the real extension by `scripts/media/record.mjs` (needs
  mongo-migrate-kit 1.6 or later, for the edit warning, and
  `npm i --no-save gifenc@1.0.3 pngjs@7.0.0`). Never edit the images by hand. Last recorded
  2026-10-18 with the console.
- **Testing gotchas:** a development extension is exempt from Workspace Trust and
  `@vscode/test-electron` always passes `--disable-workspace-trust`, so trust is tested on the
  installed `.vsix` (`test/integration/run-installed.mjs`). Run from a VS Code terminal, the
  environment has `ELECTRON_RUN_AS_NODE=1`, which must be removed before launching VS Code.
- **To resume:** read this file, `docs/PLAN.md` (find the current phase), then the session-start
  note the hook printed about mongo-migrate-kit. If that repo changed since the last session,
  check its `CHANGELOG.md` for `--json` changes before continuing.

---

## 1. What this is

A VS Code extension for **mongo-migrate-kit (mmk)**, a MongoDB migration CLI and library. It brings
mmk into the editor:

- a sidebar of migrations (pending / applied by batch / edited after it ran)
- run links above `up()` and `down()` for the local database
- a warning **while typing** when someone edits a migration that has already run
- a diff against the exact version that ran, found by matching mmk's recorded checksum in git history
- environments (local / staging / prod) with staging and prod **read-only**, and a files × environments matrix

It is a **UI over the mmk CLI**. mmk decides every behaviour. This repo only calls mmk and shows
what it returns.

---

## 2. Source of truth: mongo-migrate-kit (the no-drift rules)

```
MMK_REPO = /Users/santoshgupta/Desktop/development/mongo-migrate-kit
```

`.claude/settings.json` gives this repo access to MMK_REPO. Edits there are allowed only under
rule 3. A SessionStart hook prints MMK_REPO's version, branch and last commits at the start of each
session.

### The rules

1. **Never re-implement mmk logic.** Status, pending/applied, checksum verdicts, batches, locks,
   namespaces, config resolution and error messages all come from running the project's
   `mmk <command> --json`. If the extension needs something mmk doesn't output, **do not compute it
   here**: add it to `docs/MMK-REQUESTS.md`, then build it in MMK_REPO (rule 3).
   - Two documented exceptions, each mirrored exactly and proven by a contract test against the
     real mmk:
     - Phase 4: hashing an **unsaved editor buffer**. It must match `computeChecksum` in
       `MMK_REPO/src/utils/checksum.ts` (SHA-256 of the file read as UTF-8).
     - Phase 2: the **"Create migration" preview** mirrors mmk's `slugify` (`src/mmk/naming.ts`)
       to show the file name before it exists. It's a preview only: mmk names the file, and the
       extension opens the path `mmk create --json` returns
       (`test/contract/config-and-naming.contract.test.ts`).
   - Display-only parsing is fine and decides nothing: reading the date out of a
     `YYYYMMDDHHmmss-` file name, or the host out of mmk's masked URI.
   - **The config bridge** (`src/mmk/project-config.ts`): an mmk without `mmk config --json`
     (1.5 and earlier) is asked through its public library API instead,
     `new MigratorKit({ logger: null }).resolveConfig()`, in a child process on the user's Node,
     loading the project's own mongo-migrate-kit. mmk still resolves everything; nothing is
     re-implemented, and every reason for running the CLI (§3) still holds. Use the bridge only
     for what no command of the supported mmk versions outputs, and add an `R<k>` for it as well.
2. **Never copy types.** Import them: `import type { StatusRow, RunResult, MmkErrorCode, LockInfo }
   from 'mongo-migrate-kit'` (a pinned devDependency, types only, never bundled). On the wire, `Date`
   fields are ISO strings, so wrap them with the `Wire<T>` mapped type in `src/mmk/contract.ts`.
   Never hand-write a type that mmk exports.
3. **Build what the extension needs in MMK_REPO, the mmk way.** The owner allowed edits to MMK_REPO
   (2026-10-17) for changes the extension needs. Every such change:
   - is a request `R<k>` in `docs/MMK-REQUESTS.md` first, and its status line is kept current;
   - follows MMK_REPO's own `CLAUDE.md` (read §2 and §20 there first): its standards, tests (a shape
     test for any `--json` output), docs under `docs/`, and a `CHANGELOG.md` entry;
   - is additive and non-breaking for mmk's CLI, CI and library users, and makes sense for all of
     them. Behaviour only the extension wants stays in the extension;
   - goes on its own branch in MMK_REPO (`feat/<topic>` from `main`), never onto a branch holding
     other work and never straight onto `main`;
   - is never released by Claude: the version bump, tag and `npm publish` are the owner's step.
     Until then the extension tests it through `file:../mongo-migrate-kit` (rule 7).

   Nothing else in MMK_REPO is edited from here: no drive-by fixes or refactors.
4. **Read before you touch.** Before implementing anything that calls mmk, read the relevant source:

   | Working on | Read in MMK_REPO |
   |---|---|
   | Anything | `CLAUDE.md` §0 (status), §2 (standards), §13 (CLI) |
   | Parsing `--json` output | `src/types/index.ts`, `src/cli/shared.ts` (`emitJson`, `withMigrator`), `src/cli/commands/<command>.ts` |
   | Errors shown to the user | `src/errors/index.ts`, `docs/reference/error-codes.md` |
   | Connections / environments | `src/core/config.ts` (precedence, `dotenv` with `override: false`), `CLAUDE.md` §7 |
   | Checksums / edited-file detection | `src/utils/checksum.ts`, `CLAUDE.md` §9, `status()` in `src/core/migrator.ts` |
   | Namespaces / shared databases | `src/utils/namespace.ts`, `src/core/changelog.ts`, `docs/guide/shared-database.md`, `CLAUDE.md` §0 (namespace entry). `NAMESPACE-PLAN.md` is referenced there but isn't in the repo |
   | Locks | `src/core/lock.ts`, `CLAUDE.md` §10 |
   | Where things live | `ARCHITECTURE.md` |

5. **Prove it against the real CLI.** Contract tests run the real `mmk` from the pinned
   devDependency against `mongodb-memory-server` and assert every JSON field the extension reads.
   A failing contract test means mmk changed: update `src/mmk/`, **never loosen the test**.
6. **Check the version at runtime.** `src/mmk/compat.ts` holds `MIN_MMK_VERSION`. On activation,
   run the project's `mmk --version`. If it's older, show "Update mongo-migrate-kit to X or later"
   and turn features off. Never guess at an older output shape.
7. **Testing unreleased mmk changes:** temporarily point the devDependency at
   `file:../mongo-migrate-kit`. Never commit that.

---

## 3. Architecture

```
VS Code window  ⇄  extension host (this code, TypeScript)
                         │ execFile (never a shell)
                         ▼
        <project>/node_modules/.bin/mmk <command> --json
        (the project's own mmk version, its mmk.config.*, the user's Node)
                         │
                         ▼
               MongoDB (local / staging / prod)
```

**Why run the CLI instead of importing mmk:** the project's mmk version and config (including
secret-manager config functions) always apply, the MongoDB driver is never bundled, a crashing
migration can't take down the editor, and `.ts` migrations run on the same Node as the user's
terminal.

**Layering rule:** `src/mmk/**` and `src/git/**` never import `vscode`, so they can be unit-tested with
vitest. Only `src/extension.ts`, `src/commands/**` and `src/views/**` import `vscode`.

---

## 4. Tech stack (locked — ask before adding anything)

| Piece | Choice |
|---|---|
| Language | TypeScript, strict (same compiler flags as MMK_REPO `tsconfig.json`) |
| Scaffold | `npx --package yo --package generator-code -- yo code` (TypeScript, esbuild) |
| API types | `@types/vscode` + `engines.vscode` |
| Bundler | esbuild → `dist/extension.js` |
| Webview UI | plain HTML/CSS with `--vscode-*` theme variables + `@vscode/codicons` (the Webview UI Toolkit is deprecated — don't use it) |
| Unit tests | vitest (only for code that doesn't import `vscode`) |
| Integration tests | `@vscode/test-cli` + `@vscode/test-electron` (Mocha), config in `.vscode-test.mjs` |
| Test database | `mongodb-memory-server` |
| mmk | `mongo-migrate-kit` as a **pinned devDependency** — for types and contract tests only |
| Lint / format | biome, with the same settings as MMK_REPO `biome.json` |
| Publishing | `@vscode/vsce` (VS Code Marketplace) and `ovsx` (Open VSX: Cursor, Windsurf, VSCodium) |

---

## 5. Project structure

```
├── package.json                 # extension manifest: commands, views, settings, activation
├── src/
│   ├── extension.ts             # activate(): wires everything
│   ├── mmk/                     # NO vscode imports
│   │   ├── locate.ts            # find project root(s), the installed mmk script, Node
│   │   ├── project.ts           # discoverProjects(): locate + `mmk --version` + compat per project
│   │   ├── cli.ts               # run mmk with --json, timeouts, parse { error }
│   │   ├── contract.ts          # Wire<T> over types imported from mongo-migrate-kit + guards
│   │   ├── compat.ts            # MIN_MMK_VERSION + version check
│   │   ├── format.ts            # plain-text status table for the output channel
│   │   ├── store.ts             # MmkStore: each project's config + status, coalesced reads, runs
│   │   ├── project-config.ts    # resolved config: mmk config --json, or the 1.5 resolveConfig() bridge
│   │   ├── model.ts             # sidebar groups from StatusRow[], date/duration labels
│   │   ├── naming.ts            # create preview (mirrors mmk's slugify) + display names
│   │   ├── migration-functions.ts # where up()/down() are, for run links
│   │   ├── checksum.ts          # mmk's checksum of editor text (rule 1, exception 1)
│   │   ├── applied-edits.ts     # which environments a text differs from, B1 wording
│   │   ├── log.ts               # Logger over the LogOutputChannel, masking credentials
│   │   ├── environments.ts      # mmk.environments, read-only rule (assertCanRun), MMK_URI/MMK_DB
│   │   ├── matrix.ts            # files × environments from each one's status rows (C2)
│   │   ├── console.ts           # the migration console's model, plan and result (Phase 7)
│   │   ├── pipeline.ts          # the environments pipeline's model (Phase 7, design B)
│   │   ├── lock-holder.ts       # who holds an environment's lock (mmk lock, R11), worded for the views
│   │   └── redact.ts            # mask credentials in anything logged
│   ├── git/                     # NO vscode imports
│   │   ├── git.ts               # runGit (execFile, bytes out)
│   │   ├── branches.ts          # current branch, origin/HEAD, branches whose tip has a file
│   │   ├── applied-version.ts   # find the commit whose SHA-256 matches the record
│   │   └── ref-files.ts         # copy migrations from origin/main to a temp folder
│   ├── commands/                # context.ts (Deps, targets), run.ts, create.ts, misc.ts,
│   │                            # environments.ts (C1, add/edit/remove), environment-registry.ts
│   ├── views/
│   │   ├── sidebar.ts           # TreeDataProvider
│   │   ├── codelens.ts
│   │   ├── decorations.ts       # Explorer badges
│   │   ├── applied-protection.ts # B1/B2: diagnostic, hover, mmk-applied: docs, diff, restore
│   │   ├── statusbar.ts
│   │   ├── branch-watch.ts      # after a checkout: local migrations from another branch
│   │   ├── pipeline.ts          # the pipeline webview view; its JS/CSS are in media/pipeline/
│   │   └── console/panel.ts     # the migration console webview; its JS/CSS are in media/console/
├── test/
│   ├── unit/                    # vitest
│   ├── contract/                # real mmk + mongodb-memory-server
│   ├── integration/             # @vscode/test-cli, plus installed/ + run-installed.mjs (the .vsix)
│   └── fixtures/                # workspace/ (mmk.config.js + migrations/) and empty/
├── design/                      # SCREENS.md + screens/*.dc.html (source of the mockups)
└── docs/                        # PLAN.md, MMK-REQUESTS.md
```

---

## 6. Engineering standards (mirrors MMK_REPO `CLAUDE.md` §2)

- TypeScript strict, no `any` (use `unknown` and narrow), no `@ts-ignore`, explicit return types on
  exported functions, JSDoc on every exported function.
- biome: 100 columns, single quotes, semicolons. Named exports only.
- Files `kebab-case`, classes `PascalCase`, functions `camelCase`, constants `SCREAMING_SNAKE_CASE`.
- No `console.log`. Log through the `LogOutputChannel` wrapper, which masks credentials.
- Messages to the user say what happened, the value involved, and what to do next (the same
  principle as `MMK_REPO/src/utils/explain.ts`). When mmk returns `{ error: { code, message } }`,
  **show mmk's message as is**. Don't rewrite it.
- Run processes with `execFile` and an argument array, never a shell string.
- Every feature ships with its tests in the same PR. Conventional commits, scoped by module
  (`cli`, `sidebar`, `codelens`, `env`, `matrix`, `git`, `testing`, `diagnostics`).

---

## 7. Security rules

- **Workspace Trust:** running mmk executes the project's code (its config and migrations), so the
  manifest declares `capabilities.untrustedWorkspaces.supported: false`.
- **Remote development:** `extensionKind: ["workspace"]`, so it runs next to `node_modules` and the
  database network in Remote-SSH, WSL and Dev Containers.
- **Connection strings** live only in `context.secrets` (the OS keychain). They're passed to mmk as
  `MMK_URI` / `MMK_DB` environment variables — **never as `--uri`** (arguments are visible in `ps`).
  They're never written to settings.json or logs. If settings.json contains `mongodb://user:pass@`,
  warn and offer to move it to the keychain.
- **Read-only environments** (staging and prod by default) only ever run read commands: `status`,
  `list`, `dry-run`, `status --all-namespaces`, `lock`. Write commands are only offered on environments
  marked writable (by default only `local`).

---

## 8. UX rules (from the design)

- Files always come from the **current branch's working tree**. Records come from the selected
  database. Every cross-environment view names what it compares ("Files on branch feat/x").
- The status bar shows the environment: default background for local,
  `statusBarItem.warningBackground` for staging, `statusBarItem.errorBackground` for prod.
- Nothing runs automatically. Every write is an explicit click. `down`, `redo` and `--force`
  confirm in a modal first.
- Every action can show and copy the equivalent CLI command.
- Use VS Code theme colors and codicons, not the mockup's hex values (`design/SCREENS.md` maps them).

---

## 9. What NOT to do

- ❌ Compute anything mmk can answer (statuses, verdicts, config, batches) — request it instead
- ❌ Copy a type that mongo-migrate-kit exports
- ❌ Edit MMK_REPO for anything but a request in `docs/MMK-REQUESTS.md`, or release mmk (rule 3)
- ❌ Run a write command against an environment marked read-only
- ❌ Put a connection string in argv, settings, logs or error messages
- ❌ Use the deprecated Webview UI Toolkit
- ❌ Start the next phase before the current phase's exit criteria pass
- ❌ Loosen a contract test to make it pass

---

## 10. Commands (exist after Phase 1)

```bash
npm install
npm run watch              # esbuild in watch mode
# F5 in VS Code            → Extension Development Host
npm test                   # vitest unit tests
npm run test:contract      # real mmk + mongodb-memory-server
npm run test:integration   # @vscode/test-cli, then the packaged .vsix (Linux CI needs xvfb-run)
npx biome check src test
npx tsc --noEmit
npm run package            # vsce package → .vsix
```
