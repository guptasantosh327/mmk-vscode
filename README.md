# mmk for VS Code

Create, run and roll back [mongo-migrate-kit](https://mongo-migrate-kit.vercel.app/) (mmk)
MongoDB migrations without leaving the editor.

> **Status: in development.** Not published yet. The local workflow below is built. Environments,
> protection for applied files and rollback tests come in the phases described in
> [docs/PLAN.md](docs/PLAN.md).

## What it does

- **Sidebar:** pending migrations, files edited after they ran, and applied ones grouped by
  batch, all read from your local database through mmk. "Apply all" and "Dry run" sit next to
  the pending list.
- **Create migration:** type a name and see the file it creates, pick JavaScript or TypeScript,
  and the new file opens.
- **Run links** above `up()` and `down()`: *Run up on local*, *Dry run*, *Redo*, *Run down on
  local*, with the batch and time once a migration has run.
- **Explorer badges:** `●` pending, `!` edited after it ran.
- **Status bar:** `mmk: local · 3 pending`.
- **Safe by default:** nothing runs on its own. `down`, `redo` and `--force` ask first. Every
  action logs the `mmk` command it ran, and *Copy CLI command* gives you the same command for a
  terminal.

## How it works

The extension is a UI over the mmk CLI. It runs **your project's own** `mmk` (from
`node_modules`, with your `mmk.config.*`, your `.env` and your Node.js) with `--json`, and shows
what mmk returns. It never decides by itself what is pending, applied or changed, and it never
bundles the MongoDB driver.

- It activates in folders with an `mmk.config.js`, `.ts` or `.json`, or a `package.json` that
  depends on `mongo-migrate-kit`. Monorepos and multi-root workspaces work.
- It needs a mongo-migrate-kit release with `mmk config` (the release after 1.5.0).
- It only runs in trusted workspaces, because running mmk runs your project's config and
  migrations.
- No telemetry.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `mmk.nodePath` | empty | The Node.js that runs mmk. Empty means `node` from `PATH`, like your terminal. |

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

The **Run Extension (fixture workspace)** launch configuration opens the sample project in
`test/fixtures/workspace` against a MongoDB on `localhost:27017`.

Read [CLAUDE.md](CLAUDE.md) before contributing: it holds the rules that keep the extension in
step with mongo-migrate-kit.

## License

MIT
