import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type Deps, relativeDir } from '../commands/context.js';
import { environmentLocks } from '../mmk/lock-holder.js';
import { matrixInputs } from '../mmk/matrix.js';
import {
  type PipelineMessage,
  type PipelineModel,
  buildPipeline,
  isPipelineMessage,
} from '../mmk/pipeline.js';
import type { ConsolePanel } from './console/panel.js';

/** The pipeline view's ID in the mmk container */
export const PIPELINE_VIEW = 'mmk.pipeline';

/** Everything the pipeline webview draws */
export interface PipelineView {
  projects: Array<{ dir: string; title: string; model: PipelineModel }>;
}

/**
 * The environments as a pipeline at the top of the mmk sidebar (design B): each one's pending
 * count, read-only state, latest migration and what needs attention, then the selected one's
 * pending migrations. It only reads the store; *Review* opens the console's plan, where nothing
 * runs without a click.
 */
export class PipelineProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private webview: vscode.Webview | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private redrawTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deps: Deps,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.disposables.push(deps.store.onDidChange(() => this.changed()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const codicons = vscode.Uri.joinPath(
      this.extensionUri,
      'node_modules',
      '@vscode',
      'codicons',
      'dist',
    );
    const media = vscode.Uri.joinPath(this.extensionUri, 'media', 'pipeline');
    view.webview.options = { enableScripts: true, localResourceRoots: [codicons, media] };
    view.webview.html = this.html(view.webview, codicons, media);
    this.webview = view.webview;
    this.disposables.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (isPipelineMessage(message)) {
          void this.receive(message);
        }
      }),
      view.onDidDispose(() => {
        this.webview = undefined;
      }),
    );
  }

  /** The view as the webview gets it; for tests */
  view(): PipelineView {
    const environments = this.deps.store.environments();
    const selected = this.deps.store.selected().name;
    return {
      projects: this.deps.store.snapshots().map((project) => ({
        dir: project.dir,
        title: relativeDir(project.dir) || path.basename(project.dir),
        model: buildPipeline(
          matrixInputs(project, environments),
          selected,
          new Date(),
          environmentLocks(project, environments),
        ),
      })),
    };
  }

  /** Handle one message from the webview (integration tests send them too) */
  async receive(message: PipelineMessage): Promise<unknown> {
    switch (message.type) {
      case 'ready':
        this.post();
        return undefined;
      case 'select':
        await this.deps.environments.select(message.name);
        return undefined;
      case 'review': {
        const panel = await this.openConsole(message.dir);
        return panel?.receive({ type: 'plan' });
      }
      case 'pick': {
        const panel = await this.openConsole(message.dir);
        return panel?.receive({ type: 'pick', file: message.file });
      }
      case 'console':
        return this.openConsole(message.dir);
      case 'create':
        return vscode.commands.executeCommand('mmk.createMigration');
      case 'addEnvironment':
        return vscode.commands.executeCommand('mmk.addEnvironment');
      case 'edit':
        return vscode.commands.executeCommand('mmk.editEnvironment', message.name);
    }
  }

  dispose(): void {
    if (this.redrawTimer) {
      clearTimeout(this.redrawTimer);
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private openConsole(dir: string): Thenable<ConsolePanel | undefined> {
    return vscode.commands.executeCommand<ConsolePanel | undefined>('mmk.openConsole', { dir });
  }

  private changed(): void {
    if (this.redrawTimer) {
      clearTimeout(this.redrawTimer);
    }
    this.redrawTimer = setTimeout(() => this.post(), 50);
  }

  private post(): void {
    if (this.webview) {
      void this.webview.postMessage({ type: 'model', view: this.view() });
    }
  }

  private html(webview: vscode.Webview, codicons: vscode.Uri, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'pipeline.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'pipeline.js'));
    const icons = webview.asWebviewUri(vscode.Uri.joinPath(codicons, 'codicon.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${icons}">
<link rel="stylesheet" href="${css}">
<title>Environments</title>
</head>
<body>
<main id="app" aria-live="polite"></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
