# Prompts

Copy these into Claude Code. `CLAUDE.md` is loaded automatically in every session; these prompts only
start the work and keep each phase's scope tight.

---

## 1. First session in this repo (paste once)

```
We're building the VS Code extension for mongo-migrate-kit in this repo. Nothing is built yet.

Before writing any code:
1. Read CLAUDE.md completely, then docs/PLAN.md, docs/MMK-REQUESTS.md and design/SCREENS.md.
2. Read these in the mongo-migrate-kit repo (path in CLAUDE.md §2): CLAUDE.md §0, §2, §7, §13;
   ARCHITECTURE.md; src/types/index.ts; src/cli/shared.ts; src/cli/commands/status.ts; package.json.
3. Reply with at most 15 bullets: the architecture, the source-of-truth rules, and Phase 1's tasks and
   exit criteria. List anything in docs/ that contradicts what you found in mongo-migrate-kit
   (a renamed file, a changed JSON field, a request that's already done), and propose fixes to
   docs/ only.
4. Wait for my go-ahead. Then do Phase 1 only. When its exit criteria pass, say
   "PHASE 1 COMPLETE", update CLAUDE.md §0, and stop.
```

---

## 2. Each later phase (in this repo)

```
Start Phase <N> from docs/PLAN.md.

First check its "Needs from mmk" requests in docs/MMK-REQUESTS.md against the actual
mongo-migrate-kit code and CHANGELOG. If any isn't released (or available through
file:../mongo-migrate-kit), stop and tell me which, and don't work around it.

Then re-read the mongo-migrate-kit files that CLAUDE.md §2's table names for this phase's work,
and the phase's screens in design/SCREENS.md (plus design/screens/*.dc.html for exact copy).
Build only Phase <N>. When the exit criteria pass, say "PHASE <N> COMPLETE", update
CLAUDE.md §0 and docs/MMK-REQUESTS.md statuses, and stop.
```

---

## 3. Building a request in mongo-migrate-kit

Since 2026-10-17 this can also run from a session in this repo (CLAUDE.md §2 rule 3): say
"Build R<k> in mongo-migrate-kit". The prompt below is for a session opened in that repo.

```
Implement request R<k> from ../mmk-vscode/docs/MMK-REQUESTS.md.

Follow this repo's CLAUDE.md exactly. The change must be additive and non-breaking, with tests
(including a shape test for any --json output), docs under docs/, and a CHANGELOG entry.
First write a short design note and wait for my go-ahead before coding. Don't edit anything in
../mmk-vscode except the status line of R<k> in docs/MMK-REQUESTS.md once it's released.
```

---

## 4. When mongo-migrate-kit releases a new version (in this repo)

```
mongo-migrate-kit released <version>. Read its CHANGELOG entry and the diff of src/types/index.ts
and src/cli/ since the version our devDependency pins. Bump the devDependency, run the contract
tests, and report any shape change before fixing anything.
```
