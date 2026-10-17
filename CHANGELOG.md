# Changelog

All notable changes to this extension are documented here.

## 1.0.0 · unreleased

The first release. (0.1.0 was prepared as a pre-release and never published.) It needs
mongo-migrate-kit 1.5.0 or later; read-only database users, edit warnings, rollback tests and lint
need 1.6.0 or later.

### Local workflow

- **mmk sidebar:** the selected environment, pending migrations, files edited after they ran, and
  applied migrations grouped by batch (older batches folded). *Apply all* and *Dry run* next to the
  pending list.
- **Create migration:** a name input with a preview of the file mmk will create and a
  JavaScript/TypeScript toggle; the new file opens.
- **Run links** above `up()` and `down()`: run up, dry run, redo, run down and test rollback, with
  what mmk recorded (batch, duration, edited since).
- **Explorer badges** for pending (`●`) and edited (`!`) migrations, and a status bar item with the
  environment and its pending count.
- **Confirmations** before `down`, `redo`, a forced rollback of an edited file, releasing the
  migration lock, and any write outside local. *Unlock…* when mmk reports the lock is held.
- **Copy CLI command** for any migration or project, on any environment (with a placeholder where
  the connection string goes).
- Welcome views when there's no project, mongo-migrate-kit isn't installed or is too old, or
  Node.js isn't found. The views follow changes to migration files, the config file and `.env`.
- Finds mmk projects by config file or by a package.json that depends on mongo-migrate-kit,
  including monorepos and multi-root workspaces, and runs each project's own mmk with `--json`.
- An "mmk" output channel with credentials masked.

### Environments

- **Add, edit and remove environments.** A name, the connection string (masked) and the database,
  tested with `mmk status`. Connection strings stay in the OS keychain and reach mmk as `MMK_URI` /
  `MMK_DB`; settings hold only names, read-only flags and colors (`mmk.environments`). A connection
  string found in settings gets a warning and a *Move to keychain* button.
- **Read-only by default** for anything but local: only `status`, `list` and `dry-run` run there,
  enforced where commands run, not only in the UI.
- **Environment picker** from the status bar or the sidebar, with each environment's host, pending
  count and read-only note. The status bar turns amber for staging and red for prod. Run links show
  the other environments next to the selected one.
- **Compare all environments:** every migration against every environment, with notes ("On
  staging, not prod", "Only on local so far", "Edited after it ran", applied but not in your
  branch), summary chips, an *Only differences* filter, and a switch to compare the files on
  `origin/main`.
- **After a branch switch**, local migrations whose files are on another branch are named, with
  the branch.

### Applied-file protection

- **Edits to migrations that already ran** are caught while you type, before you save: a warning on
  the changed lines, a hover that says where it ran and what saving would do, a Problems entry, a
  `!` badge and a run link. The text is compared with the checksum mmk recorded on every
  environment.
- **Show applied version** finds the commit whose version has the recorded checksum and opens it
  next to your file. **Restore applied version** puts it back; **Undo my edit** drops an unsaved
  edit.

### Rollback tests and lint

- **Rollback tests in Test Explorer:** every migration with its `up`, `down` and `up again` steps,
  run by `mmk test-rollback` on a temporary database that mmk drops afterwards. A failure shows
  mmk's message at the line that threw. Also from the run link and the button after a run.
- **Lint findings** from `mmk lint` as warnings and errors in the editor and the Problems panel.
