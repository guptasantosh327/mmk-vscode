// A small DevTools Protocol client over Node's built-in WebSocket, for the media scripts.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Connect to a page target of a browser listening on `port`; returns { send, close } */
export async function connect(port, pick = (target) => target.type === 'page') {
  let targets;
  for (let attempt = 0; attempt < 100 && !targets?.some(pick); attempt += 1) {
    await sleep(200);
    targets = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((response) => response.json())
      .catch(() => undefined);
  }
  const target = targets?.find(pick);
  if (!target) {
    throw new Error(`No matching DevTools target on port ${port}`);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      waiting.set(id, (message) =>
        message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result),
      );
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close(), target };
}

/** Start headless Chrome; returns { port, stop } */
export async function startChrome() {
  const chromePath =
    process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), 'mmk-vscode-media-'));
  const chrome = spawn(
    chromePath,
    ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  return {
    port,
    stop: async () => {
      chrome.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}
