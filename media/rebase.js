/* Interactive rebase editor: reorder commits and choose an action for each. */
/* global vscode, h, icon, button, fmtDate */
'use strict';

const ACTIONS = [
  { id: 'pick', key: 'p', title: 'Use the commit' },
  { id: 'reword', key: 'r', title: 'Use the commit with a new message' },
  { id: 'edit', key: 'e', title: 'Stop at the commit to amend it' },
  { id: 'squash', key: 's', title: 'Meld into the previous commit and combine the messages' },
  { id: 'fixup', key: 'f', title: 'Meld into the previous commit and keep its message' },
  { id: 'drop', key: 'd', title: 'Remove the commit' }
];

const S = { entries: [], commits: new Map(), selected: 0, info: null };

function render() {
  const app = document.getElementById('app');
  app.textContent = '';
  const i = S.info;
  const tb = h('div', { class: 'toolbar' },
    button('expand', 'Move Up (Alt+Up)', () => move(-1), { disabled: S.selected <= 0 }),
    button('collapse', 'Move Down (Alt+Down)', () => move(1), { disabled: S.selected >= S.entries.length - 1 }),
    h('div', { class: 'vsep' }),
    ...ACTIONS.map(a => h('button', { class: 'tbtn txt act-' + a.id, title: `${a.title} (${a.key.toUpperCase()})`, text: a.id, onClick: () => setAction(a.id) })),
    h('span', { class: 'spacer' }),
    h('span', { class: 'dim', text: `${i.repoName}: ${i.branch || 'HEAD'} onto ${i.base} \u2014 oldest commit first` }));
  const list = h('div', { class: 'rb-list', tabindex: '0' });
  S.entries.forEach((e, idx) => {
    const c = S.commits.get(e.hash);
    const sel = h('select', { class: 'rb-action act-' + e.action, title: 'Action' }, ACTIONS.map(a => {
      const o = h('option', { value: a.id, text: a.id });
      if (a.id === e.action) o.selected = true;
      return o;
    }));
    sel.addEventListener('change', () => { S.selected = idx; setAction(sel.value); });
    const subject = e.action === 'reword'
      ? h('textarea', { class: 'rb-msg', rows: String(Math.min(6, Math.max(2, (e.message || c.message).split('\n').length))) })
      : h('span', { class: 'rb-subject', title: c.message, text: c.subject });
    if (e.action === 'reword') {
      subject.value = e.message ?? c.message;
      subject.addEventListener('input', () => { e.message = subject.value; });
      subject.addEventListener('keydown', (ev) => ev.stopPropagation());
    }
    const row = h('div', { class: 'rb-row' + (idx === S.selected ? ' selected' : '') + (e.action === 'drop' ? ' dropped' : ''), draggable: 'true' },
      h('span', { class: 'grip', title: 'Drag to reorder', text: '\u2261' }), sel,
      h('span', { class: 'hash', text: c.hash.slice(0, 8) }), subject,
      h('span', { class: 'dim', text: c.author }), h('span', { class: 'dim', text: fmtDate(c.at) }));
    row.addEventListener('mousedown', (ev) => {
      if (ev.target.tagName === 'SELECT' || ev.target.tagName === 'TEXTAREA') return;
      S.selected = idx;
      for (const r of list.querySelectorAll('.rb-row')) r.classList.remove('selected');
      row.classList.add('selected');
    });
    row.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/plain', String(idx)); });
    row.addEventListener('dragover', (ev) => { ev.preventDefault(); row.classList.add('over'); });
    row.addEventListener('dragleave', () => row.classList.remove('over'));
    row.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const from = Number(ev.dataTransfer.getData('text/plain'));
      const [it] = S.entries.splice(from, 1);
      S.entries.splice(idx, 0, it);
      S.selected = idx;
      render();
    });
    list.append(row);
  });
  list.addEventListener('keydown', onKey);
  const footer = h('div', { class: 'rb-footer' },
    h('span', { class: 'dim', text: 'Keys: P R E S F D set the action, Alt+Up/Down moves the selected commit.' }),
    h('span', { class: 'spacer' }),
    h('button', { class: 'secondary', text: 'Cancel', onClick: () => vscode.postMessage({ type: 'cancel' }) }),
    h('button', { class: 'primary', text: 'Start Rebasing', onClick: () => vscode.postMessage({ type: 'start', entries: S.entries }) }));
  app.append(h('div', { class: 'rb-root' }, tb, list, footer));
  list.focus();
}

function move(dir) {
  const j = S.selected + dir;
  if (S.selected < 0 || j < 0 || j >= S.entries.length) return;
  const [it] = S.entries.splice(S.selected, 1);
  S.entries.splice(j, 0, it);
  S.selected = j;
  render();
}

function setAction(a) {
  const e = S.entries[S.selected];
  if (!e) return;
  e.action = a;
  render();
}

function onKey(ev) {
  if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
    ev.preventDefault();
    return move(ev.key === 'ArrowUp' ? -1 : 1);
  }
  if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
    ev.preventDefault();
    S.selected = Math.max(0, Math.min(S.entries.length - 1, S.selected + (ev.key === 'ArrowUp' ? -1 : 1)));
    return render();
  }
  const a = ACTIONS.find(x => x.key === ev.key.toLowerCase());
  if (a && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); setAction(a.id); }
}

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type !== 'init') return;
  S.info = m;
  S.commits = new Map(m.commits.map(c => [c.hash, c]));
  S.entries = m.commits.map(c => ({ hash: c.hash, action: 'pick' }));
  S.selected = 0;
  render();
});

vscode.postMessage({ type: 'ready' });
