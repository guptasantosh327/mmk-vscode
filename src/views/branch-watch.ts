import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Deps } from '../commands/context.js';
import { branchesWithFile } from '../git/branches.js';
import { LOCAL_ENVIRONMENT } from '../mmk/environments.js';

/** The parts of the built-in git extension's API (`vscode.git`, version 1) used here */
interface GitApi {
  readonly repositories: readonly GitRepository[];
  onDidOpenRepository(listener: (repository: GitRepository) => void): vscode.Disposable;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined;
    onDidChange(listener: () => void): vscode.Disposable;
  };
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

/**
 * After a checkout, warn when local has applied migrations whose files aren't on the new
 * branch (mmk's `fileMissing`) but are on another branch: they can't be rolled back from here.
 * Names that branch. Files deleted on every branch are left alone, and each file is reported
 * once per branch it's missing from.
 */
export class BranchWatch implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly heads = new Map<string, string | undefined>();
  /** `<project>|<file>|<branch>` already reported */
  private readonly reported = new Set<string>();

  constructor(private readonly deps: Deps) {
    void this.attach();
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private async attach(): Promise<void> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) {
      return;
    }
    let api: GitApi;
    try {
      api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
    } catch (error) {
      this.deps.log.debug(
        `The git extension isn't available, so branch switches aren't watched: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const repository of api.repositories) {
      this.watch(repository);
    }
    this.disposables.push(api.onDidOpenRepository((repository) => this.watch(repository)));
  }

  private watch(repository: GitRepository): void {
    const key = repository.rootUri.fsPath;
    this.heads.set(key, repository.state.HEAD?.name ?? repository.state.HEAD?.commit);
    this.disposables.push(
      repository.state.onDidChange(() => {
        const head = repository.state.HEAD?.name ?? repository.state.HEAD?.commit;
        if (head === this.heads.get(key)) {
          return;
        }
        this.heads.set(key, head);
        void this.checkAfterSwitch(key, repository.state.HEAD?.name ?? null);
      }),
    );
  }

  /** Re-read local for each project in the repository, then report migrations from other branches */
  async checkAfterSwitch(root: string, branch: string | null): Promise<string[]> {
    const messages: string[] = [];
    const projects = this.deps.store
      .snapshots()
      .filter((project) => !path.relative(root, project.dir).startsWith('..'));
    for (const project of projects) {
      await this.deps.store.refresh(project.dir, { environment: LOCAL_ENVIRONMENT });
      const snapshot = this.deps.store.snapshot(project.dir);
      const rows = snapshot?.environments[LOCAL_ENVIRONMENT]?.rows;
      const migrationsDir = snapshot?.config?.migrationsDir;
      if (!rows || !migrationsDir) {
        continue;
      }
      const found: Array<{ file: string; from: string }> = [];
      for (const row of rows) {
        const key = `${project.dir}|${row.file}|${branch ?? ''}`;
        if (row.status !== 'applied' || !row.fileMissing || this.reported.has(key)) {
          continue;
        }
        const from = await branchesWithFile(
          project.dir,
          path.join(migrationsDir, row.file),
          branch,
        );
        if (from[0] !== undefined) {
          this.reported.add(key);
          found.push({ file: row.file, from: from[0] });
        }
      }
      if (found.length === 0) {
        continue;
      }
      const one = found.length === 1;
      const names = found.map((item) => item.file.replace(/^\d+-/, '')).join(', ');
      const sources = [...new Set(found.map((item) => item.from))];
      const here = branch ? `in ${branch}` : 'in this checkout';
      const message = `Local has ${one ? '1 migration' : `${found.length} migrations`} from another branch: ${names}. ${one ? "Its file isn't" : "Their files aren't"} ${here}, so ${one ? 'it' : 'they'} can't be rolled back from here. ${one ? 'It is' : 'They are'} on ${sources.join(', ')}.`;
      messages.push(message);
      this.deps.log.warn(message);
      void vscode.window.showWarningMessage(message, 'Compare all environments').then((choice) => {
        if (choice === 'Compare all environments') {
          void vscode.commands.executeCommand('mmk.compareEnvironments', { dir: project.dir });
        }
      });
    }
    return messages;
  }
}
