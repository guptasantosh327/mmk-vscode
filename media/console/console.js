// The migration console (design C1–C4). Draws what the extension posts; it never runs mmk, and
// builds every node with textContent, so file names and descriptions can't inject markup.
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let view = null;

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

  function header() {
    const model = view.model;
    const actions = [
      button('New migration', 'add', () => send({ type: 'create' })),
      button(
        model.pending > 0
          ? `Plan ${model.pending} pending on ${view.selected}`
          : `Nothing pending on ${view.selected}`,
        'eye',
        () => send({ type: 'plan' }),
        {
          class: model.pending > 0 ? 'primary' : null,
          disabled: model.pending > 0 ? null : 'disabled',
        },
      ),
      !model.readOnly && model.pending > 0
        ? button(`Apply all ${model.pending}`, 'run-all', () => send({ type: 'applyAll' }))
        : null,
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
          class: 'tab',
          'aria-selected': String(tab.selected),
          title: column ? column.title : tab.name,
          onclick: () => send({ type: 'environment', name: tab.name }),
        },
        [
          icon(tab.readOnly ? 'lock' : 'circle-filled'),
          el('span', { text: tab.name }),
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

  function notice() {
    const item = view.model.notice;
    if (!item) return null;
    return el('div', { class: `notice ${item.kind}`, role: 'status' }, [
      icon(item.kind === 'edited' ? 'warning' : 'lock'),
      el('span', { text: item.text }),
      item.file
        ? el('button', {
            type: 'button',
            class: 'link',
            text: 'Review it',
            onclick: () => send({ type: 'pick', file: item.file }),
          })
        : null,
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
          [el('span', { text: column.name }), column.readOnly ? icon('lock') : null],
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
                },
              ),
            ),
          )
        : null,
      el('p', { class: 'muted small', text: item.note }),
      view.cli
        ? el('div', { class: 'cli' }, [
            el('code', { text: view.cli }),
            el(
              'button',
              {
                type: 'button',
                class: 'icon-button',
                title: 'Copy CLI command',
                'aria-label': 'Copy CLI command',
                onclick: () => send({ type: 'copy' }),
              },
              [icon('copy')],
            ),
          ])
        : null,
    ]);
  }

  function history() {
    const model = view.model;
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
    app.append(header(), tabs(), chips());
    const message = notice();
    if (message) app.append(message);
    if (view.error) {
      app.append(
        el('p', { class: 'error', role: 'alert' }, [
          icon('error'),
          el('span', { text: view.error }),
        ]),
      );
    }
    app.append(el('div', { class: 'main' }, [table(), detail()]), history());
    if (focused) {
      const picked = app.querySelector('tr.picked .pick');
      if (picked) picked.focus();
    }
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'model') {
      view = event.data.view;
      render();
    }
  });

  render();
  send({ type: 'ready' });
})();
