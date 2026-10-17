import * as path from 'node:path';
import * as vscode from 'vscode';
import { type Deps, databaseLabel, relativeDir } from '../commands/context.js';
import type { WireStatusRow } from '../mmk/contract.js';
import type { Environment } from '../mmk/environments.js';
import {
  type BatchGroup,
  type StatusModel,
  buildStatusModel,
  formatDay,
  formatDuration,
  formatWhen,
} from '../mmk/model.js';
import { displayName } from '../mmk/naming.js';
import type { ProjectSnapshot } from '../mmk/store.js';

/** The view's ID in package.json */
export const SIDEBAR_VIEW = 'mmk.migrations';

/** How many batches show before the rest fold into "N older batches" */
const RECENT_BATCHES = 3;

type GroupKind = 'pending' | 'edited' | 'unadopted' | 'applied';

/** One row of the sidebar. Plain data, so commands can take it as their argument */
export type SidebarNode =
  | { kind: 'project'; dir: string }
  | { kind: 'env'; dir: string }
  | {
      kind: 'notice';
      dir: string;
      id: string;
      text: string;
      detail?: string;
      tone: Tone;
      /** A command the row runs when clicked, e.g. to set an environment up */
      command?: string;
      args?: unknown[];
    }
  | { kind: 'group'; dir: string; group: GroupKind }
  | { kind: 'batch'; dir: string; batch: number; latest: boolean }
  | { kind: 'older'; dir: string }
  | { kind: 'migration'; dir: string; file: string; group: GroupKind }
  | { kind: 'action'; dir: string; action: 'upAll' | 'dryRun' };

type Tone = 'loading' | 'error' | 'ok' | 'running' | 'locked' | 'setup';

/** The "mmk: Migrations" tree (design A2): environment, pending, edited, applied by batch */
export class SidebarProvider implements vscode.TreeDataProvider<SidebarNode> {
  private readonly changed = new vscode.EventEmitter<SidebarNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly deps: Deps) {}

  /** Redraw everything (after the store changed) */
  refresh(): void {
    this.changed.fire(undefined);
  }

  getChildren(node?: SidebarNode): SidebarNode[] {
    const { store } = this.deps;
    if (!node) {
      const projects = store.snapshots();
      if (projects.length === 1 && projects[0]) {
        // A single project that can't run mmk is explained by the view's welcome content.
        return projects[0].state.kind === 'ready' ? this.projectChildren(projects[0]) : [];
      }
      return projects.map((project) => ({ kind: 'project', dir: project.dir }));
    }
    const project = store.snapshot(node.dir);
    if (!project) {
      return [];
    }
    const model = project.rows ? buildStatusModel(project.rows) : undefined;
    switch (node.kind) {
      case 'project':
        return this.projectChildren(project);
      case 'group':
        return model ? this.groupChildren(project, model, node.group) : [];
      case 'batch': {
        const group = model?.batches.find((candidate) => candidate.batch === node.batch);
        return group ? migrationNodes(project.dir, group.rows, 'applied') : [];
      }
      case 'older':
        return (model?.batches.slice(RECENT_BATCHES) ?? []).map((group) =>
          batchNode(project, group, false),
        );
      default:
        return [];
    }
  }

  getTreeItem(node: SidebarNode): vscode.TreeItem {
    const project = this.deps.store.snapshot(node.dir);
    const model = project?.rows ? buildStatusModel(project.rows) : undefined;
    const environment = this.deps.store.selected();
    const item = (() => {
      switch (node.kind) {
        case 'project':
          return projectItem(node.dir, project);
        case 'env':
          return envItem(project, environment);
        case 'notice':
          return noticeItem(node);
        case 'group':
          return groupItem(node.group, model, environment);
        case 'batch':
          return batchItem(node, model);
        case 'older':
          return olderItem(model);
        case 'migration':
          return migrationItem(node, project, this.deps.created, environment);
        case 'action':
          return actionItem(node, model, environment);
      }
    })();
    item.id = nodeId(node);
    return item;
  }

  private projectChildren(project: ProjectSnapshot): SidebarNode[] {
    const { dir } = project;
    if (project.state.kind !== 'ready') {
      return [notice(dir, 'problem', project.state.message, 'error')];
    }
    const environment = this.deps.store.selected();
    const name = environment.name;
    const nodes: SidebarNode[] = [{ kind: 'env', dir }];
    if (environment.readOnly) {
      nodes.push(
        notice(
          dir,
          'read-only',
          `Read-only. Run and roll back are turned off for ${name}; deploys go through CI.`,
          'locked',
        ),
      );
    }
    if (project.running) {
      nodes.push(
        notice(
          dir,
          'running',
          `Running ${project.running} on ${project.runningOn ?? name}…`,
          'running',
        ),
      );
    }
    if (project.environments[name]?.connected === false) {
      nodes.push({
        ...notice(
          dir,
          'not-set-up',
          `${name} isn't set up for this project`,
          'setup',
          'Click to add its connection string. It is kept in the OS keychain.',
        ),
        command: 'mmk.editEnvironment',
        args: [name],
      } as SidebarNode);
      return nodes;
    }
    if (project.error) {
      nodes.push(
        notice(
          dir,
          'error',
          `Couldn't read status on ${name}`,
          'error',
          project.error.code
            ? `${project.error.code}: ${project.error.message}`
            : project.error.message,
        ),
      );
      return nodes;
    }
    if (!project.rows) {
      nodes.push(notice(dir, 'loading', `Reading status on ${name}…`, 'loading'));
      return nodes;
    }
    const model = buildStatusModel(project.rows);
    nodes.push({ kind: 'group', dir, group: 'pending' });
    if (model.edited.length > 0) {
      nodes.push({ kind: 'group', dir, group: 'edited' });
    }
    if (model.unadopted.length > 0) {
      nodes.push({ kind: 'group', dir, group: 'unadopted' });
    }
    nodes.push({ kind: 'group', dir, group: 'applied' });
    return nodes;
  }

  private groupChildren(
    project: ProjectSnapshot,
    model: StatusModel,
    group: GroupKind,
  ): SidebarNode[] {
    const { dir } = project;
    const environment = this.deps.store.selected();
    switch (group) {
      case 'pending':
        return model.pending.length === 0
          ? [notice(dir, 'none-pending', `Nothing pending on ${environment.name}`, 'ok')]
          : [
              ...migrationNodes(dir, model.pending, 'pending'),
              ...(environment.readOnly
                ? []
                : [{ kind: 'action', dir, action: 'upAll' } as SidebarNode]),
              { kind: 'action', dir, action: 'dryRun' },
            ];
      case 'edited':
        return migrationNodes(dir, model.edited, 'edited');
      case 'unadopted':
        return migrationNodes(dir, model.unadopted, 'unadopted');
      case 'applied': {
        if (model.batches.length === 0) {
          return [notice(dir, 'none-applied', `Nothing applied on ${environment.name} yet`, 'ok')];
        }
        const recent = model.batches
          .slice(0, RECENT_BATCHES)
          .map((batch, index) => batchNode(project, batch, index === 0));
        return model.batches.length > RECENT_BATCHES ? [...recent, { kind: 'older', dir }] : recent;
      }
    }
  }
}

function notice(dir: string, id: string, text: string, tone: Tone, detail?: string): SidebarNode {
  return { kind: 'notice', dir, id, text, tone, ...(detail === undefined ? {} : { detail }) };
}

function batchNode(project: ProjectSnapshot, group: BatchGroup, latest: boolean): SidebarNode {
  return { kind: 'batch', dir: project.dir, batch: group.batch, latest };
}

function migrationNodes(
  dir: string,
  rows: readonly WireStatusRow[],
  group: GroupKind,
): SidebarNode[] {
  return rows.map((row) => ({ kind: 'migration', dir, file: row.file, group }));
}

function nodeId(node: SidebarNode): string {
  switch (node.kind) {
    case 'notice':
      return `${node.dir}#notice#${node.id}`;
    case 'group':
      return `${node.dir}#group#${node.group}`;
    case 'batch':
      return `${node.dir}#batch#${node.batch}`;
    case 'migration':
      return `${node.dir}#${node.group}#${node.file}`;
    case 'action':
      return `${node.dir}#action#${node.action}`;
    default:
      return `${node.dir}#${node.kind}`;
  }
}

function projectItem(dir: string, project: ProjectSnapshot | undefined): vscode.TreeItem {
  const item = new vscode.TreeItem(
    relativeDir(dir) || path.basename(dir),
    vscode.TreeItemCollapsibleState.Expanded,
  );
  item.iconPath = new vscode.ThemeIcon('folder');
  if (project?.state.kind !== 'ready') {
    item.description = 'mmk can’t run here';
  } else if (project.rows) {
    const pending = buildStatusModel(project.rows).pending.length;
    item.description = pending === 0 ? 'up to date' : `${pending} pending`;
  }
  item.tooltip = dir;
  return item;
}

/** The theme color of an environment's dot: blue for the default, amber or red otherwise */
function environmentColor(environment: Environment): vscode.ThemeColor {
  return new vscode.ThemeColor(
    environment.color === 'error'
      ? 'testing.iconFailed'
      : environment.color === 'warning'
        ? 'list.warningForeground'
        : 'charts.blue',
  );
}

function envItem(project: ProjectSnapshot | undefined, environment: Environment): vscode.TreeItem {
  const item = new vscode.TreeItem(environment.name);
  item.iconPath = new vscode.ThemeIcon(
    environment.readOnly ? 'lock' : 'circle-filled',
    environmentColor(environment),
  );
  const database = databaseLabel(project, environment.name);
  item.description = database;
  const source = environment.local
    ? "set by this project's mmk config and `.env`"
    : 'from the connection string in your OS keychain';
  item.tooltip = new vscode.MarkdownString(
    `**${environment.name}**${environment.readOnly ? ' (read-only)' : ''}: records come from ${database}, ${source}. Files come from your working tree. Click to switch environments.`,
  );
  item.command = { command: 'mmk.selectEnvironment', title: 'Select environment' };
  item.contextValue = 'mmk.env';
  return item;
}

function noticeItem(node: Extract<SidebarNode, { kind: 'notice' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.text);
  const icons: Record<Tone, vscode.ThemeIcon> = {
    loading: new vscode.ThemeIcon('sync~spin'),
    running: new vscode.ThemeIcon('sync~spin'),
    error: new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')),
    ok: new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed')),
    locked: new vscode.ThemeIcon('lock'),
    setup: new vscode.ThemeIcon('key', new vscode.ThemeColor('list.warningForeground')),
  };
  item.iconPath = icons[node.tone];
  if (node.detail !== undefined) {
    item.description = node.detail.split('\n')[0] ?? '';
    item.tooltip = node.detail;
  }
  if (node.command !== undefined) {
    item.command = { command: node.command, title: node.text, arguments: node.args ?? [] };
  } else if (node.tone === 'error') {
    item.command = { command: 'mmk.showOutput', title: 'Show output' };
  }
  return item;
}

function groupItem(
  group: GroupKind,
  model: StatusModel | undefined,
  environment: Environment,
): vscode.TreeItem {
  const labels: Record<GroupKind, string> = {
    pending: `Pending on ${environment.name}`,
    edited: 'Edited after it ran',
    unadopted: 'Applied before the namespace',
    applied: `Applied on ${environment.name}`,
  };
  const counts: Record<GroupKind, number> = {
    pending: model?.pending.length ?? 0,
    edited: model?.edited.length ?? 0,
    unadopted: model?.unadopted.length ?? 0,
    applied: model?.appliedCount ?? 0,
  };
  const item = new vscode.TreeItem(labels[group], vscode.TreeItemCollapsibleState.Expanded);
  item.description = String(counts[group]);
  // `.ro` keeps the write actions (menus match the exact value) off a read-only environment.
  item.contextValue =
    group === 'pending' && counts.pending > 0
      ? `mmk.group.pending${environment.readOnly ? '.ro' : ''}`
      : `mmk.group.${group}`;
  if (group === 'edited') {
    item.iconPath = new vscode.ThemeIcon(
      'warning',
      new vscode.ThemeColor('list.warningForeground'),
    );
    item.tooltip =
      "mmk's checksum for these files no longer matches the version that ran. mmk down refuses to roll them back, and nothing re-runs them: put the change in a new migration.";
  }
  if (group === 'unadopted') {
    item.tooltip =
      'These ran before this repo had a namespace. Run `mmk namespace adopt` in a terminal to move their records into it.';
  }
  return item;
}

function batchItem(
  node: Extract<SidebarNode, { kind: 'batch' }>,
  model: StatusModel | undefined,
): vscode.TreeItem {
  const group = model?.batches.find((candidate) => candidate.batch === node.batch);
  const when = group?.appliedAt ? ` · ${formatWhen(group.appliedAt)}` : '';
  const item = new vscode.TreeItem(
    `Batch ${node.batch}${when}`,
    node.latest
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.description = String(group?.rows.length ?? 0);
  if (group?.appliedAt) {
    item.tooltip = `Batch ${node.batch}, applied ${group.appliedAt.toLocaleString()}`;
  }
  return item;
}

function olderItem(model: StatusModel | undefined): vscode.TreeItem {
  const older = model?.batches.slice(RECENT_BATCHES) ?? [];
  const item = new vscode.TreeItem(
    older.length === 1 ? '1 older batch' : `${older.length} older batches`,
    vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.description = String(older.reduce((sum, group) => sum + group.rows.length, 0));
  return item;
}

function migrationItem(
  node: Extract<SidebarNode, { kind: 'migration' }>,
  project: ProjectSnapshot | undefined,
  created: Set<string>,
  environment: Environment,
): vscode.TreeItem {
  const row = project?.rows?.find((candidate) => candidate.file === node.file);
  const shown = displayName(node.file);
  const item = new vscode.TreeItem(shown.label);
  const file = project?.config ? path.join(project.config.migrationsDir, node.file) : undefined;

  if (row?.fileMissing) {
    item.description = 'no file';
    item.iconPath = new vscode.ThemeIcon('circle-slash');
  } else if (node.group === 'pending') {
    item.description = file && created.has(file) ? 'new' : shown.date ? formatDay(shown.date) : '';
    item.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.blue'));
  } else if (node.group === 'edited' || row?.checksumOk === false) {
    item.description = 'edited since it ran';
    item.iconPath = new vscode.ThemeIcon(
      'warning',
      new vscode.ThemeColor('list.warningForeground'),
    );
  } else if (node.group === 'unadopted') {
    item.description = 'needs mmk namespace adopt';
    item.iconPath = new vscode.ThemeIcon('history');
  } else {
    item.description =
      row?.duration === null || row?.duration === undefined ? '' : formatDuration(row.duration);
    item.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
  }

  item.tooltip = migrationTooltip(node.file, row, environment.name);
  if (file && !row?.fileMissing) {
    item.resourceUri = vscode.Uri.file(file);
    item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(file)] };
  }
  const applied = row?.status === 'applied' && !row.unadopted;
  item.contextValue = `mmk.migration.${applied ? 'applied' : row?.unadopted ? 'unadopted' : 'pending'}${row?.fileMissing ? '.nofile' : ''}${environment.readOnly ? '.ro' : ''}`;
  return item;
}

function migrationTooltip(
  file: string,
  row: WireStatusRow | undefined,
  environment: string,
): vscode.MarkdownString {
  const lines = [`**${file}**`, ''];
  if (row?.description) {
    lines.push(row.description, '');
  }
  if (row?.status === 'applied') {
    const when = row.appliedAt ? new Date(row.appliedAt).toLocaleString() : 'unknown time';
    lines.push(`Applied on ${environment} in batch ${row.batch ?? '?'}, ${when}`);
    if (row.checksumOk === false) {
      lines.push('', '$(warning) Edited after it ran: mmk down will refuse to roll it back.');
    }
  } else {
    lines.push(`Pending on ${environment}`);
  }
  if (row?.author) {
    lines.push('', `Author: ${row.author}`);
  }
  if (row?.fileMissing) {
    lines.push('', 'Its file is not in the migrations folder (deleted, or from another repo).');
  }
  const markdown = new vscode.MarkdownString(lines.join('  \n'), true);
  return markdown;
}

function actionItem(
  node: Extract<SidebarNode, { kind: 'action' }>,
  model: StatusModel | undefined,
  environment: Environment,
): vscode.TreeItem {
  if (node.action === 'upAll') {
    const count = model?.pending.length ?? 0;
    const item = new vscode.TreeItem(`Apply all ${count} on ${environment.name}`);
    item.iconPath = new vscode.ThemeIcon('run-all');
    item.command = { command: 'mmk.upAll', title: 'Apply all', arguments: [{ dir: node.dir }] };
    return item;
  }
  const item = new vscode.TreeItem(
    environment.local ? 'Dry run' : `Dry run on ${environment.name}`,
  );
  item.iconPath = new vscode.ThemeIcon('eye');
  item.command = { command: 'mmk.dryRun', title: 'Dry run', arguments: [{ dir: node.dir }] };
  return item;
}
