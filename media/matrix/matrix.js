// The environments matrix (design C2). Draws what the extension posts; it never runs mmk and
// builds every node with textContent, so file names can't inject markup.
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  let filter = saved.filter === 'diff' ? 'diff' : 'all';
  let view = null;

  const ICONS = {
    applied: 'check',
    edited: 'warning',
    'no-file': 'circle-slash',
    pending: 'circle-outline',
    unadopted: 'history',
    none: 'dash',
    unknown: 'question',
  };

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === 'text') node.textContent = value;
      else if (key === 'onclick') node.addEventListener('click', value);
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

  function render() {
    app.replaceChildren();
    if (!view) {
      app.append(el('p', { class: 'muted', text: 'Reading environments…' }));
      return;
    }
    const header = el('header', {}, [
      el('div', { class: 'titles' }, [
        el('h1', { text: view.title }),
        el('p', { class: 'muted', text: view.subtitle }),
      ]),
      el('div', { class: 'actions' }, [
        el('div', { class: 'segmented', role: 'group', 'aria-label': 'Compare files from' }, [
          el('span', { class: 'muted', text: 'Compare files from:' }),
          button(
            'your branch',
            null,
            () => vscode.postMessage({ type: 'source', value: 'branch' }),
            {
              'aria-pressed': String(view.source === 'branch'),
            },
          ),
          button(
            view.refLabel || 'origin/main',
            null,
            () => vscode.postMessage({ type: 'source', value: 'ref' }),
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
          () => vscode.postMessage({ type: 'refresh' }),
        ),
      ]),
    ]);
    app.append(header);

    if (view.error) {
      app.append(
        el('p', { class: 'error', role: 'alert' }, [
          icon('error'),
          el('span', { text: view.error }),
        ]),
      );
    }

    if (view.summary.length > 0) {
      app.append(
        el(
          'ul',
          { class: 'chips', 'aria-label': 'Summary' },
          view.summary.map((chip) => el('li', { text: chip })),
        ),
      );
    }

    const differing = view.rows.filter((row) => row.differs).length;
    app.append(
      el('div', { class: 'segmented filter', role: 'group', 'aria-label': 'Filter' }, [
        button(`All files · ${view.rows.length}`, null, () => setFilter('all'), {
          'aria-pressed': String(filter === 'all'),
        }),
        button(`Only differences · ${differing}`, null, () => setFilter('diff'), {
          'aria-pressed': String(filter === 'diff'),
        }),
      ]),
    );

    const rows = filter === 'diff' ? view.rows.filter((row) => row.differs) : view.rows;
    const head = el('tr', {}, [
      el('th', { scope: 'col', text: 'File' }),
      ...view.columns.map((column) =>
        el('th', { scope: 'col', title: column.title }, [
          el(
            'button',
            {
              type: 'button',
              class: 'column',
              title: `${column.title}. Click to select ${column.name}.`,
              onclick: () => vscode.postMessage({ type: 'select', environment: column.name }),
            },
            [
              el('span', { text: column.name.toUpperCase() }),
              column.readOnly ? icon('lock') : null,
              column.state === 'error' ? icon('error') : null,
              column.state === 'not-set-up' ? icon('key') : null,
            ],
          ),
        ]),
      ),
      el('th', { scope: 'col', text: 'Note' }),
    ]);
    const body = rows.map((row) =>
      el('tr', { class: row.differs ? 'differs' : '' }, [
        el('td', { class: 'file', title: row.file }, [
          row.openable
            ? el('a', {
                href: '#',
                text: row.label,
                onclick: (event) => {
                  event.preventDefault();
                  vscode.postMessage({ type: 'open', file: row.file });
                },
              })
            : el('span', { text: row.label }),
          el('span', { class: 'stamp muted', text: row.stamp }),
        ]),
        ...row.cells.map((cell) =>
          el('td', { class: `cell ${cell.kind}`, title: cell.title }, [
            icon(ICONS[cell.kind] || 'question'),
            el('span', { text: cell.label }),
            cell.date ? el('span', { class: 'muted date', text: cell.date }) : null,
          ]),
        ),
        el('td', { class: 'note', text: row.note }),
      ]),
    );
    const table = el('table', {}, [el('thead', {}, [head]), el('tbody', {}, body)]);
    app.append(
      rows.length > 0
        ? el('div', { class: 'scroll' }, [table])
        : el('p', {
            class: 'muted',
            text:
              filter === 'diff'
                ? 'Every environment agrees on every file.'
                : 'No migrations found.',
          }),
    );
    app.append(el('footer', { class: 'muted', text: view.footer }));
  }

  function setFilter(value) {
    filter = value;
    vscode.setState({ filter });
    render();
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'model') {
      view = event.data.view;
      render();
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
