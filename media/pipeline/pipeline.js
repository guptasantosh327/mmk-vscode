// The environments pipeline in the mmk sidebar (design B). Draws what the extension posts; it
// never runs mmk, and builds every node with textContent, so names can't inject markup.
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let view = null;

  const KIND_ICONS = {
    applied: 'pass',
    edited: 'warning',
    'no-file': 'circle-slash',
    pending: 'circle-large-outline',
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

  function send(message) {
    vscode.postMessage(message);
  }

  function step(item) {
    const state = item.state === 'ok' ? `${item.pending} pending` : null;
    return el('li', { class: `step${item.selected ? ' selected' : ''}` }, [
      el('span', { class: 'node', 'aria-hidden': 'true' }),
      el(
        'button',
        {
          type: 'button',
          class: 'card',
          'aria-pressed': String(item.selected),
          title: item.database ? `${item.name}: ${item.database}` : item.name,
          onclick: () => send({ type: 'select', name: item.name }),
        },
        [
          el('span', { class: 'card-head' }, [
            icon(item.readOnly ? 'lock' : 'circle-filled'),
            el('span', { class: 'name', text: item.name }),
            el('span', { class: 'muted small', text: item.readOnly ? 'read-only' : 'writable' }),
            el('span', { class: 'spacer' }),
            state ? el('span', { class: 'badge', text: state }) : null,
          ]),
          item.database ? el('span', { class: 'muted small line', text: item.database }) : null,
          item.latest
            ? el('span', { class: 'muted small wrap', text: `Latest: ${item.latest}` })
            : null,
          item.note
            ? el('span', { class: `small line note ${item.tone}` }, [
                icon(
                  item.tone === 'error' ? 'error' : item.tone === 'warning' ? 'warning' : 'info',
                ),
                el('span', { text: item.note }),
              ])
            : null,
        ],
      ),
    ]);
  }

  function pendingList(project) {
    const model = project.model;
    if (model.items.length === 0) {
      const current = model.steps.find((item) => item.selected);
      const state = current ? current.state : 'loading';
      const text = {
        ok: `Nothing pending on ${model.selected}.`,
        error: `${model.selected} couldn't be read, so what's pending there isn't known.`,
        'not-set-up': `${model.selected} isn't set up for this project.`,
        loading: `Reading ${model.selected}…`,
      }[state];
      return el('p', { class: 'muted small', text });
    }
    const items = model.items.map((item) =>
      el('li', {}, [
        el(
          'button',
          {
            type: 'button',
            class: 'item',
            title: item.file,
            onclick: () => send({ type: 'pick', dir: project.dir, file: item.file }),
          },
          [
            el('span', { class: 'name', text: item.label }),
            item.description ? el('span', { class: 'muted small', text: item.description }) : null,
            item.meta ? el('span', { class: 'muted small', text: item.meta }) : null,
            el(
              'span',
              { class: 'envs' },
              item.environments.map((environment) =>
                el(
                  'span',
                  {
                    class: `env ${environment.kind}`,
                    title: `${environment.name}: ${environment.kind}`,
                  },
                  [
                    icon(KIND_ICONS[environment.kind] || 'question'),
                    el('span', { class: 'small', text: environment.name }),
                  ],
                ),
              ),
            ),
          ],
        ),
      ]),
    );
    return el('div', {}, [
      el('ul', { class: 'items' }, items),
      model.more > 0
        ? el('button', {
            type: 'button',
            class: 'link small',
            text: `and ${model.more} more in the console`,
            onclick: () => send({ type: 'console', dir: project.dir }),
          })
        : null,
    ]);
  }

  function project(entry, many) {
    const model = entry.model;
    return el('section', { class: 'project', 'aria-label': entry.title }, [
      many ? el('h2', { text: entry.title }) : null,
      el('ol', { class: 'pipeline', 'aria-label': 'Environments' }, model.steps.map(step)),
      el('h3', { text: `Pending on ${model.selected}` }),
      pendingList(entry),
      el('div', { class: 'actions' }, [
        model.pending > 0
          ? el(
              'button',
              {
                type: 'button',
                class: 'primary wide',
                onclick: () => send({ type: 'review', dir: entry.dir }),
              },
              [
                icon('eye'),
                el('span', { text: `Review ${model.pending} pending on ${model.selected}` }),
              ],
            )
          : null,
        el('div', { class: 'row' }, [
          el(
            'button',
            { type: 'button', onclick: () => send({ type: 'console', dir: entry.dir }) },
            [icon('table'), el('span', { text: 'Console' })],
          ),
          el('button', { type: 'button', onclick: () => send({ type: 'create' }) }, [
            icon('add'),
            el('span', { text: 'New migration' }),
          ]),
        ]),
      ]),
    ]);
  }

  function render() {
    app.replaceChildren();
    if (!view) {
      app.append(el('p', { class: 'muted small', text: 'Reading environments…' }));
      return;
    }
    const many = view.projects.length > 1;
    for (const entry of view.projects) {
      app.append(project(entry, many));
    }
    app.append(
      el(
        'button',
        {
          type: 'button',
          class: 'link small add',
          onclick: () => send({ type: 'addEnvironment' }),
        },
        [icon('add'), el('span', { text: 'Add environment…' })],
      ),
    );
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
