# mmk for VS Code

Create, run and roll back [mongo-migrate-kit](https://mongo-migrate-kit.vercel.app/) (mmk)
MongoDB migrations without leaving the editor. Compare your branch with staging and prod, and get a
warning the moment you edit a migration that has already run.

![Creating a migration, running it on local, and seeing it applied](media/readme/local-workflow.gif)

The extension is a window onto the `mmk` command. It runs **your project's own** mongo-migrate-kit
from `node_modules`, with your `mmk.config.*`, your `.env` and your Node.js, and shows what
`mmk … --json` returns. It never decides on its own what is pending, applied or changed, and
whatever it shows, `npx mmk` says the same in a terminal.

## Your local database

- **The mmk sidebar:** what's pending, what was edited after it ran, and what's applied, grouped by
  batch. *Apply all* and *Dry run* sit next to the pending list.
- **Create a migration** with the `+`: type a name, see the file mmk will create, pick JavaScript or
  TypeScript, and the new file opens.
- **Run links** above `up()` and `down()`: *Run up on local*, *Dry run*, *Redo*, *Run down on local*,
  with the batch and the time once it has run.
- **Badges and status bar:** `●` on pending files, `!` on edited ones, and `mmk: local · 3 pending`.
- **Nothing runs on its own.** Every run is a click; rolling back, redoing and releasing the lock
  ask first. *Copy CLI command* gives you the same command for a terminal.

## Staging and prod

![Switching to prod (read-only), then comparing every environment](media/readme/environments.gif)

- **Add an environment** (`mmk: Add environment…`): a name, the connection string in a masked box,
  and the database. The connection is tested with `mmk status`, then kept in your **OS keychain**.
  It reaches mmk as `MMK_URI` / `MMK_DB` and is never written to settings, logs or the command line.
- **Read-only by default.** Anything but `local` only ever runs `status`, `list` and `dry-run`. The
  run links offer *Dry run* and *Copy CLI command*, and every write command refuses in code, not
  just in the UI. Deploys stay with your pipeline.
- **The status bar** turns amber on staging and red on prod.
- **Compare all environments:** every migration against every database, with notes like
  "On staging, not prod" and "Only on local so far", an *Only differences* filter, and a switch to
  compare the files on `origin/main` instead of your branch (copied from git, without touching your
  checkout).
- **After a branch switch**, local migrations whose files are on another branch are named, with
  the branch.

Give staging and prod a MongoDB user with only the `read` role: from mongo-migrate-kit 1.6.0, reading
needs nothing more.

## Editing a migration that already ran

![Editing an applied migration, then opening the version that ran](media/readme/applied-edit.gif)

As you type in a migration that has run, before you save, the changed lines get a warning that
names where it ran and what saving would do: `mmk down` will refuse to roll it back, `mmk status`
will mark it as changed, and nothing runs it again. The same warning is in Problems, on the file's
badge and in its run link.

**Show applied version** finds the commit whose version of the file has the checksum mmk recorded
when it ran, and opens it next to yours. **Restore applied version** puts it back; **Undo my edit**
drops an unsaved edit. Then write the change as a new migration.

## Requirements

- mongo-migrate-kit installed in your project: `npm install mongo-migrate-kit mongodb`
- Node.js on `PATH` (or set `mmk.nodePath`)
- A trusted workspace: running mmk runs your project's config and migrations

It starts in any folder with an `mmk.config.js`, `.ts` or `.json`, or a `package.json` that depends
on `mongo-migrate-kit`. Monorepos and multi-root workspaces work. Remote SSH, WSL and Dev Containers
work too: the extension runs next to your project.

### Which mongo-migrate-kit

| mmk for VS Code | mongo-migrate-kit | What works |
| --- | --- | --- |
| 1.0 | older than 1.5.0 | Nothing: it asks you to update. |
| 1.0 | 1.5.x | Local workflow, environments and the comparison (with a database user that can write). |
| 1.0 | 1.6.0 or later | Everything: also read-only database users and warnings while editing applied migrations. |

Update with `npm install --save-dev mongo-migrate-kit@latest`. With 1.5.x, the features that need
1.6.0 stay off and say so.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `mmk.environments` | `[]` | Your environments besides `local`: names, `readOnly` (on unless `false`) and `color` (`default`, `warning`, `error`). Connection strings stay in the keychain. |
| `mmk.nodePath` | empty | The Node.js that runs mmk. Empty means `node` from `PATH`, like your terminal. |

## Privacy

No telemetry. The extension reaches your databases only through your own mmk, keeps connection
strings in your OS keychain, and sends nothing anywhere else.

## Developing

```bash
npm install
npm run watch              # esbuild in watch mode; F5 opens an Extension Development Host
npm test                   # unit tests (vitest)
npm run test:contract      # the real mmk against an in-memory MongoDB
npm run test:integration   # VS Code integration tests (Linux CI needs xvfb-run)
npx biome check src test
npx tsc --noEmit
```

The README's GIFs and screenshots are recorded from the real extension by
`scripts/media/record.mjs` (see the comment at its top). Read [CLAUDE.md](CLAUDE.md) before
contributing: it holds the rules that keep the extension in step with mongo-migrate-kit.

## License

MIT
