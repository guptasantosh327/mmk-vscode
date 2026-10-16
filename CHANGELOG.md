# Changelog

All notable changes to this extension are documented here.

## Unreleased (0.1.0 pre-release)

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
