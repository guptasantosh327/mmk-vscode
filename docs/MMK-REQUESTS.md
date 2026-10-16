# Requests to mongo-migrate-kit

The extension never computes what mmk can answer. When it needs something mmk doesn't output yet,
the need goes here. Each request is **designed and built in MMK_REPO**
(`/Users/santoshgupta/Desktop/development/mongo-migrate-kit`) in its own Claude session, following
that repo's CLAUDE.md, with its own tests, changelog entry and release.

**Status values:** `open` → `in progress` → `released in mmk X.Y.Z`. Once a request is released,
raise `MIN_MMK_VERSION` in `src/mmk/compat.ts` if the extension now depends on it.

**Rules for every request:** additive and non-breaking for existing CLI and CI users; output
covered by shape tests in MMK_REPO, so mmk's own CI fails if a shape changes; documented in
MMK_REPO `docs/`.

---

## R1 — Machine-readable version and JSON format · Phase 1 (optional) · `open`

**Why:** the extension needs to know whether the project's mmk speaks the JSON shapes it expects.
`mmk --version` gives the version but not the JSON format.

**Proposal:** `mmk version --json` → `{ "version": "1.6.0", "jsonFormat": 1 }`. Declare the
current `--json` shapes as **format 1**. Bump `jsonFormat` only on a breaking change to any
`--json` output. Add shape tests in MMK_REPO for every `--json` command (most protection against
drift from mmk's side).

Also export types for the `--json` documents that have none today, so the extension can import
them instead of declaring them (`src/mmk/contract.ts` declares these three for now): the
`create` result `{ path }`, the `unlock` result `{ released, holder }`, and the error document
`{ error: { code?, message, details? } }`.

**Done when:** the command exists, it's documented, and every `--json` command has a shape test.

---

## R2 — Resolved config as JSON · Phase 2 · `open`

**Why:** the extension needs the resolved migrations folder, file extensions and create defaults.
Without this it would have to re-implement mmk's config loading (precedence, `.env`, config
functions), which is exactly the drift we want to avoid.

**Proposal:** `mmk config --json`, which never connects to the database:
```json
{
  "configFile": "/abs/path/mmk.config.js",
  "migrationsDir": "/abs/path/migrations",
  "fileExtensions": [".ts", ".js"],
  "createExtension": "js",
  "migrationsCollection": "_mmk_migrations",
  "lockCollection": "_mmk_locks",
  "namespace": "billing-api",
  "dbName": "orders_dev",
  "uri": "mongodb+srv://***@cluster0.example.net",
  "sources": { "migrationsDir": "file", "uri": "env", "dbName": "env" }
}
```
`uri` is always masked (reuse `redactMongoUri`). `sources` names the layer each key came from
(`flag` / `env` / `file` / `default`); `config.ts` already tracks this.

**Done when:** the output matches what every other command resolves (test them side by side), and
it works without a database.

---

## R3 — Read commands never write on connect · Phase 3 · `open`

**Why:** staging and prod should be readable with a MongoDB user that has only the `read` role.
Today `connect()` always creates the changelog index (`src/core/migrator.ts`, `ensureIndexes`), and
with a namespace set it also records the `_mmk_meta` storage marker. So `mmk status` with a read-only
user fails with `CONNECTION_FAILED`.

**Proposal:** `status`, `list`, `dry-run` and `status --all-namespaces` connect without creating
indexes or writing the marker. The check that refuses a newer storage format still runs (it only
reads). Write commands keep today's behaviour. This also lets CI's `mmk status --check` run with
read-only credentials.

**Done when:** an integration test with an auth-enabled memory server and a read-only user runs all
four read commands successfully, and every write command still creates indexes as before.

---

## R4 — Config functions can skip their secret fetch · Phase 3 (optional) · `open`

**Why:** if `mmk.config.js` is an async function that fetches the URI from a secret manager, it still
runs when the extension already supplies `MMK_URI`/`MMK_DB`, and a failure there stops everything.

**Proposal:** call the config function with what higher-priority layers already provide, e.g.
`export default async ({ provided }) => provided.uri ? { namespace: 'x' } : await loadFromSecrets()`.
Existing functions that take no argument keep working.

**Done when:** documented in the `init --secret-provider` template and tested both ways.

---

## R5 — Recorded checksum in status output · Phase 4 · `open`

**Why:** to warn while someone edits an applied file, and to find the version that ran in git, the
extension needs the **recorded** checksum. `StatusRow` only has `checksumOk`.

**Proposal:** add optional `checksum?: string` (the SHA-256 recorded when it was applied) to
`StatusRow` for applied rows. This is additive.

**Done when:** the type is exported, it appears in `status --json` and `list --json`, and it's
covered by a shape test.

---

## R6 — Rollback test command · Phase 5 · `open`

**Why:** IDEAS.md's "Testing that a migration can be rolled back". The extension shows results; mmk
owns the logic.

**Proposal (design in MMK_REPO first):** `mmk test-rollback [file] --json` runs up → down → up for
each target on a **temporary database** (unique name, dropped afterwards, even on failure). It never
touches the configured database or its changelog. Output per file: steps with status and duration,
the failing step, and the error code and message (and location if available).

**Done when:** it's tested for success, a failing `down()`, a failing second `up()`, and cleanup after
a crash.

---

## R7 — Migration linter · Phase 5 · `open`

**Why:** IDEAS.md's "A linter for risky migrations".

**Proposal (design in MMK_REPO first):** `mmk lint [file] --json` → findings
`{ file, line, column, rule, severity, message }`. Initial rules: empty `down()`, `updateMany`/`deleteMany`
with an empty filter, a transactional migration that never passes `session`, an index created
without a name.

---

## R8 — Docs page for the extension · Phase 6 · `open`

**Proposal:** a page in MMK_REPO `docs/` (VitePress) covering install, environments, read-only users,
and the compatibility table.

---

## R9 — Keep stdout to the JSON document in `--json` mode · Phase 2 (optional) · `in progress`

**Status:** built on mongo-migrate-kit branch `feat/json-output` (commit `905f178`, not pushed,
not released). Checked through `file:../mongo-migrate-kit`: the only contract test that changes is
"stdout from user code", whose `otherStdout` becomes `''`. When it's released, update that test.
Keep the tolerant parser in `parseJsonStdout`, because older mmk versions still leak.

**Why:** found in Phase 1. `--json` promises one JSON document on stdout, but mmk only routes its
*own* logger to stderr. A `console.log` in a migration, a hook or a config function still goes to
stdout, before the document (contract test "stdout from user code" shows it with mmk 1.5.0). CI
scripts that pipe `mmk up --json` into `jq` break the same way. Backfill migrations often log
progress, so this is common. The extension copes (it reads the last JSON document on stdout and
logs the rest), but that is a workaround for a promise mmk should keep.

**Proposal:** in `--json` mode, redirect `console.log` / `console.info` / `console.debug` (and
direct `process.stdout.write` calls from user code, if practical) to stderr for the duration of
the command, and write the JSON document through the original stdout.

**Done when:** a CLI test with a migration, a hook and a config function that each call
`console.log` gets exactly one parseable document on stdout, with the logged lines on stderr.

---

## R10 — Results of the files that ran, when a run fails · Phase 2 (optional) · `in progress`

**Status:** built on mongo-migrate-kit branch `feat/json-output` (commit `6f7041e`, not pushed,
not released). The contract tests still pass against it. Covers `up`, `down` and `redo` (the revert
comes first), and the library's `err.context.results`. When it's released, add `details.results`
to the contract test for `MIGRATION_EXECUTION_FAILED` and read it in the A3 notification.

**Why:** found in Phase 1. When `mmk up --json` applies two files and the third throws, mmk prints
only the error document. The results of the two files that did apply are dropped, so the A3
notification can't say "Applied 2 on local, then x.js failed" without running `status` again.

**Proposal:** add the results collected so far to the error document, e.g.
`details.results: RunResult[]` on `MIGRATION_EXECUTION_FAILED` (it already has `name`, `direction`,
`cause` and `location`). Additive.

**Done when:** a CLI test of a failing batch shows the applied files in `details.results`.
