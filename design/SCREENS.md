# Design — Mongo Migrate Kit for VS Code

**Live mockup:** https://claude.ai/artifact/ShXWe1gdAancBaTcXb3Zsk — page **"VS Code extension"**
(private to the owner; open it signed in). The page "Web dashboard" is an earlier idea and is
**not** in scope.

**Source of each screen:** `design/screens/*.dc.html`. These are the mockup's source files. They
need the canvas runtime to render, so read them for layout, copy and states, and use the link above
to see them.

The mockup is a picture of the goal, not a spec of VS Code internals. Wherever it shows something
VS Code can't host, the **"Build it as"** line says what to use instead.

---

## Colors and icons

The mockup uses fixed hex colors. The extension must use **theme colors** so it fits every theme.

| Meaning | Mockup | Build it as |
|---|---|---|
| Applied | green `#4CC38A` | `ThemeColor('testing.iconPassed')` / codicon `check` |
| Pending | blue `#6FA8FF` | `ThemeColor('charts.blue')` / codicon `circle-outline` |
| Edited after it ran | amber `#E5A84B` | `ThemeColor('list.warningForeground')` / codicon `warning` |
| Failed | red `#F2686A` | `ThemeColor('testing.iconFailed')` / codicon `error` |
| Status bar · local | blue bar | default background (VS Code only allows warning/error backgrounds) |
| Status bar · staging | amber bar | `ThemeColor('statusBarItem.warningBackground')` |
| Status bar · prod | red bar | `ThemeColor('statusBarItem.errorBackground')` |
| Read-only | lock | codicon `lock` |
| Activity bar | layers icon | mmk's monochrome logo as an SVG |

In the matrix webview, use `--vscode-*` CSS variables (e.g. `--vscode-charts-green`,
`--vscode-editorWarning-foreground`) and `@vscode/codicons`.

---

## Flow A — Write, run and test on local

### A1 · Create migration (Phase 2) — `VSCreate.dc.html`
- **Opened by:** command palette "mmk: Create migration", the `+` in the sidebar title, or
  "Create a new migration" from B1/B2.
- **Shows:** title "mmk: Create migration"; a name input; a preview line
  `migrations/<timestamp>-<slug>.js`; the type (JavaScript/TypeScript) with a toggle; the author note.
- **Behaviour:** an empty slug disables Create, with a message saying the name needs letters or
  digits. The TS toggle says "Runs on Node 22.18+ or with a TypeScript loader".
- **Build it as:** a `QuickInput` (`createInputBox`) with a toggle button, and the preview in
  `validationMessage` / `prompt`. Run `mmk create <name> --json [--ts|--js]`, then open the returned `path`.

### A2 · Sidebar and run links (Phase 2) — `VSMain.dc.html`
- **Sidebar "MMK: MIGRATIONS":** environment row (dot + name + host, opens C1); *PENDING ON LOCAL (n)*;
  "Apply all n on local" and "Dry run" buttons; *APPLIED ON LOCAL (n)* grouped as
  "Batch 17 · 13 Oct (2)", with older batches collapsed.
- **Run links above `up()`, before it runs:** `Pending on local | Run up on local | Dry run |
  staging: pending | prod: pending`. Environment columns appear only once environments exist (Phase 3).
- **Run link above `down()`, before it runs:** "Run down appears once up has run on local".
- **Status bar:** `$(layers) mmk: local · 3 pending`.
- **Build it as:** a `TreeDataProvider` with view-title actions; a `CodeLensProvider`; a `StatusBarItem`.

### A3 · Applied on local (Phase 2) — `VSRun.dc.html`
- **Notification:** "Applied on local in 412 ms", detail "add-refunds-collection.js · batch 18 ·
  transaction committed", buttons **Test rollback** (dropped with Phase 5: not built) and **Run down**.
- **Run links after:** `✓ Applied on local · batch 18 · 412 ms | Redo | staging: pending | prod: pending`
  above `up()`; `Run down on local` above `down()` (*Test rollback* dropped with Phase 5).
- **Output channel "mmk":** mmk's own log lines for the run (its stderr in `--json` mode).
- **Sidebar:** the file moves to "Batch 18 · just now". The pending count drops.

### A4 · Rollback test (Phase 5) — `VSTest.dc.html` · **dropped, not built**
- **Test Explorer:** "mmk rollback round-trip" → one item per migration → steps *up*, *down*,
  *up again*. Summary: "2 passed · 1 failed · On a temporary copy of orders_dev, dropped after the run".
- **Failure at the line:** "rollback test failed in down()" + mmk's error
  (`MongoServerError: index not found with name [customerId_1_createdAt_-1]`) + "Ran up → down → up on a
  temporary database … Your orders_dev data was not touched."
- **Build it as:** a `TestController` and a `TestMessage` with a `Location`. The results go to the
  Test Results panel.

---

## Flow B — Catch edits to applied migrations

### B1 · Editing an applied file (Phase 4) — `VSDrift.dc.html`
- **When:** while typing, before saving, in a file whose recorded checksum on any environment
  differs from the buffer.
- **Underline:** warning squiggle on the changed range.
- **Hover:** title "This migration has already run". Body: "It ran on prod and staging on 15 Sep, and
  on your local database. If you save this edit, its checksum changes for all three:" followed by
  `mmk down` will refuse to roll it back · `mmk status` will mark it as changed · Nothing re-runs it:
  the databases keep the old result. Then: "To change the data that's there now, write a new
  migration instead." Links: **Show applied version · Undo my edit · Create a new migration**.
  Footer `mmk(applied-edited)`.
- **Problems:** "This migration already ran on local, staging and prod. Saving the edit changes its
  checksum, and mmk down will refuse to roll it back."
- **Explorer:** `!` badge, label tinted amber. Tooltip "Edited after it ran (mmk)".
- **Run link:** `! Applied on local, staging, prod · edited since | Show applied version`.
- **Build it as:** a `DiagnosticCollection` + `HoverProvider` (or the diagnostic's message) + a
  `FileDecorationProvider` + a `CodeLensProvider`.

### B2 · Diff against the applied version (Phase 4) — `VSDiff.dc.html`
- **Title:** `backfill-invoice-currency.js (applied ↔ working tree)`.
- **Banner in the mockup:** "Found the version that ran: commit 4e1d9b2 · 12 Sep 2026 · Asha Rao —
  Its SHA-256 (3f9a1c07…be21) matches the checksum mmk recorded on local, staging and prod."
  **Build it as:** an information message with the same text, plus editor-title actions
  **Restore applied version** and **Create a new migration** (a diff editor can't host a banner).
- **Panes:** left = the applied version (read-only, scheme `mmk-applied:`), right = the working file.
- **After restore:** "Restored the version that ran. The file matches its checksum again on all
  three environments, and the warning is gone. Put your fix in a new migration."
- **Note under the panes:** "Why it matters: prod's data was written by the left-hand up(), but a
  rollback would run the right-hand down()." Show it in the information message, not in the editor.

---

## Flow C — Compare environments

### C1 · Switch environment (Phase 3) — `VSEnv.dc.html`
- **QuickPick "mmk: Select environment":** each item has the name, the host (masked), and a note:
  local "2 pending · runs allowed · current"; staging "read-only · 1 pending"; prod "read-only ·
  protected · 3 pending". Then a separator and **Compare all environments…**, **Add environment…**,
  **Edit environments** (opens settings).
- **After picking prod:** status bar `mmk: prod · read-only · 3 pending` (error background); sidebar
  note "Read-only. Run and roll back are turned off for prod; deploys go through CI."; run link above
  `up()` becomes `prod · read-only | Pending on prod | Dry run on prod | Copy CLI command`; above
  `down()`: "Nothing to roll back on prod: it hasn't run there".

### C2 · Environments matrix (Phase 3) — `VSMatrix.dc.html`
- **Header:** "Environments". Subtitle "Files on branch feat/refunds, compared with each database's
  changelog · read-only · updated 10:31". Refresh button.
- **Summary chips:** "staging has 2 that prod doesn't" · "local is missing 2 that staging has" ·
  "1 has run only on local" · "1 edited after it ran".
- **Filter:** All files · Only differences.
- **Columns:** File (name + timestamp) · LOCAL · STAGING 🔒 · PROD 🔒 · NOTE.
- **Cell states:** Applied + date · Pending · Edited + date · **Applied, file not in your branch**
  (not drawn in the mockup; add it).
- **Notes:** "On staging, not prod" · "Only on local so far" · "Edited after it ran".
- **Footer:** "Each database is read with one query on its changelog. Staging and prod are read-only
  here: to apply the 2 that prod is missing, merge and let CI deploy."
- **Also add (not in the mockup):** a **Compare files from: your branch | origin/main** switch in the header.
- **Build it as:** a `WebviewPanel` with a strict Content Security Policy. All data comes from the
  extension over `postMessage`, and the webview never runs mmk itself.

---

## Flow D — Migration console and pipeline sidebar (Phase 7)

**Mockups:** <https://claude.ai/artifact/HkfYg1uFrqRcdXYekFnXSg> (private to the owner). Page
**C · Flows** has the flow map and C1–C13; frame **B** on page **Directions** is the pipeline
sidebar. The custom looks on page **C · Styles** were turned down: the console uses VS Code's theme
colours, as C1–C13 do. The frames were drawn in Dark Modern; in any other theme the same layout
takes that theme's colours.

- **C1 Overview:** header (project, files from), environment tabs with pending counts, filters
  (*All*, *Pending*, *Needs attention*, *Only differences*), files from *branch* or *origin/main*,
  the migrations × environments table, the selected migration's detail (its record on each
  environment, actions for the selected one, the CLI command), and the selected environment's
  batches.
- **C2** an applied migration (*Run down…*, *Redo…*, *Roll back batch N…*); **C3** a read-only
  environment (a notice, *Plan* and the command to copy only); **C4** *Only differences* with
  notes, files from `origin/main`.
- **C5** new migration · **C6** plan · **C7** running (mmk's own output, no Stop) · **C8** result ·
  **C9** confirm rolling back a batch.
- **C10** the diff against the version that ran · **C11** lock held (from a run's
  `LOCK_ALREADY_HELD`; R11 shows it before a run) · **C12** can't connect (mmk's error as is) ·
  **C13** add environment.
- **Build it as:** a `WebviewPanel` (the matrix's, grown), strict CSP, data over `postMessage`,
  every action through the existing commands. The pipeline sidebar is a `WebviewView` above the
  tree. Colours: `--vscode-*` only (pending `charts-blue`, applied `testing-iconPassed`, edited
  `editorWarning-foreground`, selection `list-activeSelectionBackground`, borders
  `panel-border`), icons from codicons.

---

## Screens not drawn yet (build from these notes)

- **Add environment** (Phase 3): name → masked connection-string input → database (pre-filled from
  the URI path) → "Testing connection…" → "Connected · 44 applied, 1 pending" or mmk's own error
  message → read-only toggle (on by default for anything not `local`).
- **Welcome views** (Phase 2): mmk not installed ("Install mongo-migrate-kit in this project");
  mmk too old ("Update to X or later"); untrusted workspace ("Trust this folder to run mmk");
  connection failed (mmk's `CONNECTION_FAILED` message, which already names the masked URI and the reason).
- **Branch-switch warning** (Phase 3): "Local has 1 migration from another branch: x.js. Its file
  isn't in feat/b, so it can't be rolled back from here."
