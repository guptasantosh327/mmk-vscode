// The migration console (design C1–C4). Draws what the extension posts; it never runs mmk, and
// builds every node with textContent, so file names and descriptions can't inject markup.
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const dialogRoot = document.getElementById('dialog');
  let view = null;
  // The lock's details (design A2), open under the environment line
  let lockOpen = false;

  const ICONS = {
    applied: 'pass',
    edited: 'warning',
    'no-file': 'circle-slash',
    pending: 'circle-large-outline',
    unadopted: 'history',
    none: 'dash',
    unknown: 'question',
  };
  const ACTION_ICONS = {
    up: 'play',
    dryRun: 'eye',
    down: 'debug-step-back',
    redo: 'debug-restart',
    showAppliedVersion: 'diff',
  };

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === 'text') node.textContent = value;
      else if (key === 'onclick') node.addEventListener('click', value);
      else if (key === 'onkeydown') node.addEventListener('keydown', value);
      else if (value !== undefined && value !== null && value !== false)
        node.setAttribute(key, value);
    }
    for (const child of children || []) {
      if (child) node.append(child);
    }
    return node;
  }

  function icon(name) {
    return el('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' });
  }

  function button(label, iconName, onclick, attrs) {
    return el('button', { type: 'button', onclick, ...(attrs || {}) }, [
      iconName ? icon(iconName) : null,
      el('span', { text: label }),
    ]);
  }

  function send(message) {
    vscode.postMessage(message);
  }

  /** An environment's colour, from its tab */
  function hueOf(name) {
    const tab = view.model.tabs.find((candidate) => candidate.name === name);
    return tab ? tab.hue : 'blue';
  }

  /** The selected environment could be read: its counts and batches mean something */
  function readable() {
    const tab = view.model.tabs.find((candidate) => candidate.selected);
    return Boolean(tab && tab.state === 'ok');
  }

  function header() {
    const model = view.model;
    const known = readable();
    const label = !known
      ? `Plan on ${view.selected}`
      : model.pending > 0
        ? `Plan ${model.pending} pending on ${view.selected}`
        : `Nothing pending on ${view.selected}`;
    const actions = [
      button('New migration', 'add', () => send({ type: 'create' })),
      button(label, 'eye', () => send({ type: 'plan' }), {
        class: known && model.pending > 0 ? 'primary' : null,
        disabled: known && model.pending > 0 ? null : 'disabled',
      }),
    ];
    return el('header', { class: 'top' }, [
      el('div', { class: 'titles' }, [
        el('h1', { text: view.title }),
        el('p', { class: 'muted', text: view.subtitle }),
      ]),
      el('div', { class: 'actions' }, actions),
    ]);
  }

  function tabs() {
    const items = view.model.tabs.map((tab) => {
      const column = view.columns.find((candidate) => candidate.name === tab.name);
      return el(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: `tab hue-${tab.hue}`,
          'aria-selected': String(tab.selected),
          title: column ? column.title : tab.name,
          onclick: () => send({ type: 'environment', name: tab.name }),
        },
        [
          el('span', { class: 'env-icon' }, [icon(tab.readOnly ? 'lock' : 'circle-filled')]),
          el('span', { text: tab.name }),
          tab.lock ? el('span', { class: 'tab-busy', title: tab.lock }) : null,
          tab.state === 'error' ? icon('error') : null,
          tab.state === 'not-set-up' ? icon('key') : null,
          tab.state === 'ok'
            ? el('span', { class: 'badge', text: `${tab.pending} pending` })
            : null,
        ],
      );
    });
    return el('div', { class: 'tabs-row' }, [
      el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Environment' }, [
        ...items,
        el(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            title: 'Add environment…',
            'aria-label': 'Add environment',
            onclick: () => send({ type: 'addEnvironment' }),
          },
          [icon('add')],
        ),
      ]),
      el('div', { class: 'actions' }, [
        el('div', { class: 'segmented', role: 'group', 'aria-label': 'Files from' }, [
          el('span', { class: 'muted', text: 'Files:' }),
          button('your branch', null, () => send({ type: 'source', value: 'branch' }), {
            'aria-pressed': String(view.source === 'branch'),
          }),
          button(
            view.refLabel || 'origin/main',
            null,
            () => send({ type: 'source', value: 'ref' }),
            {
              'aria-pressed': String(view.source === 'ref'),
              disabled: view.refLabel ? null : 'disabled',
              title: view.refLabel ? null : 'No origin/main (or origin/HEAD) in this clone',
            },
          ),
        ]),
        button(
          view.loading ? 'Reading…' : 'Refresh',
          view.loading ? 'sync codicon-modifier-spin' : 'refresh',
          () => send({ type: 'refresh' }),
        ),
      ]),
    ]);
  }

  function chips() {
    return el(
      'div',
      { class: 'chips', role: 'group', 'aria-label': 'Show' },
      view.model.chips.map((chip) =>
        button(
          `${chip.label} ${chip.count}`,
          null,
          () => send({ type: 'filter', value: chip.id }),
          {
            class: 'chip',
            'aria-pressed': String(chip.active),
          },
        ),
      ),
    );
  }

  const NOTICE_ICONS = {
    edited: 'warning',
    unreadable: 'error',
    'not-set-up': 'key',
  };

  // The line under the tabs (design A): the selected environment, and another run's lock on it
  function environmentLine() {
    const line = view.model.environment;
    const lock = line.lock;
    if (!lock) lockOpen = false;
    const facts = [line.readOnly ? 'read-only · deploys go through CI' : 'writable', line.database]
      .filter(Boolean)
      .join(' · ');
    const right = lock
      ? [
          el(
            'button',
            {
              type: 'button',
              class: 'lock-pill',
              'aria-expanded': String(lockOpen),
              title: [lock.summary, lock.expires].filter(Boolean).join('. '),
              onclick: (event) => {
                event.stopPropagation();
                lockOpen = !lockOpen;
                render();
              },
            },
            [
              icon('watch'),
              el('span', { text: `Locked by ${lock.who}` }),
              el('span', { class: 'muted', text: `· ${lock.age}` }),
            ],
          ),
          line.canRelease
            ? el('button', {
                type: 'button',
                class: 'link',
                text: 'Release…',
                onclick: () => send({ type: 'unlock' }),
              })
            : null,
        ]
      : [el('span', { class: 'muted', text: line.lastRun })];
    return el('div', { class: 'env-line' }, [
      el('span', { class: 'env-name', text: line.name }),
      el('span', { class: 'muted', text: facts }),
      el('span', { class: 'spacer' }),
      ...right,
      lock && lockOpen ? lockPopover(line, lock) : null,
    ]);
  }

  function lockPopover(line, lock) {
    const facts = [
      ['Held by', lock.who],
      ['Process', lock.process],
      ['Since', `${lock.since}, ${lock.age === 'just now' ? 'just now' : `${lock.age} ago`}`],
      lock.frees ? ['Frees itself', `by ${lock.frees}, if that run crashed`] : null,
    ].filter(Boolean);
    return el(
      'div',
      {
        class: 'lock-popover',
        role: 'dialog',
        'aria-label': `Another run is migrating ${line.name}`,
        onclick: (event) => event.stopPropagation(),
      },
      [
        el('div', { class: 'lock-popover-title' }, [
          el('span', { class: 'drawer-icon warning' }, [icon('watch')]),
          el('h2', { text: `Another run is migrating ${line.name}` }),
        ]),
        el(
          'dl',
          { class: 'facts' },
          facts.flatMap(([term, value]) => [el('dt', { text: term }), el('dd', { text: value })]),
        ),
        el('p', {
          class: 'muted small',
          text: line.readOnly
            ? `mmk takes turns: one run per database. ${line.name} is read-only, so nothing here would run anyway.`
            : `mmk takes turns: one run per database. Run up here fails with LOCK_ALREADY_HELD until it lets go. Plan still works; it doesn't take the lock.`,
        }),
        el('div', { class: 'buttons' }, [
          line.canRelease
            ? button('Release the lock…', 'unlock', () => send({ type: 'unlock' }))
            : null,
          button('Check again', 'refresh', () => send({ type: 'refresh' })),
          el('span', { class: 'spacer' }),
          el('button', {
            type: 'button',
            class: 'link',
            text: 'Copy npx mmk lock',
            onclick: () => send({ type: 'copy', what: 'lock' }),
          }),
        ]),
      ],
    );
  }

  function notices() {
    return view.model.notices.map((item) => {
      const actions = {
        review: () => button('Review it', null, () => send({ type: 'pick', file: item.file })),
        dismiss: () =>
          button('Dismiss', null, () => send({ type: 'dismissNotice' }), {
            class: 'quiet',
            title: 'Hide this until the migration runs again',
          }),
        retry: () => button('Try again', 'refresh', () => send({ type: 'refresh' })),
        editEnvironment: () =>
          button(`Edit ${view.selected}'s connection…`, 'key', () =>
            send({ type: 'editEnvironment' }),
          ),
        showOutput: () => button('Show output', 'output', () => send({ type: 'showOutput' })),
      };
      return el('div', { class: `notice ${item.kind}`, role: 'status' }, [
        el('div', { class: 'notice-line' }, [
          icon(NOTICE_ICONS[item.kind] || 'info'),
          el('span', { text: item.text }),
        ]),
        item.detail ? el('pre', { class: 'mmk-message', text: item.detail }) : null,
        item.actions.length > 0
          ? el(
              'div',
              { class: 'buttons' },
              item.actions.map((action) => (actions[action] ? actions[action]() : null)),
            )
          : null,
      ]);
    });
  }

  // The panel over the console: a run in progress (C7), a plan (C6) or a result (C8)
  // A run in progress can't be closed; anything else closes with Close, Escape or the backdrop
  function busy() {
    return Boolean(view.run && view.run.state === 'running');
  }

  function drawer() {
    const run = view.run;
    const item = view.drawer;
    let body;
    if (item && item.kind === 'result') {
      body = resultDrawer(item.result);
    } else if (busy() || (item && item.kind === 'applying')) {
      body = runDrawer(run, item ? item.environment : '');
    } else if (item && item.kind === 'plan') {
      body = planDrawer(item);
    } else if (run) {
      body = runDrawer(run, run.environment);
    } else {
      return null;
    }
    return el('div', { class: 'overlay' }, [
      el('div', {
        class: 'backdrop',
        onclick: () => (busy() ? null : send({ type: 'closeDrawer' })),
      }),
      body,
    ]);
  }

  function drawerHead(iconName, tone, title, subtitle, closable) {
    return el('div', { class: 'drawer-head' }, [
      el('span', { class: `drawer-icon ${tone}` }, [icon(iconName)]),
      el('div', { class: 'titles' }, [
        el('h2', { text: title }),
        el('p', { class: 'muted small', text: subtitle }),
      ]),
      closable
        ? el(
            'button',
            {
              type: 'button',
              class: 'icon-button',
              'aria-label': 'Close',
              title: 'Close',
              onclick: () => send({ type: 'closeDrawer' }),
            },
            [icon('close')],
          )
        : null,
    ]);
  }

  // A command mmk runs (C7): live while it runs, then kept with how it ended until closed
  function runDrawer(run, fallbackEnvironment) {
    const label = run ? run.label : 'up';
    const environment = run ? run.environment : fallbackEnvironment;
    const lines = run ? run.lines : [];
    const state = run ? run.state : 'running';
    const head =
      state === 'running'
        ? drawerHead(
            'sync codicon-modifier-spin',
            'info',
            `Running ${label} on ${environment}`,
            'mmk holds the lock until it ends',
            false,
          )
        : state === 'done'
          ? drawerHead(
              'pass',
              'ok',
              `Finished ${label} on ${environment}`,
              'mmk ran it without an error',
              true,
            )
          : drawerHead(
              'error',
              'failed',
              `${label} failed on ${environment}`,
              "mmk's error is below, as it wrote it",
              true,
            );
    const footer =
      state === 'running'
        ? null
        : el('div', { class: 'drawer-foot' }, [
            state === 'failed'
              ? button('Show output', 'output', () => send({ type: 'showOutput' }))
              : null,
            button('Close', null, () => send({ type: 'closeDrawer' }), { class: 'primary' }),
          ]);
    return el(
      'aside',
      { class: 'drawer', role: 'dialog', 'aria-label': `${label} on ${environment}` },
      [
        head,
        el('div', { class: 'drawer-body' }, [
          run?.message ? el('pre', { class: 'mmk-message', text: run.message }) : null,
          el('h3', { text: state === 'running' ? "mmk's output, as it comes" : "mmk's output" }),
          el('pre', {
            class: 'output',
            text:
              lines.length > 0
                ? lines.join('\n')
                : state === 'running'
                  ? 'Starting…'
                  : 'mmk wrote nothing else.',
          }),
          state === 'running'
            ? el('p', {
                class: 'muted small',
                text: "There's no Stop: halting a migration midway could leave data half-changed. You can close this tab; the run carries on.",
              })
            : null,
        ]),
        footer,
      ],
    );
  }

  function planDrawer(plan) {
    const steps = plan.steps;
    const footer = [];
    if (!plan.readOnly && steps.length > 0 && !plan.loading) {
      footer.push(
        button(
          `Apply ${steps.length} on ${plan.environment}`,
          'play',
          () => send({ type: 'applyPlan' }),
          {
            class: 'primary',
            disabled: plan.locked ? 'disabled' : null,
            title: plan.locked || null,
          },
        ),
      );
    }
    footer.push(
      button(plan.readOnly || steps.length === 0 ? 'Close' : 'Cancel', null, () =>
        send({ type: 'closeDrawer' }),
      ),
    );
    return el(
      'aside',
      { class: 'drawer', role: 'dialog', 'aria-label': `Plan for ${plan.environment}` },
      [
        drawerHead(
          'eye',
          'info',
          `Plan: run up on ${plan.environment}`,
          `Nothing has run. This is mmk dry-run up for ${plan.environment}.`,
          true,
        ),
        el('div', { class: 'drawer-body' }, [
          el('dl', { class: 'facts' }, [
            el('dt', { text: 'Target' }),
            el('dd', {
              text: `${plan.environment} · ${plan.readOnly ? 'read-only' : 'writable'} · ${plan.database}`,
            }),
            el('dt', { text: 'Files' }),
            el('dd', { text: plan.files }),
          ]),
          plan.loading ? el('p', { class: 'muted', text: 'Asking mmk…' }) : null,
          plan.error ? el('pre', { class: 'mmk-message', text: plan.error }) : null,
          !plan.loading && !plan.error
            ? steps.length > 0
              ? el('div', {}, [
                  el('h3', { text: 'Runs in this order, as one new batch' }),
                  el(
                    'ol',
                    { class: 'steps' },
                    steps.map((step, index) =>
                      el('li', {}, [
                        el('span', { class: 'step-number', text: String(index + 1) }),
                        el('span', { class: 'step-text' }, [
                          el('span', { text: step.label }),
                          el('span', {
                            class: 'muted small',
                            text: [step.description, step.author].filter(Boolean).join(' · '),
                          }),
                        ]),
                        el('code', { class: 'tag', text: 'up()' }),
                      ]),
                    ),
                  ),
                  el('p', {
                    class: 'muted small',
                    text: 'If one fails, mmk stops there: the ones before it stay applied, the rest stay pending, and the result says which.',
                  }),
                ])
              : el('p', { text: `Nothing to apply: ${plan.environment} is up to date.` })
            : null,
          plan.readOnly
            ? el('p', {
                class: 'muted small',
                text: `${plan.environment} is read-only, so this ends at the command. Deploys go through CI.`,
              })
            : null,
          plan.locked
            ? el('p', {
                class: 'muted small',
                text: `${plan.locked}: Apply works once it lets go. The plan stays the same.`,
              })
            : null,
          plan.cli ? cliLine(plan.cli, 'plan') : null,
        ]),
        el('div', { class: 'drawer-foot' }, footer),
      ],
    );
  }

  const LINE_ICONS = { done: 'pass', failed: 'error', 'not-run': 'circle-large-outline' };

  function resultDrawer(result) {
    const buttons = {
      open: () =>
        button('Open the file', 'go-to-file', () => send({ type: 'open', file: result.openFile }), {
          class: 'primary',
        }),
      rollBack: () =>
        button(`Roll back batch ${result.rollBackBatch}…`, 'discard', () =>
          send({ type: 'rollBack', batch: result.rollBackBatch }),
        ),
      unlock: () =>
        button('Release the lock…', 'unlock', () => send({ type: 'unlock' }), { class: 'primary' }),
      showOutput: () => button('Show output', 'output', () => send({ type: 'showOutput' })),
      close: () => button('Close', null, () => send({ type: 'closeDrawer' }), { class: 'primary' }),
    };
    return el('aside', { class: 'drawer', role: 'dialog', 'aria-label': result.title }, [
      drawerHead(
        result.ok ? 'pass' : 'error',
        result.ok ? 'ok' : 'failed',
        result.title,
        result.subtitle,
        true,
      ),
      el('div', { class: 'drawer-body' }, [
        el(
          'ul',
          { class: 'result-lines' },
          result.lines.map((line) =>
            el('li', { class: line.state }, [
              icon(LINE_ICONS[line.state] || 'circle-large-outline'),
              el('span', { class: 'step-text' }, [
                el('span', { text: line.label }),
                el('span', { class: 'muted small', text: line.text }),
              ]),
              el('span', { class: 'muted small', text: line.duration }),
            ]),
          ),
        ),
        result.failure
          ? el('pre', {
              class: 'mmk-message',
              text: result.failure.code
                ? `${result.failure.code}\n${result.failure.message}`
                : result.failure.message,
            })
          : null,
        result.standing
          ? el('div', { class: 'standing' }, [
              el('h3', { text: `Where ${result.environment} stands now` }),
              el('p', { text: result.standing }),
            ])
          : null,
      ]),
      el(
        'div',
        { class: 'drawer-foot' },
        result.actions.map((action) => (buttons[action] ? buttons[action]() : null)),
      ),
    ]);
  }

  function cliLine(text, what) {
    return el('div', { class: 'cli' }, [
      el('code', { text }),
      el(
        'button',
        {
          type: 'button',
          class: 'icon-button',
          title: 'Copy CLI command',
          'aria-label': 'Copy CLI command',
          onclick: () => send(what ? { type: 'copy', what } : { type: 'copy' }),
        },
        [icon('copy')],
      ),
    ]);
  }

  function table() {
    const model = view.model;
    const diff = view.filter === 'diff';
    const head = el('tr', {}, [
      el('th', { scope: 'col', text: 'Migration' }),
      ...view.columns.map((column) =>
        el(
          'th',
          {
            scope: 'col',
            class: column.name === view.selected ? 'current' : '',
            title: column.title,
          },
          [
            el('span', { text: column.name }),
            el('span', { class: `env-icon hue-${hueOf(column.name)}` }, [
              icon(column.readOnly ? 'lock' : 'circle-filled'),
            ]),
          ],
        ),
      ),
      el('th', { scope: 'col', text: diff ? 'Note' : `Last run on ${view.selected}` }),
    ]);
    const body = model.rows.map((row, index) =>
      el(
        'tr',
        {
          class: row.picked ? 'picked' : '',
          onclick: () => send({ type: 'pick', file: row.file }),
        },
        [
          el('td', { class: 'name' }, [
            el(
              'button',
              {
                type: 'button',
                class: 'pick',
                'aria-pressed': String(row.picked),
                title: row.file,
                onkeydown: (event) => move(event, index),
              },
              [
                el('span', { class: row.inFiles ? 'label' : 'label missing', text: row.label }),
                el('span', { class: 'muted small', text: row.description || row.stamp }),
              ],
            ),
          ]),
          ...row.cells.map((cell) =>
            el('td', { class: `cell ${cell.kind}` }, [
              cell.kind === 'none' ? null : icon(ICONS[cell.kind] || 'question'),
              el('span', { text: cell.text }),
            ]),
          ),
          el('td', { class: diff ? 'note' : 'muted', text: diff ? row.note : row.last }),
        ],
      ),
    );
    if (model.rows.length === 0) {
      return el('p', {
        class: 'muted empty',
        text: diff ? 'Every environment agrees on every migration.' : 'No migrations to show.',
      });
    }
    return el('div', { class: 'table' }, [
      el('table', {}, [el('thead', {}, [head]), el('tbody', {}, body)]),
    ]);
  }

  // Up and down move the pick, so the table works without a mouse
  function move(event, index) {
    const rows = view.model.rows;
    const next =
      event.key === 'ArrowDown'
        ? rows[index + 1]
        : event.key === 'ArrowUp'
          ? rows[index - 1]
          : null;
    if (next) {
      event.preventDefault();
      send({ type: 'pick', file: next.file });
    }
  }

  function detail() {
    const item = view.model.detail;
    if (!item) {
      return el('aside', { class: 'detail' }, [
        el('p', { class: 'muted', text: 'Pick a migration.' }),
      ]);
    }
    return el('aside', { class: 'detail', 'aria-label': item.label }, [
      el('h2', { text: item.label }),
      el('p', {
        class: 'mono muted small',
        text: item.inFiles ? item.file : `${item.file} (no file)`,
      }),
      item.description ? el('p', { text: item.description }) : null,
      el('p', { class: 'muted small byline' }, [
        el('span', { text: item.author ? `Written by ${item.author}` : '' }),
        item.inFiles && view.source === 'branch'
          ? el('button', {
              type: 'button',
              class: 'link',
              text: 'Open file',
              onclick: () => send({ type: 'open', file: item.file }),
            })
          : null,
      ]),
      el('h3', { text: 'On each environment' }),
      el(
        'ul',
        { class: 'records' },
        item.records.map((record) =>
          el('li', { class: record.selected ? 'current' : '' }, [
            el('span', { class: 'env', text: record.environment }),
            el('span', { class: `cell ${record.kind}` }, [
              icon(ICONS[record.kind] || 'question'),
              el('span', { text: record.text }),
            ]),
            el('span', { class: 'muted small extra', text: record.extra }),
          ]),
        ),
      ),
      el('h3', { text: `On ${view.selected}` }),
      item.buttons.length > 0
        ? el(
            'div',
            { class: 'buttons' },
            item.buttons.map((entry) =>
              button(
                entry.label,
                ACTION_ICONS[entry.action],
                () => send({ type: 'action', action: entry.action }),
                {
                  class: entry.primary ? 'primary' : null,
                  disabled: entry.disabled ? 'disabled' : null,
                  title: entry.disabled || null,
                },
              ),
            ),
          )
        : null,
      el('p', { class: 'muted small', text: item.note }),
      view.cli ? cliLine(view.cli) : null,
    ]);
  }

  function history() {
    const model = view.model;
    if (!readable()) return null;
    const items = model.batches.map((batch) =>
      el('li', { class: batch.picked ? 'batch picked' : 'batch' }, [
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('span', { class: 'title', text: batch.title }),
        el('span', { class: 'muted small', text: batch.meta }),
      ]),
    );
    items.push(
      el('li', { class: 'batch next' }, [
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('span', { class: 'title', text: model.pending > 0 ? 'Next run' : 'Up to date' }),
        el('span', {
          class: 'muted small',
          text:
            model.pending > 0
              ? `${model.pending} pending, run together as one batch`
              : 'Nothing pending',
        }),
      ]),
    );
    return el('section', { class: 'history', 'aria-label': `History on ${view.selected}` }, [
      el('h3', { text: `History on ${view.selected}` }),
      el('ol', {}, items),
    ]);
  }

  function render() {
    // Keep keyboard focus on the picked row across redraws
    const focused = document.activeElement?.classList.contains('pick');
    app.replaceChildren();
    if (!view) {
      app.append(el('p', { class: 'muted', text: 'Reading environments…' }));
      return;
    }
    app.append(header(), tabs(), environmentLine(), chips(), ...notices());
    if (view.error) {
      app.append(
        el('p', { class: 'error', role: 'alert' }, [
          icon('error'),
          el('span', { text: view.error }),
        ]),
      );
    }
    app.append(el('div', { class: 'main' }, [table(), detail()]));
    const batches = history();
    if (batches) app.append(batches);
    const panel = drawer();
    if (panel) {
      app.append(panel);
      document.body.classList.add('drawer-open');
    } else {
      document.body.classList.remove('drawer-open');
    }
    if (focused) {
      const picked = app.querySelector('tr.picked .pick');
      if (picked) picked.focus();
    }
    renderDialog();
  }

  // ── Add environment (C13) ────────────────────────────────────────────────────────────────
  // The form lives outside #app, so the redraws that follow every read never lose what the user
  // typed. Its values stay here: the connection string goes to the extension only to test or
  // save it, and is never stored in the webview's state.
  const HUES = ['green', 'blue', 'purple', 'yellow', 'orange', 'red'];
  let form = null;
  let parts = null;

  function emptyForm() {
    return { name: '', dbName: '', uri: '', readOnly: true, color: null, showUri: false };
  }

  function field(label, input, errorKey, hint) {
    const error = el('span', { class: 'field-error', role: 'alert' });
    parts.errors[errorKey] = error;
    return el('label', { class: 'field' }, [
      el('span', { class: 'field-label', text: label }),
      input,
      hint ? el('span', { class: 'muted small', text: hint }) : null,
      error,
    ]);
  }

  function textInput(key, attrs) {
    const input = el('input', { type: 'text', spellcheck: 'false', ...attrs });
    input.value = form[key];
    input.addEventListener('input', () => {
      form[key] = input.value;
      if (key === 'name') updateAddLabel();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !view?.dialog?.saving) save(false);
    });
    return input;
  }

  function buildDialog() {
    form = form || emptyForm();
    parts = { errors: {} };
    const name = textInput('name', { placeholder: 'qa', 'aria-label': 'Name' });
    const database = textInput('dbName', { placeholder: 'orders_qa', 'aria-label': 'Database' });
    const uri = textInput('uri', {
      type: form.showUri ? 'text' : 'password',
      placeholder: 'mongodb+srv://user:password@cluster0.example.net',
      'aria-label': 'Connection string',
      autocomplete: 'off',
    });
    const eye = el(
      'button',
      {
        type: 'button',
        class: 'icon-button',
        'aria-label': 'Show the connection string',
        onclick: () => {
          form.showUri = !form.showUri;
          uri.type = form.showUri ? 'text' : 'password';
          eye.replaceChildren(icon(form.showUri ? 'eye-closed' : 'eye'));
        },
      },
      [icon('eye')],
    );
    const switchButton = el('button', {
      type: 'button',
      class: 'switch',
      role: 'switch',
      'aria-checked': String(form.readOnly),
      'aria-label': 'Read-only',
    });
    const readOnlyText = el('span', { class: 'muted small' });
    const updateReadOnly = () => {
      switchButton.setAttribute('aria-checked', String(form.readOnly));
      const who = form.name.trim() || 'it';
      readOnlyText.textContent = form.readOnly
        ? `Only status, list and dry-run run on ${who}. Turn it off only for a database you're happy to change from here.`
        : `Runs are allowed on ${who}: up, down and redo, each after a confirmation.`;
    };
    switchButton.addEventListener('click', () => {
      form.readOnly = !form.readOnly;
      updateReadOnly();
    });
    name.addEventListener('input', updateReadOnly);
    updateReadOnly();
    const swatches = [null, ...HUES].map((hue) =>
      el(
        'button',
        {
          type: 'button',
          class: hue ? `swatch hue-${hue}` : 'swatch auto',
          'aria-pressed': String(form.color === hue),
          title: hue ? hue : 'The default for its name: prod is red, the others take a free colour',
          onclick: () => {
            form.color = hue;
            for (const [index, swatch] of swatches.entries()) {
              swatch.setAttribute('aria-pressed', String([null, ...HUES][index] === hue));
            }
          },
        },
        [hue ? el('span', { class: 'dot' }) : el('span', { text: 'Automatic' })],
      ),
    );
    parts.test = el('div', { class: 'test-line' });
    parts.add = button('Add environment', null, () => save(false), { class: 'primary' });
    parts.cancel = button('Cancel', null, () => send({ type: 'closeDialog' }));
    const box = el('div', { class: 'dialog', role: 'dialog', 'aria-label': 'Add environment' }, [
      el('div', { class: 'dialog-head' }, [
        el('h2', { text: 'Add environment' }),
        el(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-label': 'Close',
            onclick: () => send({ type: 'closeDialog' }),
          },
          [icon('close')],
        ),
      ]),
      el('div', { class: 'dialog-body' }, [
        el('div', { class: 'two' }, [
          field('Name', name, 'name'),
          field('Database', database, 'dbName'),
        ]),
        field(
          'Connection string',
          el('span', { class: 'secret' }, [uri, eye]),
          'uri',
          'Kept in your OS keychain and passed to mmk as MMK_URI. Never written to settings, logs or the command line.',
        ),
        el('div', { class: 'toggle-row' }, [
          switchButton,
          el('div', { class: 'toggle-text' }, [el('span', { text: 'Read-only' }), readOnlyText]),
        ]),
        el('div', { class: 'field' }, [
          el('span', { class: 'field-label', text: 'Colour' }),
          el('div', { class: 'swatches', role: 'group', 'aria-label': 'Colour' }, swatches),
        ]),
        parts.test,
      ]),
      el('div', { class: 'dialog-foot' }, [parts.cancel, parts.add]),
    ]);
    dialogRoot.replaceChildren(
      el('div', { class: 'overlay dialog-overlay' }, [
        el('div', { class: 'backdrop', onclick: () => send({ type: 'closeDialog' }) }),
        box,
      ]),
    );
    updateAddLabel();
    name.focus();
  }

  function updateAddLabel() {
    if (!parts) return;
    const label = parts.add.querySelector('span');
    if (label) label.textContent = form.name.trim() ? `Add ${form.name.trim()}` : 'Add environment';
  }

  function save(force) {
    send({
      type: 'saveEnvironment',
      name: form.name,
      uri: form.uri,
      dbName: form.dbName,
      readOnly: form.readOnly,
      color: form.color,
      force,
    });
  }

  function renderDialog() {
    const dialog = view?.dialog;
    if (!dialog) {
      if (dialogRoot.firstChild) {
        dialogRoot.replaceChildren();
        form = null;
        parts = null;
      }
      return;
    }
    if (!parts) buildDialog();
    for (const key of ['name', 'uri', 'dbName']) {
      parts.errors[key].textContent = dialog.errors[key] || '';
    }
    const test = dialog.test;
    const testButton = button(
      test.state === 'idle' ? 'Test connection' : 'Test again',
      null,
      () => send({ type: 'testEnvironment', name: form.name, uri: form.uri, dbName: form.dbName }),
      { class: 'link', disabled: test.state === 'testing' || dialog.saving ? 'disabled' : null },
    );
    const line =
      test.state === 'idle'
        ? [el('span', { class: 'muted', text: 'Add tests the connection with mmk status first.' })]
        : test.state === 'testing'
          ? [icon('sync codicon-modifier-spin'), el('span', { text: test.text })]
          : test.state === 'ok'
            ? [icon('pass'), el('span', { text: test.text })]
            : [icon('error'), el('pre', { class: 'mmk-message', text: test.text })];
    parts.test.className = `test-line ${test.state}`;
    parts.test.replaceChildren(
      ...[
        ...line,
        el('span', { class: 'spacer' }),
        dialog.canForce && !dialog.saving
          ? button('Add anyway', null, () => save(true), { class: 'link' })
          : null,
        testButton,
      ].filter(Boolean),
    );
    parts.add.toggleAttribute('disabled', dialog.saving);
    parts.cancel.toggleAttribute('disabled', dialog.saving);
  }

  // Escape closes the lock's details, the dialog, then a plan, a result or a finished run (never
  // a run in progress)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !view) return;
    if (lockOpen) {
      lockOpen = false;
      render();
    } else if (view.dialog) {
      if (!view.dialog.saving) send({ type: 'closeDialog' });
    } else if ((view.drawer || view.run) && !busy()) {
      send({ type: 'closeDrawer' });
    }
  });

  // A click anywhere else closes the lock's details
  document.addEventListener('click', () => {
    if (lockOpen) {
      lockOpen = false;
      render();
    }
  });

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'model') {
      view = event.data.view;
      render();
    }
  });

  render();
  send({ type: 'ready' });
})();
