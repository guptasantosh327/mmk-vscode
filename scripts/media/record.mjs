// Records the README's GIFs and screenshots from the real extension in a real VS Code: a demo
// project ("shop-api") with migrations applied on three databases of an in-memory MongoDB,
// played by scripts/media/driver.cjs. Nothing on screen is made up: it's what mmk and the
// extension show. The GIF encoder packages aren't project dependencies, so install them first:
//
//   npm i --no-save gifenc@1.0.3 pngjs@7.0.0
//   npm run bundle && node scripts/media/record.mjs
//
// Output: media/readme/*.gif and *.png. It needs the next mongo-migrate-kit (see
// docs/MMK-REQUESTS.md) for the edit warning, rollback tests and lint.
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { connect, sleep } from './chrome.mjs';

let GIFEncoder;
let quantize;
let applyPalette;
let PNG;
try {
  const gifenc = await import('gifenc');
  ({ GIFEncoder, quantize, applyPalette } = gifenc.default ?? gifenc);
  ({ PNG } = await import('pngjs'));
} catch {
  console.error('Missing encoder packages. Run: npm i --no-save gifenc@1.0.3 pngjs@7.0.0');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '../..');
const output = join(root, 'media/readme');
const demo = join(root, '.vscode-test/readme-demo/shop-api');
const mmk = join(root, 'node_modules/mongo-migrate-kit/dist/mmk.cjs');
// The IPC socket path must stay short: macOS's per-user temp folder is too deep for it.
const scratch = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'mmk-media-'));
const requests = join(scratch, 'requests');
const frames = join(scratch, 'frames');
const WIDTH = 1280;
const HEIGHT = 800;

const MIGRATIONS = {
  '20261012090000-add-users-email-index.js': `module.exports = {
  description: 'Index users by email',
  author: 'Asha Rao <asha@example.com>',

  async up({ db }) {
    await db.collection('users').createIndex({ email: 1 }, { name: 'users_by_email', unique: true });
  },

  async down({ db }) {
    await db.collection('users').dropIndex('users_by_email');
  },
};
`,
  '20261012091500-backfill-order-status.js': `module.exports = {
  description: 'Give every order without a status one',
  author: 'Ravi Kumar <ravi@example.com>',

  async up({ db }) {
    await db.collection('orders').updateMany({ status: { $exists: false } }, { $set: { status: 'open' } });
  },

  async down({ db }) {
    await db.collection('orders').updateMany({ status: 'open' }, { $unset: { status: '' } });
  },
};
`,
  '20261014103000-add-orders-region-field.js': `module.exports = {
  description: 'Default every order to the EU region',
  author: 'Asha Rao <asha@example.com>',

  async up({ db }) {
    await db.collection('orders').updateMany({ region: { $exists: false } }, { $set: { region: 'eu' } });
  },

  async down({ db }) {
    await db.collection('orders').updateMany({ region: 'eu' }, { $unset: { region: '' } });
  },
};
`,
  '20261015110000-index-payments-by-customer.js': `module.exports = {
  description: 'Index payments by customer',
  author: 'Ravi Kumar <ravi@example.com>',

  async up({ db }) {
    await db.collection('payments').createIndex({ customerId: 1 });
  },

  async down({ db }) {
    await db.collection('payments').dropIndex('customerId_1');
  },
};
`,
  '20261016101502-index-orders-by-customer-date.js': `module.exports = {
  description: 'Index orders by customer and date',
  author: 'Asha Rao <asha@example.com>',

  async up({ db }) {
    await db
      .collection('orders')
      .createIndex({ customerId: 1, createdAt: -1 }, { name: 'orders_by_customer_date' });
  },
  async down({ db }) {
    await db.collection('orders').dropIndex('customerId_1_createdAt_-1');
  },
};
`,
};

/** The edit made to the backfill after it ran everywhere: the classic mistake */
const BACKFILL_EDITED = MIGRATIONS['20261012091500-backfill-order-status.js'].replaceAll(
  "'open'",
  "'pending'",
);

function git(...args) {
  return execFileSync('git', args, {
    cwd: demo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Asha Rao',
      GIT_AUTHOR_EMAIL: 'asha@example.com',
      GIT_AUTHOR_DATE: '2026-10-12T10:00:00+05:30',
      GIT_COMMITTER_NAME: 'Asha Rao',
      GIT_COMMITTER_EMAIL: 'asha@example.com',
      GIT_COMMITTER_DATE: '2026-10-12T10:00:00+05:30',
    },
  });
}

function runMmk(uri, dbName, args) {
  execFileSync(process.execPath, [mmk, ...args], {
    cwd: demo,
    env: { ...process.env, MMK_URI: uri, MMK_DB: dbName },
    stdio: 'ignore',
  });
}

/** The demo project, its git history, and what has run on each database */
function prepare(uri) {
  rmSync(dirname(demo), { recursive: true, force: true });
  mkdirSync(join(demo, 'migrations'), { recursive: true });
  writeFileSync(join(demo, 'package.json'), `${JSON.stringify({ name: 'shop-api', private: true, type: 'commonjs' }, null, 2)}\n`);
  writeFileSync(join(demo, 'mmk.config.js'), "module.exports = {\n  migrationsDir: './migrations',\n};\n");
  for (const [file, source] of Object.entries(MIGRATIONS)) {
    writeFileSync(join(demo, 'migrations', file), source);
  }
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'Add the order and payment migrations');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'feat/refunds');

  const [users, backfill, region, payments] = Object.keys(MIGRATIONS);
  for (const db of ['orders_dev', 'orders_staging', 'orders_prod']) {
    runMmk(uri, db, ['up', users]);
    runMmk(uri, db, ['up', backfill]);
  }
  runMmk(uri, 'orders_staging', ['up', region]);
  runMmk(uri, 'orders_staging', ['up', payments]);

  // After it ran everywhere, someone edits the backfill and commits it.
  writeFileSync(join(demo, 'migrations', backfill), BACKFILL_EDITED);
  git('commit', '-q', '-am', 'Use pending as the default order status');
}

/** Answer the driver's requests: frames, typing and keys, over the DevTools protocol */
async function serve(page, finished) {
  let next = 1;
  for (;;) {
    const id = String(next).padStart(3, '0');
    const file = join(requests, `request-${id}.json`);
    if (!existsSync(file)) {
      if (finished.value) {
        return;
      }
      await sleep(50);
      continue;
    }
    const request = JSON.parse(readFileSync(file, 'utf8'));
    if (request.action === 'frame') {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      const target = join(frames, `${request.name}.png`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(data, 'base64'));
      writeFileSync(`${target}.hold`, String(request.hold));
      console.log(`  frame ${request.name}`);
    } else if (request.action === 'type') {
      await page.send('Input.insertText', { text: request.text });
    } else if (request.action === 'key') {
      const key = { key: request.key, code: request.key, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
      await page.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...key });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    } else if (request.action === 'finish') {
      finished.value = true;
    }
    writeFileSync(join(requests, `done-${id}`), '');
    next += 1;
  }
}

function readPng(file) {
  return PNG.sync.read(readFileSync(file));
}

/** A GIF from frames/<name>/*.png, or a PNG still from frames/<name>.png */
function encode(name) {
  const folder = join(frames, name);
  mkdirSync(output, { recursive: true });
  if (!existsSync(folder)) {
    writeFileSync(join(output, `${name}.png`), readFileSync(`${folder}.png`));
    console.log(`wrote media/readme/${name}.png`);
    return;
  }
  const files = readdirSync(folder)
    .filter((file) => file.endsWith('.png'))
    .sort();
  const gif = GIFEncoder();
  for (const file of files) {
    const image = readPng(join(folder, file));
    const palette = quantize(image.data, 256);
    const index = applyPalette(image.data, palette);
    const hold = Number(readFileSync(join(folder, `${file}.hold`), 'utf8'));
    gif.writeFrame(index, image.width, image.height, { palette, delay: hold });
  }
  gif.finish();
  writeFileSync(join(output, `${name}.gif`), gif.bytes());
  console.log(`wrote media/readme/${name}.gif (${files.length} frames)`);
}

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
let code = null;
try {
  const uri = replSet.getUri();
  prepare(uri);
  mkdirSync(requests, { recursive: true });
  mkdirSync(frames, { recursive: true });

  const userData = join(scratch, 'user-data');
  mkdirSync(join(userData, 'User'), { recursive: true });
  writeFileSync(
    join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'workbench.colorTheme': 'Default Dark Modern',
      'workbench.startupEditor': 'none',
      'workbench.tips.enabled': false,
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'workbench.layoutControl.enabled': false,
      'window.commandCenter': false,
      'chat.disableAIFeatures': true,
      'editor.minimap.enabled': false,
      'editor.fontSize': 13,
      'editor.hover.delay': 100,
      'testing.automaticallyOpenPeekView': 'failureInVisibleDocument',
      'testing.openTesting': 'neverOpen',
      'git.openRepositoryInParentFolders': 'always',
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'extensions.ignoreRecommendations': true,
      'security.workspace.trust.enabled': false,
    }),
  );
  const executable = await downloadAndUnzipVSCode({ cachePath: join(root, '.vscode-test') });
  const port = 9800 + Math.floor(Math.random() * 100);
  const env = {
    ...process.env,
    MMK_URI: uri,
    MMK_DB: 'orders_dev',
    MEDIA_DIR: requests,
    MEDIA_MONGO_URI: uri,
  };
  env.ELECTRON_RUN_AS_NODE = undefined;
  const code_ = spawn(
    executable,
    [
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--disable-extensions',
      '--password-store=basic',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${join(scratch, 'extensions')}`,
      `--extensionDevelopmentPath=${root}`,
      `--extensionTestsPath=${join(root, 'scripts/media/driver.cjs')}`,
      demo,
    ],
    { env, stdio: 'ignore' },
  );
  const exited = new Promise((resolveExit) => code_.once('exit', (exitCode) => resolveExit(exitCode)));
  const page = await connect(port, (target) => target.type === 'page' && target.url.includes('workbench'));
  // The window usually isn't the focused app while recording; hovers need focus.
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const finished = { value: false };
  await serve(page, finished);
  page.close();
  code = await exited;
  for (const name of ['local-workflow', 'environments', 'applied-edit', 'rollback-tests', 'lint']) {
    encode(name);
  }
} finally {
  await replSet.stop();
  if (process.env.MEDIA_KEEP_FRAMES) {
    // For reviewing every frame: copies them before the scratch folder goes.
    execFileSync('cp', ['-R', frames, process.env.MEDIA_KEEP_FRAMES]);
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`VS Code exited with ${code}`);
