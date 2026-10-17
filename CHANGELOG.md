# Changelog

All notable changes to this extension are documented here.

## Unreleased

### Added

- **Environments:** compare your branch with staging, prod or any other database. "mmk: Add
  environment…" asks for a name, the connection string (masked) and the database, tests the
  connection with `mmk status`, and makes it read-only unless you say otherwise. Connection
  strings stay in the OS keychain and reach mmk as `MMK_URI` / `MMK_DB`; settings hold only the
  names, read-only flags and colors (`mmk.environments`). "Edit environment…" and "Remove
  environment…" too.
- **Environment picker** from the status bar or the sidebar, with each environment's host,
  pending count and read-only note. The status bar turns amber for staging and red for prod.
- **Read-only environments** only run `status`, `list` and `dry-run`: the run links offer
  *Dry run* and *Copy CLI command*, the sidebar drops *Apply all*, and every write command
  refuses in code. Writes on any writable environment other than local ask first.
- **Run links** show the other environments next to local's: `staging: applied`.
- **Environments matrix** ("mmk: Compare all environments"): every migration against every
  environment, with notes such as "On staging, not prod" and "Only on local so far", summary
  chips, an "Only differences" filter, and a switch to compare the files on `origin/main`
  (copied from git, without touching your checkout) instead of your branch.
- **Branch switch warning:** after a checkout, local migrations whose files are on another
  branch are named, with that branch.
- A connection string written into `mmk.environments` gets a warning and a "Move to keychain"
  button.

## 0.1.0 (pre-release) · 2026-10-17

### Added

- **mmk sidebar:** the local environment, pending migrations, files edited after they ran, and
  applied migrations grouped by batch (older batches folded). "Apply all" and "Dry run" next to
  the pending list.
- **Create migration:** name input with a preview of the file mmk will create and a
  JavaScript/TypeScript toggle; opens the new file.
- **Run links** above `up()` and `down()`: run up, dry run, redo and run down on local, and what
  mmk recorded (batch, duration, edited since).
- **Explorer badges** for pending (`●`) and edited (`!`) migrations, and a status bar item with
  the pending count.
- Confirmation modals before `down`, `redo`, a forced rollback of an edited file, and releasing
  the migration lock. "Unlock…" when mmk reports the lock is held.
- **Copy CLI command** for any migration or project.
- Welcome views when there's no project, mongo-migrate-kit isn't installed or is too old, or
  Node.js isn't found.
- The view follows file changes in the migrations folder and changes to the config file and
  `.env`.
- Finds mmk projects in the workspace (config files, or a package.json that depends on
  mongo-migrate-kit), including monorepos and multi-root workspaces.
- Runs the project's own mmk with `--json`, checked against the types mongo-migrate-kit exports,
  and checks the project's mongo-migrate-kit version on activation.
- An "mmk" output channel with credentials masked.
