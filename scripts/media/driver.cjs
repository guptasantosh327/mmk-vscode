// Runs inside VS Code (as --extensionTestsPath) to play the README scenes with the real
// extension. Screenshots, typing and key presses are done from outside over the DevTools
// protocol by scripts/media/record.mjs: this asks for them through files in MEDIA_DIR.
const { existsSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const out = process.env.MEDIA_DIR;
let requests = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask record.mjs to do something in the window, and wait until it has */
async function ask(request) {
  requests += 1;
  const id = String(requests).padStart(3, '0');
  writeFileSync(path.join(out, `request-${id}.json`), JSON.stringify(request));
  const done = path.join(out, `done-${id}`);
  for (let waited = 0; !existsSync(done); waited += 50) {
    if (waited > 60_000) {
      throw new Error(`record.mjs didn't answer request ${id} (${request.action})`);
    }
    await sleep(50);
  }
}

/** A frame of a GIF (or a still): `name` is the file, `hold` how long it shows */
const frame = (name, hold = 1800) => ask({ action: 'frame', name, hold });
const type = (text) => ask({ action: 'type', text });
const press = (key) => ask({ action: 'key', key });

/** The scenes to play (MEDIA_SCENES, comma-separated); all of them by default */
const scenes = (
  process.env.MEDIA_SCENES || 'local-workflow,environments,applied-edit,console'
).split(',');

/**
 * Another run holding prod's migration lock, as a deploy on a CI runner would: the document mmk
 * writes when it takes the lock, with that runner's host and user instead of this machine's.
 */
async function holdProdLock() {
  const { MongoClient } = require('mongodb');
  const client = await MongoClient.connect(process.env.MEDIA_MONGO_URI);
  try {
    const now = Date.now();
    await client
      .db('orders_prod')
      .collection('_mmk_locks')
      .replaceOne(
        { _id: 'mmk_lock' },
        {
          lockedAt: new Date(now - 20_000),
          acquiredAt: new Date(now - 4 * 60_000),
          expiresAt: new Date(now + 40_000),
          pid: 4127,
          host: 'deploy-runner-7',
          executedBy: 'ci',
          owner: require('node:crypto').randomUUID(),
        },
        { upsert: true },
      );
  } finally {
    await client.close();
  }
}

async function run() {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const migrations = path.join(workspace, 'migrations');
  const file = (name) => vscode.Uri.file(path.join(migrations, name));
  const api = await vscode.extensions.getExtension('guptasantosh327.mongo-migrate-kit').activate();
  api.setConfirm(() => true);
  const settle = async (ms = 1200) => {
    await api.idle();
    await sleep(ms);
  };
  const exec = (command, ...args) => vscode.commands.executeCommand(command, ...args);
  // Wait for the project to be found before adding environments to it.
  await exec('mmk.refresh');
  await api.idle();
  const open = async (name, line) => {
    const editor = await vscode.window.showTextDocument(file(name), { preview: false });
    if (line !== undefined) {
      const position = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter,
      );
    }
    return editor;
  };
  const closeAll = () => exec('workbench.action.closeAllEditors');
  const clearNotifications = () => exec('notifications.clearAll');

  // Environments (stored in the keychain, as the Add environment flow does after its prompts).
  for (const name of ['staging', 'prod']) {
    await exec('mmk.addEnvironment', {
      dir: workspace,
      name,
      uri: process.env.MEDIA_MONGO_URI,
      dbName: `orders_${name}`,
      readOnly: true,
      skipTest: true,
    });
  }
  await exec('mmk.refresh');
  await exec('workbench.view.extension.mmk');
  await settle(2000);
  await clearNotifications();

  // ── A1 → A2 → A3: create, run up, see it applied ─────────────────────────────────────
  if (scenes.includes('local-workflow')) await localWorkflow();
  if (scenes.includes('environments')) await environments();
  if (scenes.includes('applied-edit')) await appliedEdit();
  if (scenes.includes('console')) await migrationConsole();
  await ask({ action: 'finish' });

  async function localWorkflow() {
    await open('20261014103000-add-orders-region-field.js', 0);
    await settle();
    await frame('local-workflow/1');
    const creating = exec('mmk.createMigration');
    await sleep(800);
    await type('add refunds collection');
    await sleep(500);
    await frame('local-workflow/2');
    await press('Enter');
    const created = await creating;
    await settle();
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(created));
    await editor.edit((edit) =>
      edit.replace(
        new vscode.Range(0, 0, editor.document.lineCount, 0),
        `module.exports = {
  description: 'Create the refunds collection',
  author: 'Asha Rao <asha@example.com>',

  async up({ db }) {
    await db.createCollection('refunds');
    await db.collection('refunds').createIndex({ invoiceId: 1 }, { name: 'refunds_by_invoice' });
  },

  async down({ db }) {
    await db.collection('refunds').drop();
  },
};
`,
      ),
    );
    await editor.document.save();
    await settle();
    await frame('local-workflow/3');
    await exec('mmk.up', vscode.Uri.file(created));
    await settle(800);
    await frame('local-workflow/4', 3000);
    await clearNotifications();
  }

  async function environments() {
    // ── C1: switch to prod (read-only) ────────────────────────────────────────────────────
    await open('20261014103000-add-orders-region-field.js', 0);
    const picking = exec('mmk.selectEnvironment');
    await sleep(900);
    await frame('environments/1', 2200);
    await type('prod');
    await sleep(300);
    await press('Enter');
    await picking;
    await settle();
    await frame('environments/2', 2600);

    // ── C2–C4: the console on what differs, then one migration on every environment ───────
    const panel = await exec('mmk.compareEnvironments', { dir: workspace });
    await settle(2500);
    await frame('environments/3', 3000);
    await panel.receive({ type: 'pick', file: '20261012091500-backfill-order-status.js' });
    await settle(1500);
    await frame('environments/4', 3500);
    await exec('mmk.selectEnvironment', 'local');
    await closeAll();
    await clearNotifications();
  }

  async function appliedEdit() {
    // ── B1 → B2: edit an applied migration, then look at the version that ran ──────────────
    const applied = await open('20261012090000-add-users-email-index.js', 4);
    await settle();
    await applied.edit((edit) =>
      edit.insert(
        new vscode.Position(5, 0),
        "    await db.collection('users').createIndex({ createdAt: -1 });\n",
      ),
    );
    await api.checkApplied(applied.document);
    await sleep(1200);
    await frame('applied-edit/1');
    // The same warning in Problems (VS Code won't open a hover in a window that isn't focused).
    await exec('workbench.actions.view.problems');
    await sleep(1500);
    await frame('applied-edit/2', 3500);
    await exec('workbench.action.closePanel');
    await vscode.window.showTextDocument(applied.document);
    await exec('workbench.action.files.revert');
    await closeAll();
    await exec('mmk.showAppliedVersion', file('20261012091500-backfill-order-status.js'));
    await sleep(2500);
    await frame('applied-edit/3', 4000);
    await closeAll();
    await clearNotifications();
  }

  async function migrationConsole() {
    // ── The console on local: every migration on every environment, the first pending picked ─
    const panel = await exec('mmk.openConsole', { dir: workspace });
    await settle(2500);
    await frame('console/1', 3500);

    // ── Plan, apply while mmk's output comes in, the result ──────────────────────────────
    await panel.receive({ type: 'plan' });
    await settle(800);
    await frame('console/2', 2800);
    const applying = panel.receive({ type: 'applyPlan' });
    for (let waited = 0; waited < 30_000; waited += 50) {
      const run = panel.view().run;
      if (run?.state === 'running' && run.lines.some((line) => line.includes('Applied'))) {
        break;
      }
      await sleep(50);
    }
    // The webview draws the new line a moment after the view has it.
    await sleep(150);
    await frame('console/3', 2200);
    const result = await applying;
    await settle(800);
    await frame('console/4', 3000);

    // ── Roll that batch back from the result ─────────────────────────────────────────────
    if (result?.rollBackBatch) {
      await panel.receive({ type: 'rollBack', batch: result.rollBackBatch });
      await settle(800);
      await frame('console/5', 2800);
    }

    // ── prod: read-only, a deploy holding its lock, only what differs ────────────────────
    await panel.receive({ type: 'closeDrawer' });
    await holdProdLock();
    await panel.receive({ type: 'environment', name: 'prod' });
    await panel.receive({ type: 'filter', value: 'diff' });
    await exec('mmk.refresh');
    await settle(1500);
    await frame('console/6', 3800);

    // ── Editing an environment: the same form that adds one ──────────────────────────────
    await panel.receive({ type: 'editEnvironment', name: 'staging' });
    await settle(600);
    await frame('console/7', 3000);
    await panel.receive({ type: 'closeDialog' });
    await exec('mmk.selectEnvironment', 'local');
    await closeAll();
    await clearNotifications();
  }
}

module.exports = { run };
