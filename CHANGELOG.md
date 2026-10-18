# Changelog

All notable changes to this extension are documented here.

## Unreleased

- **Migration console** (`mmk: Open migration console`): every migration against every
  environment in one editor tab, with environment tabs, filters (*Pending*, *Needs attention*,
  *Only differences*), files from your branch or `origin/main`, the picked migration's record on
  each environment with the actions the selected one allows, its CLI command, and the latest
  batches. It replaces the environments matrix; *Compare all environments* opens it on *Only
  differences*. Its buttons run the same commands as the rest of the extension, so read-only
  environments and confirmations work the same way.
- **Plan, run and result in the console:** *Plan* shows mmk's dry run (what up would apply, in
  order) and *Apply* runs it. While mmk runs in the project, its own output shows as it comes. The
  result lists each migration, mmk's error as is when it stops, where the environment stands now,
  and the next step (open the file, roll back the batch, release a held lock).
- **Roll back a batch** (`mmk: Roll back a batch…`, `mmk down --batch N`): the confirmation names
  every migration in the batch. Refused on read-only environments.
- **Environments pipeline** at the top of the mmk sidebar: each environment as a step with its
  pending count, the latest migration applied there and what needs attention, then *Review N
  pending*, *Console* and *New migration*, then the selected environment's pending migrations.
- **Environment colours:** each environment has its own colour in the sidebar, the console and the
  status bar, and a different one by default (local green, prod red, the others yellow, blue,
  purple and orange in turn). *mmk: Change environment colour…* sets it, local's too, in
  `mmk.environments` (`green`, `blue`, `purple`, `yellow`, `orange`, `red`; `default`, `warning`
  and `error` still work). Yellow and orange give the status bar its warning background, red its
  error one.
- A run in the console stays on screen when it ends, finished or failed with mmk's error, until
  you close it.
- Runs no longer pop up a notification when they succeed (up, down, redo, *Apply all*, rolling
  back a batch), and their progress shows in the status bar: the sidebar, run links and status bar
  already show the result. A failure still shows mmk's message, and a run that did nothing says
  why.
- Fixed: *Edit environment → Make read-only* (or *Allow runs*) no longer drops the environment's
  colour from settings.
- An environment that can't be read shows mmk's message as is, with *Try again*, *Edit
  connection* and *Show output*.

## 1.0.1 · unreleased

- **Renamed to Mongo Migrate Kit**, the library's name, with a new extension ID:
  `guptasantosh327.mongo-migrate-kit`. It replaces `guptasantosh327.mmk-vscode` ("mmk for VS
  Code"), which is no longer updated: uninstall it and install this one. Settings (`mmk.*`) and
  commands are unchanged; environments' connection strings need adding again, since the keychain
  keeps them per extension.
- The README opens like mongo-migrate-kit's: the logo, badges and links to its docs.

## 1.0.0 · 2026-10-18

The first release. (0.1.0 was prepared as a pre-release and never published.) It needs
mongo-migrate-kit 1.5.0 or later. The applied-file warning and read-only database users switch on
by themselves once the project has a mongo-migrate-kit release that supports them.

### Local workflow

- **mmk sidebar:** the selected environment, pending migrations, files edited after they ran, and
  applied migrations grouped by batch (older batches folded). *Apply all* and *Dry run* next to the
  pending list.
- **Create migration:** a name input with a preview of the file mmk will create and a
  JavaScript/TypeScript toggle; the new file opens.
- **Run links** above `up()` and `down()`: run up, dry run, redo and run down, with what mmk
  recorded (batch, duration, edited since).
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

### Applied-file protection (switches on with a newer mongo-migrate-kit)

- **Edits to migrations that already ran** are caught while you type, before you save: a warning on
  the changed lines, a hover that says where it ran and what saving would do, a Problems entry, a
  `!` badge and a run link. The text is compared with the checksum mmk recorded on every
  environment.
- **Show applied version** finds the commit whose version has the recorded checksum and opens it
  next to your file. **Restore applied version** puts it back; **Undo my edit** drops an unsaved
  edit.
