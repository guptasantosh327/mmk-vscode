# mmk for VS Code

Run, roll back and review [mongo-migrate-kit](https://mongo-migrate-kit.vercel.app/) (mmk)
MongoDB migrations without leaving the editor.

> **Status: in development.** Nothing is published yet. The foundation (finding your project's
> mmk, running it, reading its JSON) is done; the sidebar, run links and the rest arrive in the
> phases described in [docs/PLAN.md](docs/PLAN.md).

## How it works

The extension is a UI over the mmk CLI. It runs **your project's own** `mmk` (from
`node_modules`, with your `mmk.config.*` and your Node.js) with `--json`, and shows what mmk
returns. It never decides what is pending, applied or changed by itself, and it never bundles the
MongoDB driver.

- It activates in folders with an `mmk.config.js`, `.ts` or `.json`, or a `package.json` that
  depends on `mongo-migrate-kit`.
- It needs `mongo-migrate-kit` 1.5.0 or later in the project.
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

Read [CLAUDE.md](CLAUDE.md) before contributing: it holds the rules that keep the extension in
step with mongo-migrate-kit.

## License

MIT
