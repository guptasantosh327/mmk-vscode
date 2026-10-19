# Requests to mongo-migrate-kit

The extension never computes what mmk can answer. When it needs something mmk doesn't output yet,
the need goes here. Each request is **designed and built in MMK_REPO**
(`/Users/santoshgupta/Desktop/development/mongo-migrate-kit`) in its own Claude session, following
that repo's CLAUDE.md, with its own tests, changelog entry and release.

**Status values:** `open` → `in progress` → `released in mmk X.Y.Z`. Released in 1.6.0
(2026-10-19, pinned here): R2, R3, R5, R8, R9, R10 and R11. Once a request is released, raise
`MIN_MMK_VERSION` in `src/mmk/compat.ts` if the extension now depends on it.

**Developing against the unreleased requests:** each one is on its own branch in MMK_REPO. To
use them together, merge the branches in a throwaway clone (not in MMK_REPO), set its version to
`1.6.0-dev.0`, build, `npm pack`, and `npm install --no-save <tarball>` here. The contract
tests read the installed version: from `NEXT_MMK` (`1.6.0-0`, in `test/contract/harness.ts`)
they expect the new behaviour, and 1.5 behaviour below it, so CI stays green on 1.5.0, the oldest
supported version. `npm ci` puts the pin back. For requests after 1.6.0, stamp the build with the
next version instead.

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

## R2 — Resolved config as JSON · Phase 2 (optional) · `released in mmk 1.6.0`

**Status:** released in mongo-migrate-kit 1.6.0 (PR #12, from branch `feat/config-json`), as `mmk config [--json]`, `MigratorKit.describeConfig()` and the exported
`ConfigSummary` / `ConfigSource` types. It never connects, hides the URI's credentials, and
reports `null` for an unset `uri` / `dbName` / `configFile`.

**No longer blocking:** with mmk 1.5 the extension reads the same values through the config bridge
(1.5's public `MigratorKit.resolveConfig()`, CLAUDE.md rule 1), and it switches to
`mmk config --json` on any mmk that has it. What R2 still adds: the config can be read without a
connection string, it names where each value came from, and the extension needs no library
call. The contract test expects `via: 'cli'` from 1.6, and `ProjectConfig` is a `Pick` of
`ConfigSummary` since 1.6.0 is pinned. Don't raise `MIN_MMK_VERSION` for it.

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

## R3 — Read commands never write on connect · Phase 3 · `released in mmk 1.6.0`

**Status:** released in mongo-migrate-kit 1.6.0 (PR #13, from branch `feat/read-only-reads`, with
the owner's `fb8b2af`: a write command run by a user that can't write now fails with
`CONNECTION_FAILED` at its first write, the storage marker included), as `connect({ readOnly: true })` (exported `ConnectOptions`), used by
`status`, `list`, `dry-run`, `status --all-namespaces`, `lockInfo()` and `pendingMigrations()`.
Write commands still create the changelog index on connect. Tested with an auth-enabled memory
server and a `read`-role user (library and CLI). The extension's contract test
`environments.contract.test.ts` expects reads to work from the next mmk, and 1.5's
`CONNECTION_FAILED` (`not authorized`) before it.

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

**Not built for 1.0.** The extension works without it: a config function still runs when an
environment supplies `MMK_URI` / `MMK_DB`, and mmk gives those priority over what it returns. It
only matters when the function's own fetch fails (no access to the secret manager from the
laptop).

**Why:** if `mmk.config.js` is an async function that fetches the URI from a secret manager, it still
runs when the extension already supplies `MMK_URI`/`MMK_DB`, and a failure there stops everything.

**Proposal:** call the config function with what higher-priority layers already provide, e.g.
`export default async ({ provided }) => provided.uri ? { namespace: 'x' } : await loadFromSecrets()`.
Existing functions that take no argument keep working.

**Done when:** documented in the `init --secret-provider` template and tested both ways.

---

## R5 — Recorded checksum in status output · Phase 4 · `released in mmk 1.6.0`

**Status:** released in mongo-migrate-kit 1.6.0 (PR #14, from branch `feat/status-checksum`), as `StatusRow.checksum` on applied rows of `status`, `list` and `dry-run`
(omitted when a record has none, e.g. an `mmk import` without its file), with a shape test.
`WireStatusRow` in `src/mmk/contract.ts` is plain `Wire<StatusRow>` since 1.6.0 is pinned.

**Why:** to warn while someone edits an applied file, and to find the version that ran in git, the
extension needs the **recorded** checksum. `StatusRow` only has `checksumOk`.

**Proposal:** add optional `checksum?: string` (the SHA-256 recorded when it was applied) to
`StatusRow` for applied rows. This is additive.

**Done when:** the type is exported, it appears in `status --json` and `list --json`, and it's
covered by a shape test.

---

## R6 — Rollback test command · Phase 5 · `dropped`

**Dropped (2026-10-18, owner):** not needed for 1.0, and the owner wants fewer commands for users.
The branch stays, unmerged; don't merge it. What was built:

**Status:** built on mongo-migrate-kit branch `feat/test-rollback` (commit `1067100`, not pushed,
not released) as `mmk test-rollback [file] [--json]`, `MigratorKit.testRollback()` and the
exported `RollbackTestReport` types, with tests for success, a failing `down()`, a failing second
`up()`, setup, a crash and SIGTERM. It opens its own connection, so it doesn't depend on R3. Until
released, `src/mmk/contract.ts` declares the report's shape with mmk's names. Merging it with
`feat/read-only-reads` conflicts on two adjacent private fields of `MigratorKit`: keep both.

**Why:** IDEAS.md's "Testing that a migration can be rolled back". The extension shows results; mmk
owns the logic.

**Proposal (design in MMK_REPO first):** `mmk test-rollback [file] --json` runs up → down → up for
each target on a **temporary database** (unique name, dropped afterwards, even on failure). It never
touches the configured database or its changelog. Output per file: steps with status and duration,
the failing step, and the error code and message (and location if available).

**Done when:** it's tested for success, a failing `down()`, a failing second `up()`, and cleanup after
a crash.

---

## R7 — Migration linter · Phase 5 · `dropped`

**Dropped (2026-10-18, owner):** not needed for 1.0, and the owner wants fewer commands for users.
The branch stays, unmerged; don't merge it. What was built:

**Status:** built on mongo-migrate-kit branch `feat/lint` (commit `e026766`, not pushed, not
released) as `mmk lint [file] [--json]`, `MigratorKit.lint()` and the exported `LintReport` types.
Rules: `empty-down`, `unfiltered-write`, `transaction-without-session` (error),
`index-without-name`; `// mmk-lint-disable-next-line <rule>`. No new dependency. Merging it after
`feat/test-rollback` conflicts only where both add to the same lists (types, docs, CLI tests):
keep both sides.

**Why:** IDEAS.md's "A linter for risky migrations".

**Proposal (design in MMK_REPO first):** `mmk lint [file] --json` → findings
`{ file, line, column, rule, severity, message }`. Initial rules: empty `down()`, `updateMany`/`deleteMany`
with an empty filter, a transactional migration that never passes `session`, an index created
without a name.

---

## R8 — Docs page for the extension · Phase 6 · `released in mmk 1.6.0`

**Status:** released with mongo-migrate-kit 1.6.0 (PR #15, from branch `feat/vscode-docs`) as
`docs/guide/vscode.md` ("In VS Code" in the guide's sidebar): install, environments, read-only
users, applied-file warnings and the compatibility table. It names 1.6.0 as the release with
R3/R5. The docs site deploys from `main`, so it's live at
https://mongo-migrate-kit.vercel.app/guide/vscode. **Follow-up, after the extension's 1.1.0 is
published** (docs/RELEASE.md, step 4): it still uses the old name and ID (`mmk for VS Code`,
`guptasantosh327.mmk-vscode`) and predates the console, the pipeline and environment colours.

**Proposal:** a page in MMK_REPO `docs/` (VitePress) covering install, environments, read-only users,
and the compatibility table.

---

## R9 — Keep stdout to the JSON document in `--json` mode · Phase 2 (optional) · `released in mmk 1.6.0`

**Status:** released in mongo-migrate-kit 1.6.0 (PR #11, from branch `feat/json-output`). The
contract test "stdout from user code" expects `otherStdout` to be `''` from 1.6, and the 1.5 leak
below it. Keep the tolerant parser in `parseJsonStdout`, because 1.5 still leaks.

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

## R10 — Results of the files that ran, when a run fails · Phase 2 (optional) · `released in mmk 1.6.0`

**Status:** released in mongo-migrate-kit 1.6.0 (PR #11, from branch `feat/json-output`). Covers
`up`, `down` and `redo` (the revert comes first), and the library's `err.context.results`. The
console's result reads it (`runResultsOfFailure`), and the contract test "a run that stops
partway" checks `details.results` from 1.6 (none on 1.5). The A3 notification it was first meant
for was dropped (owner, 2026-10-18).

**Why:** found in Phase 1. When `mmk up --json` applies two files and the third throws, mmk prints
only the error document. The results of the two files that did apply are dropped, so the A3
notification can't say "Applied 2 on local, then x.js failed" without running `status` again.

**Proposal:** add the results collected so far to the error document, e.g.
`details.results: RunResult[]` on `MIGRATION_EXECUTION_FAILED` (it already has `name`, `direction`,
`cause` and `location`). Additive.

**Done when:** a CLI test of a failing batch shows the applied files in `details.results`.

---

## R11 — Who holds the lock, from a command that doesn't release it · Phase 7 · `released in mmk 1.6.0`

**Status:** released in mongo-migrate-kit 1.6.0 (PR #16, from branch `feat/lock-command`) as
`mmk lock [--json]`, `MigratorKit.lockStatus()` and the exported `LockStatus` type
(`WireLockStatus` is `Wire<LockStatus>`), with tests (lock free, held, stale, a pre-1.5 holder;
nothing written; a `read`-role user) and docs (`/commands/lock`). One change from the proposal: the output also has `stale`, mmk's verdict on the server's clock, by the
same filter a run uses to take the lock over, so the extension never judges staleness itself
(rule 1). The extension reads it in `MmkStore` (`readLock`), shows a lock in force in the
pipeline, the console, the tree and the status bar, and offers *Release the lock…* on writable
environments. On an mmk without the command it asks once and stops (`isUnknownCommand`).

**Why:** the console and the pipeline sidebar (Phase 7) show when an environment's lock is held
and by whom, so nobody starts a run that will only fail with `LOCK_ALREADY_HELD`. Today the only
command that reads the lock, `mmk unlock`, also releases it, and `status --json` doesn't mention
it. The extension can't read the lock collection itself (rule 1), so until this ships it shows the
lock only when a run reports it.

**Proposal:** a read-only command, `mmk lock --json`, printing `{ "holder": LockInfo | null }`
(`LockInfo` is already exported). It never acquires or releases the lock, and connects the way R3's
read commands do, so it works with a `read`-role user. The extension adds it to the read-only
commands in `assertCanRun`.

**Done when:** the command exists, a test shows it changes nothing (lock held and free), the
`--json` output has a shape test, and it's documented with `unlock`.

---

## R12 — The batch a run would record, in `dry-run` · Phase 7 (optional) · `open`

**Why:** the console's plan (C6) says what a run will be recorded as, so that the result and
*Roll back batch N* match what the user approved. `dry-run up --json` returns the pending rows
with `batch: null`, and the extension mustn't work out the next number itself (rule 1: batches
are mmk's).

**Proposal:** an optional `plannedBatch?: number` on each row `dry-run up` would apply: the batch
`up` would record now. Additive: `batch` keeps meaning "the batch it ran in", and stays `null`.

**Done when:** `dry-run up --json` rows carry `plannedBatch`, with a shape test, and the docs for
`dry-run` mention it.
