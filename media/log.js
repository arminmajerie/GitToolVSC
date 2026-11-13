/* Git log webview: branches tree, commit list with graph, commit details. */
/* global vscode, h, icon, button, fmtDate, statusClass, statusTitle, baseName, dirName, treeNodes, allDirKeys, renderTree, makeSplitter, computeGraph, computeRepositoryGraph, drawGraphRow, graphMetrics, ROW_H */
'use strict';

const S = {
  mode: 'main',
  part: 'all',
  repo: '',
  repoName: '',
  filter: {},
  branches: null,
  commits: [],
  graph: [],
  showGraph: true,
  head: '',
  me: '',
  hasMore: false,
  highlight: [],
  selected: [],
  anchor: -1,
  selectedBranch: null,
  branchSearch: '',
  details: null,
  containing: null,
  error: '',
  multiRepo: false,
  stats: new Map(),
  ui: {
    showBranches: true,
    showDetails: true,
    groupBranches: true,
    groupFiles: true,
    wBranches: 280,
    wDetails: 380,
    hMessage: 160
  },
  collapsedBranches: new Set(['tags']),
  collapsedFiles: new Set()
};

const el = {};
let openMenu;

function closeMenu() {
  if (!openMenu) return;
  openMenu.anchor.setAttribute('aria-expanded', 'false');
  openMenu.node.remove();
  openMenu = undefined;
}

document.addEventListener('mousedown', e => {
  if (openMenu && !openMenu.node.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

function showMenu(what, anchor) {
  if (openMenu?.what === what) { closeMenu(); return; }
  closeMenu();
  const node = h('div', { class: 'log-menu', role: 'menu', 'aria-label': what });
  const bounds = anchor.getBoundingClientRect();
  node.style.left = Math.max(4, Math.min(bounds.left, window.innerWidth - 300)) + 'px';
  node.style.top = Math.min(bounds.bottom + 3, window.innerHeight - 120) + 'px';
  node.style.maxHeight = Math.max(100, window.innerHeight - bounds.bottom - 12) + 'px';
  document.body.append(node);
  node.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const entries = [...node.querySelectorAll('button, input')].filter(n => !n.hidden && !n.closest('[hidden]'));
    const index = entries.indexOf(document.activeElement);
    entries[(index + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]?.focus();
    e.preventDefault();
  });
  openMenu = { what, node, anchor };
  anchor.setAttribute('aria-expanded', 'true');
  const send = message => { closeMenu(); vscode.postMessage(message); };
  const entry = (label, message, role, checked) => node.append(h('button', {
    class: 'menu-entry', role: role || 'menuitem', 'aria-checked': String(!!checked),
    onClick: () => send(message)
  }, h('span', { class: 'menu-check', text: checked ? '✓' : '' }), h('span', { text: label })));
  const heading = label => node.append(h('div', { class: 'menu-heading', text: label }));
  if (what === 'options') {
    heading('Sort');
    entry('By Commit Date', { type: 'setLogOptions', order: 'date' }, 'menuitemradio', S.filter.order !== 'topo');
    entry('Topologically', { type: 'setLogOptions', order: 'topo' }, 'menuitemradio', S.filter.order === 'topo');
    heading('Options');
    entry('First Parent', { type: 'setLogOptions', firstParent: !S.filter.firstParent }, 'menuitemcheckbox', S.filter.firstParent);
    entry('No Merges', { type: 'setLogOptions', noMerges: !S.filter.noMerges }, 'menuitemcheckbox', S.filter.noMerges);
    heading('Graph');
    entry('Compact repository histories', { type: 'setLogOptions', graphLayout: 'compact' }, 'menuitemradio', S.filter.graphLayout !== 'lanes');
    entry('All repository lanes', { type: 'setLogOptions', graphLayout: 'lanes' }, 'menuitemradio', S.filter.graphLayout === 'lanes');
    heading('Persistent history cache');
    entry('Rebuild selected histories', { type: 'rebuildHistory' });
  } else if (what === 'branch') {
    const search = h('input', { type: 'search', placeholder: 'Find branch or tag', 'aria-label': 'Find branch or tag' });
    node.append(search);
    entry('All branches', { type: 'clear', what: 'branch' });
    entry('HEAD (current branch)', { type: 'branchFilter', ref: 'HEAD' });
    for (const [key, title] of [['local', 'Local'], ['remote', 'Remote'], ['tags', 'Tags']]) {
      heading(title);
      for (const ref of S.branches?.[key] || []) entry(ref.name, { type: 'branchFilter', ref: ref.name }, 'menuitemradio', S.filter.branch === ref.name);
    }
    search.addEventListener('input', () => {
      for (const item of node.querySelectorAll('.menu-entry')) item.hidden = !item.textContent.toLowerCase().includes(search.value.toLowerCase());
    });
    search.focus();
  } else if (what === 'date') {
    for (const [label, since] of [['All dates', ''], ['Last 24 hours', '24 hours ago'], ['Last 7 days', '7 days ago'], ['Last 30 days', '30 days ago'], ['Last year', '1 year ago']]) entry(label, { type: 'setDate', since, label: since ? label : '' });
    heading('Custom range');
    const since = h('input', { type: 'date', 'aria-label': 'Since' });
    const until = h('input', { type: 'date', 'aria-label': 'Until' });
    node.append(h('label', { text: 'Since ' }, since), h('label', { text: 'Until ' }, until),
      h('button', { class: 'menu-apply', text: 'Apply', onClick: () => send({ type: 'setDate', since: since.value, until: until.value, label: `${since.value || '…'} – ${until.value || '…'}` }) }));
  } else if (what === 'user') {
    entry('All users', { type: 'clear', what: 'user' });
    heading('Authors in loaded history');
    const users = new Map(S.commits.map(c => [c.ae, c.an]));
    for (const [email, name] of users) entry(`${name} <${email}>`, { type: 'setAuthors', authors: [{ label: name, pattern: email.replace(/[.[\\*^$]/g, '\\$&') }] });
  } else {
    node.append(h('div', { class: 'menu-heading', text: 'Loading repositories…' }));
    vscode.postMessage({ type: 'menu', what });
  }
}

function renderRepositoryMenu(message) {
  if (!openMenu || openMenu.what !== message.what) return;
  const { node, what } = openMenu;
  node.textContent = '';
  const items = message.items;
  const search = h('input', { type: 'search', placeholder: 'Find repository', 'aria-label': 'Find repository' });
  node.append(search);
  const checks = [];
  const all = h('input', { type: 'checkbox', checked: items.every(i => i.checked), 'aria-label': 'All repositories' });
  const sync = () => { all.checked = checks.every(c => c.input.checked); all.indeterminate = !all.checked && checks.some(c => c.input.checked); };
  node.append(h('label', { class: 'menu-root' }, all, 'All repositories'));
  const list = h('div', { class: 'menu-roots' });
  for (const item of items) {
    const input = h('input', { type: 'checkbox', checked: item.checked, 'aria-label': item.label });
    const label = h('label', { class: 'menu-root', title: item.description }, input, item.label);
    input.addEventListener('change', sync);
    checks.push({ input, label, value: item.value });
    list.append(label);
  }
  all.addEventListener('change', () => { for (const c of checks) c.input.checked = all.checked; sync(); });
  search.addEventListener('input', () => { for (const c of checks) c.label.hidden = !c.label.textContent.toLowerCase().includes(search.value.toLowerCase()); });
  node.append(list, h('button', { class: 'menu-apply', text: 'Apply', onClick: () => {
    const repositories = checks.filter(c => c.input.checked).map(c => c.value);
    closeMenu(); vscode.postMessage({ type: 'setRepositories', repositories });
  } }));
  sync(); search.focus();
}

function saveUi() {
  vscode.postMessage({ type: 'saveUi', opts: S.ui });
}

// ---------------- layout ----------------

function build() {
  const app = document.getElementById('app');
  app.textContent = '';
  el.branchesPane = h('div', { class: 'branches-pane' });
  el.branchesStrip = h('div', { class: 'branches-strip' }, button('right', 'Show Git Branches', () => toggleBranches(true)));
  el.split1 = h('div', { class: 'splitter' });
  el.filterbar = h('div', { class: 'filterbar' });
  el.commits = h('div', { class: 'commits', tabindex: '0' });
  el.header = buildHeader();
  el.center = h('div', { class: 'center' }, el.filterbar, el.commits);
  el.split2 = h('div', { class: 'splitter' });
  el.detailsPane = h('div', { class: 'details-pane' });
  app.append(h('div', { class: 'log-root' }, el.branchesStrip, el.branchesPane, el.split1, el.center, el.split2, el.detailsPane));
  makeSplitter(el.split1, el.branchesPane, 1, (w) => { S.ui.wBranches = w; saveUi(); });
  makeSplitter(el.split2, el.detailsPane, -1, (w) => { S.ui.wDetails = w; saveUi(); });
  el.commits.addEventListener('keydown', onCommitKey);
  applyLayout();
}

function applyLayout() {
  if (S.part !== 'all') {
    // Each part is its own VS Code view; VS Code handles hiding and resizing.
    for (const k of ['branchesStrip', 'split1', 'split2']) el[k].style.display = 'none';
    el.branchesPane.style.display = S.part === 'branches' ? '' : 'none';
    el.center.style.display = S.part === 'commits' ? '' : 'none';
    el.detailsPane.style.display = S.part === 'details' ? '' : 'none';
    el.branchesPane.classList.add('fill');
    el.detailsPane.classList.add('fill');
    return;
  }
  const showB = S.ui.showBranches && S.mode === 'main';
  el.branchesPane.style.display = showB ? '' : 'none';
  el.split1.style.display = showB ? '' : 'none';
  el.branchesStrip.style.display = !showB && S.mode === 'main' ? '' : 'none';
  el.branchesPane.style.width = S.ui.wBranches + 'px';
  el.detailsPane.style.display = S.ui.showDetails ? '' : 'none';
  el.split2.style.display = S.ui.showDetails ? '' : 'none';
  el.detailsPane.style.width = S.ui.wDetails + 'px';
}

function toggleBranches(v) {
  S.ui.showBranches = v;
  saveUi();
  applyLayout();
}

// ---------------- filter bar ----------------

let textTimer;

function renderFilterbar() {
  closeMenu();
  const f = S.filter;
  const bar = el.filterbar;
  const old = bar.querySelector('input.search');
  const hadFocus = old && document.activeElement === old;
  const typed = old ? old.value : undefined;
  const caret = old ? old.selectionStart : 0;
  bar.textContent = '';
  const input = h('input', { class: 'search', type: 'text', placeholder: 'Text or hash', value: hadFocus ? typed : (f.text || '') });
  const send = () => vscode.postMessage({ type: 'text', text: input.value, regex: !!f.regex, matchCase: !!f.matchCase });
  input.addEventListener('input', () => { clearTimeout(textTimer); textTimer = setTimeout(send, 600); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(textTimer); send(); } });
  const regex = h('button', { class: 'tbtn txt' + (f.regex ? ' active' : ''), title: 'Regex', text: '.*', onClick: () => { f.regex = !f.regex; send(); } });
  const mcase = h('button', { class: 'tbtn txt' + (f.matchCase ? ' active' : ''), title: 'Match case', text: 'Cc', onClick: () => { f.matchCase = !f.matchCase; send(); } });
  bar.append(h('div', { class: 'searchbox' }, icon('search'), input, regex, mcase));
  if (hadFocus) { input.focus(); input.setSelectionRange(caret, caret); }

  const chip = (what, label, value) => {
    const c = h('button', { type: 'button', class: 'chip' + (value ? ' set' : ''), 'aria-label': value ? `${label}: ${value}` : label, 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: value ? `${label}: ${value}` : `Filter by ${label.toLowerCase()}` },
      h('span', { class: 'chip-label', text: value ? `${label}: ${value}` : label }));
    c.addEventListener('click', () => showMenu(what, c));
    if (value) {
      const x = h('span', { class: 'chip-x', title: 'Clear' }, icon('close'));
      x.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'clear', what }); });
      c.append(x);
    } else c.append(icon('chevronDown', 'chev'));
    return c;
  };
  if (S.mode === 'main') bar.append(chip('branch', 'Branch', f.branch));
  bar.append(chip('user', 'User', f.user), chip('date', 'Date', f.date));
  if (S.mode === 'main') bar.append(chip('paths', 'Paths', f.paths));
  else bar.append(h('span', { class: 'chip set', title: f.paths, text: `Path: ${f.paths}` }));
  const opt = chip('options', 'Options', '');
  opt.classList.toggle('set', !!f.options);
  opt.title = 'Log options: topological order, first parent only, hide merges';
  bar.append(opt);
  bar.append(h('span', { class: 'spacer' }));
  const repoBtn = h('button', { class: 'tbtn repo', 'aria-haspopup': 'menu', title: 'Filter repositories', onClick: () => showMenu('repositories', repoBtn) },
    icon('repo'), h('span', { text: S.repoName || 'Select repository' }));
  bar.append(repoBtn);
  bar.append(button('refresh', 'Refresh', () => vscode.postMessage({ type: 'refresh' })));
  el.cherry = button('cherry', 'Cherry-Pick selected commits', () => {
    if (S.selected.length) vscode.postMessage({ type: 'commitAction', action: 'cherryPick', hashes: orderedSelection() });
  }, { disabled: !S.selected.length });
  bar.append(el.cherry);
  if (S.part === 'all') bar.append(button('eye', 'Show Details', () => { S.ui.showDetails = !S.ui.showDetails; saveUi(); applyLayout(); }, { active: S.ui.showDetails }));
}

// ---------------- branches ----------------

function branchTree(list, kind, prefix) {
  const fav = list.filter(b => b.favorite);
  const rest = list.filter(b => !b.favorite);
  const items = [];
  const search = S.branchSearch.toLowerCase();
  const match = (b) => !search || b.name.toLowerCase().includes(search);
  for (const b of fav.filter(match)) items.push({ branch: b, kind, label: kind === 'remote' && prefix ? b.name.slice(prefix.length + 1) : b.name });
  const group = S.ui.groupBranches && !search;
  if (!group) {
    for (const b of rest.filter(match)) items.push({ branch: b, kind, label: kind === 'remote' && prefix ? b.name.slice(prefix.length + 1) : b.name });
    return items;
  }
  const root = { dirs: new Map(), leaves: [] };
  for (const b of rest) {
    const name = kind === 'remote' && prefix ? b.name.slice(prefix.length + 1) : b.name;
    const parts = name.split('/');
    const leaf = parts.pop();
    let n = root;
    for (const p of parts) {
      if (!n.dirs.has(p)) n.dirs.set(p, { dirs: new Map(), leaves: [] });
      n = n.dirs.get(p);
    }
    n.leaves.push({ branch: b, kind, label: leaf });
  }
  const conv = (n, key) => {
    const out = [];
    for (const [name, d] of [...n.dirs].sort((a, b) => a[0].localeCompare(b[0]))) out.push({ folder: name, key: key + '/' + name, children: conv(d, key + '/' + name) });
    out.push(...n.leaves);
    return out;
  };
  return items.concat(conv(root, kind + ':' + (prefix || '')));
}

function branchRow(item, depth) {
  const b = item.branch;
  const isCur = item.kind === 'local' && S.branches.current === b.name;
  const ic = isCur ? icon('current', 'ic-current') : b.favorite ? icon('star', 'ic-star') : item.kind === 'tag' ? icon('tag', 'ic-tag') : icon('branch', 'ic-branch');
  const track = b.track ? b.track.replace(/\[|\]/g, '').replace(/ahead (\d+)/, '\u2191$1').replace(/behind (\d+)/, '\u2193$1').replace(/,\s*/, ' ') : '';
  const sel = S.selectedBranch && S.selectedBranch.kind === item.kind && S.selectedBranch.name === b.name;
  const row = h('div', {
    class: 'tree-row branch' + (sel ? ' selected' : '') + (isCur ? ' current' : ''),
    title: b.name + (b.upstream ? `\nTracking ${b.upstream} ${b.track || ''}` : ''),
    ctx: { webviewSection: 'branch', repo: S.repo, refName: b.name, branchKind: item.kind, isCurrent: isCur, hasUpstream: !!b.upstream }
  },
  h('span', { class: 'twisty' }), ic, h('span', { class: 'name', text: item.label }), track ? h('span', { class: 'dim', text: track }) : null);
  row.style.paddingLeft = depth * 14 + 4 + 'px';
  row.addEventListener('click', () => {
    S.selectedBranch = { kind: item.kind, name: b.name, hash: b.hash };
    renderBranches();
    vscode.postMessage({ type: 'branchFilter', ref: b.name });
  });
  row.addEventListener('contextmenu', () => { S.selectedBranch = { kind: item.kind, name: b.name, hash: b.hash }; renderBranches(); });
  return row;
}

function renderBranchItems(container, items, depth) {
  for (const it of items) {
    if (it.folder !== undefined) {
      const collapsed = S.collapsedBranches.has(it.key);
      const row = h('div', { class: 'tree-row dir' }, h('span', { class: 'twisty' }, icon(collapsed ? 'chevronRight' : 'chevronDown')), icon('folder', 'ic-folder'), h('span', { class: 'name', text: it.folder }));
      row.style.paddingLeft = depth * 14 + 4 + 'px';
      row.addEventListener('click', () => { toggleCollapsed(it.key); });
      container.append(row);
      if (!collapsed) renderBranchItems(container, it.children, depth + 1);
    } else container.append(branchRow(it, depth));
  }
}

function toggleCollapsed(key) {
  if (S.collapsedBranches.has(key)) S.collapsedBranches.delete(key);
  else S.collapsedBranches.add(key);
  renderBranches();
}

function section(container, key, label, depth, fill) {
  const collapsed = S.collapsedBranches.has(key) && !S.branchSearch;
  const row = h('div', { class: 'tree-row section' }, h('span', { class: 'twisty' }, icon(collapsed ? 'chevronRight' : 'chevronDown')), h('span', { class: 'name', text: label }));
  row.style.paddingLeft = depth * 14 + 4 + 'px';
  row.addEventListener('click', () => toggleCollapsed(key));
  container.append(row);
  if (!collapsed) fill();
}

function renderBranches() {
  if (S.mode !== 'main' || (S.part !== 'branches' && S.part !== 'all')) return;
  const pane = el.branchesPane;
  const scroll = el.branchList ? el.branchList.scrollTop : 0;
  pane.textContent = '';
  const sel = S.selectedBranch;
  const selKind = sel ? sel.kind : null;
  const tb = h('div', { class: 'vtoolbar' },
    S.part === 'all' ? button('left', 'Hide Git Branches', () => toggleBranches(false)) : null,
    button('plus', sel ? `New Branch from '${sel.name}'...` : 'New Branch...', () => vscode.postMessage({ type: 'branchAction', action: 'new', name: sel ? sel.name : '' })),
    button('update', 'Update Selected', () => sel && vscode.postMessage({ type: 'branchAction', action: 'update', kind: sel.kind, name: sel.name }), { disabled: !sel || selKind === 'tag' }),
    button('trash', 'Delete Branch', () => sel && vscode.postMessage({ type: 'branchAction', action: 'delete', kind: sel.kind, name: sel.name }), { disabled: !sel || (selKind === 'local' && sel.name === S.branches.current) }),
    button('compare', 'Compare with Current', () => sel && vscode.postMessage({ type: 'branchAction', action: 'compare', kind: sel.kind, name: sel.name }), { disabled: !sel }),
    button('fetch', 'Fetch', () => vscode.postMessage({ type: 'branchAction', action: 'fetch' })),
    button('star', 'Mark/Unmark As Favorite', () => sel && vscode.postMessage({ type: 'branchAction', action: 'favorite', kind: sel.kind, name: sel.name }), { disabled: !sel }),
    button('locate', 'Navigate Log to Selected Branch Head', locateBranch),
    h('div', { class: 'sep' }),
    button('group', 'Group By Directory', () => { S.ui.groupBranches = !S.ui.groupBranches; saveUi(); renderBranches(); }, { active: S.ui.groupBranches }),
    button('expand', 'Expand All', () => { S.collapsedBranches.clear(); renderBranches(); }),
    button('collapse', 'Collapse All', collapseAllBranches)
  );
  const search = h('input', { class: 'search', type: 'text', placeholder: 'Search branches', value: S.branchSearch });
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { S.branchSearch = search.value; fillBranchList(el.branchList); el.branchList.scrollTop = 0; }, 120);
  });
  const list = h('div', { class: 'branch-list' });
  el.branchList = list;
  fillBranchList(list);
  pane.append(tb, h('div', { class: 'branches-main' }, h('div', { class: 'branch-search' }, search), list));
  list.scrollTop = scroll;
}

function fillBranchList(list) {
  list.textContent = '';
  const B = S.branches;
  if (B) {
    const head = h('div', { class: 'tree-row section head-row', title: 'Double-click to show only the current branch' }, h('span', { class: 'twisty' }), h('span', { class: 'name', text: 'HEAD (Current Branch)' }), h('span', { class: 'dim', text: B.current || 'detached' }));
    head.addEventListener('dblclick', () => vscode.postMessage({ type: 'branchFilter', ref: 'HEAD' }));
    list.append(head);
    section(list, 'local', 'Local', 0, () => renderBranchItems(list, branchTree(B.local, 'local'), 1));
    const remoteNames = [...new Set(B.remote.map(r => r.name.split('/')[0]))];
    section(list, 'remote', 'Remote', 0, () => {
      for (const rn of remoteNames) {
        section(list, 'remote:' + rn, rn, 1, () => renderBranchItems(list, branchTree(B.remote.filter(r => r.name.startsWith(rn + '/')), 'remote', rn), 2));
      }
    });
    if (B.tags.length) section(list, 'tags', `Tags (${B.tags.length})`, 0, () => renderBranchItems(list, branchTree(B.tags, 'tag'), 1));
  }
}

function collapseAllBranches() {
  S.collapsedBranches = new Set(['local', 'remote', 'tags']);
  if (S.branches) for (const r of S.branches.remote) S.collapsedBranches.add('remote:' + r.name.split('/')[0]);
  renderBranches();
}

function locateBranch() {
  const sel = S.selectedBranch;
  const hash = sel ? sel.hash : S.head;
  if (S.part === 'branches') return vscode.postMessage({ type: 'locate', hash, name: sel ? sel.name : 'HEAD' });
  reveal(hash, sel ? sel.name : '');
}

function reveal(hash, name) {
  const i = S.commits.findIndex(c => c.h === hash);
  if (i >= 0) selectIndex(i, false, false, true);
  else if (name) vscode.postMessage({ type: 'branchFilter', ref: name });
}

function orderedSelection() {
  const selected = new Set(S.selected);
  return S.commits.filter(c => selected.has(c.h)).map(c => c.h);
}

/** Moves to the first parent (dir 1) or to a child (dir -1) of the current commit. */
function navigate(dir) {
  if (S.anchor < 0) return;
  const c = S.commits[S.anchor];
  let i = -1;
  if (dir > 0 && c.p.length) i = S.commits.findIndex(x => x.h === c.p[0]);
  if (dir < 0) {
    for (let k = S.anchor - 1; k >= 0; k--) if (S.commits[k].p.includes(c.h)) { i = k; break; }
  }
  if (i >= 0) selectIndex(i, false, false, true);
}

// ---------------- commits ----------------

let remoteNames = { source: undefined, set: new Set() };
function remoteSet() {
  if (remoteNames.source !== S.branches) remoteNames = { source: S.branches, set: new Set(S.branches ? S.branches.remote.map(r => r.name) : []) };
  return remoteNames.set;
}

function refChips(c) {
  if (!c.refs) return [];
  const remotes = remoteSet();
  const parts = c.refs.split(', ').filter(Boolean);
  const locals = [];
  const remoteRefs = [];
  const tags = [];
  let head = false;
  for (let p of parts) {
    if (p === 'HEAD') { head = true; continue; }
    if (p.startsWith('HEAD -> ')) { head = true; p = p.slice(8); }
    if (p.startsWith('tag: ')) tags.push(p.slice(5));
    else if (p.endsWith('/HEAD')) continue;
    else if (remotes.has(p)) remoteRefs.push(p);
    else locals.push(p);
  }
  const chips = [];
  const usedRemote = new Set();
  for (const l of locals) {
    const r = remoteRefs.find(x => x.slice(x.indexOf('/') + 1) === l);
    const isCur = S.branches && S.branches.current === l;
    if (r) { usedRemote.add(r); chips.push(h('span', { class: 'ref local' + (isCur ? ' cur' : ''), title: `${l} and ${r}`, text: `${r.slice(0, r.indexOf('/'))} & ${l}` })); }
    else chips.push(h('span', { class: 'ref local' + (isCur ? ' cur' : ''), text: l }));
  }
  for (const r of remoteRefs) if (!usedRemote.has(r)) chips.push(h('span', { class: 'ref remote', text: r }));
  for (const t of tags) chips.push(h('span', { class: 'ref tag', text: t }));
  if (head && !locals.length) chips.unshift(h('span', { class: 'ref head', text: 'HEAD' }));
  return chips;
}

function renderCommits(keepScroll, select) {
  const box = el.commits;
  const scroll = box.scrollTop;
  box.textContent = '';
  V.start = V.end = 0;
  V.top = V.bottom = V.rows = null;
  if (S.error) box.append(h('div', { class: 'error', text: S.error }));
  if (!S.commits.length) {
    box.append(h('div', { class: 'empty', text: S.repo ? 'No commits match the filter.' : 'No repository selected.' }));
    return;
  }
  V.metrics = graphMetrics(S.graph);
  V.maxW = S.showGraph ? V.metrics.lanes : 1;
  V.top = h('div', { class: 'commit-spacer' });
  V.rows = h('div', { class: 'commit-window' });
  V.bottom = h('div', { class: 'commit-spacer' });
  box.append(el.header, V.top, V.rows, V.bottom);
  if (S.hasMore) box.append(h('div', { class: 'more' }, h('button', { class: 'link', text: 'Load more commits', onClick: () => vscode.postMessage({ type: 'loadMore' }) })));
  S.multiRepo = new Set(S.commits.map(c => c.repo || '')).size > 1;
  applyColumns();
  V.top.style.height = '0px';
  V.bottom.style.height = S.commits.length * ROW_H + 'px';
  box.scrollTop = keepScroll ? scroll : 0;
  renderWindow(true);
  if (select) {
    const i = S.commits.findIndex(c => c.h === select);
    if (i >= 0) selectIndex(i, false, false, true);
  }
}

// ---------------- columns ----------------

const COLUMNS = [
  { key: 'graph', label: 'Graph', edge: 'right', min: 24 },
  { key: 'repo', label: 'Repository', edge: 'right', min: 40 },
  { key: 'subject', label: 'Description' },
  { key: 'author', label: 'Author', edge: 'left', min: 40 },
  { key: 'date', label: 'Date', edge: 'left', min: 60 }
];

function columnWidths() {
  return Object.assign({ graph: 0, repo: 110, author: 150, date: 125 }, S.ui.cols || {});
}

function graphAutoWidth() {
  if (!S.showGraph || !V.metrics) return 18;
  return Math.min(V.metrics.pixels + 4, Math.max(60, (el.commits.clientWidth || 800) * 0.4));
}

function applyColumns() {
  const w = columnWidths();
  const target = el.center;
  target.classList.toggle('multi-repo', !!S.multiRepo);
  target.style.setProperty('--graph-w', (w.graph || graphAutoWidth()) + 'px');
  target.style.setProperty('--repo-w', (S.multiRepo ? w.repo : 0) + 'px');
  target.style.setProperty('--author-w', w.author + 'px');
  target.style.setProperty('--date-w', w.date + 'px');
}

function buildHeader() {
  const header = h('div', { class: 'commit-header' });
  for (const col of COLUMNS) {
    const cell = h('div', { class: 'col-head c-' + col.key, text: col.label });
    if (col.edge) {
      const handle = h('div', { class: 'col-resize ' + col.edge, title: 'Drag to resize · double-click to reset' });
      handle.addEventListener('mousedown', e => startColumnResize(e, col));
      handle.addEventListener('dblclick', e => {
        e.stopPropagation();
        const cols = columnWidths();
        delete cols[col.key];
        S.ui.cols = col.key === 'graph' ? { ...cols, graph: 0 } : cols;
        applyColumns(); saveUi();
      });
      cell.append(handle);
    }
    header.append(cell);
  }
  return header;
}

function startColumnResize(e, col) {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const cell = e.target.parentElement;
  const startW = cell.getBoundingClientRect().width;
  document.body.classList.add('resizing-col');
  const move = ev => {
    const delta = (ev.clientX - startX) * (col.edge === 'left' ? -1 : 1);
    S.ui.cols = { ...columnWidths(), [col.key]: Math.round(Math.max(col.min, startW + delta)) };
    applyColumns();
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing-col');
    saveUi();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

// ---------------- commit hover card ----------------

const CARD = { node: null, showTimer: 0, hideTimer: 0, index: -1, x: 0, y: 0 };

function relativeTime(seconds) {
  const diff = Date.now() / 1000 - seconds;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    const n = Math.floor(diff / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

function scheduleCard(i, x, y) {
  clearTimeout(CARD.hideTimer);
  if (CARD.node && CARD.index === i) return;
  clearTimeout(CARD.showTimer);
  CARD.x = x; CARD.y = y;
  CARD.showTimer = setTimeout(() => showCard(i), CARD.node ? 80 : 350);
}

function scheduleHideCard() {
  clearTimeout(CARD.showTimer);
  clearTimeout(CARD.hideTimer);
  CARD.hideTimer = setTimeout(hideCard, 200);
}

function hideCard() {
  clearTimeout(CARD.showTimer);
  if (CARD.node) CARD.node.remove();
  CARD.node = null;
  CARD.index = -1;
}

function showCard(i) {
  const c = S.commits[i];
  if (!c) return;
  hideCard();
  const stats = S.stats.get(c.h);
  if (stats === undefined) vscode.postMessage({ type: 'commitStats', hash: c.h });
  const copy = h('button', { class: 'card-copy', title: 'Copy full hash', text: c.h.slice(0, 8) });
  copy.addEventListener('click', e => {
    e.stopPropagation();
    if (navigator.clipboard) navigator.clipboard.writeText(c.h);
    copy.textContent = 'Copied';
  });
  const refs = refChips(c);
  const node = h('div', { class: 'commit-card', role: 'tooltip' },
    h('div', { class: 'card-head' }, h('span', { class: 'card-author', text: c.an }), h('span', { class: 'dim', text: ` <${c.ae}>` })),
    h('div', { class: 'dim', text: `${relativeTime(c.at)} (${new Date(c.at * 1000).toLocaleString()})` }),
    h('div', { class: 'card-subject', text: c.s }),
    h('div', { class: 'card-stats', text: stats || 'Counting changes\u2026' }),
    refs.length ? h('div', { class: 'card-refs' }, refs) : null,
    h('div', { class: 'card-foot' }, copy, c.repo && S.multiRepo ? h('span', { class: 'dim', text: baseName(c.repo) }) : null,
      c.p.length > 1 ? h('span', { class: 'dim', text: `merge of ${c.p.length} parents` }) : null));
  node.addEventListener('mouseenter', () => clearTimeout(CARD.hideTimer));
  node.addEventListener('mouseleave', scheduleHideCard);
  document.body.append(node);
  const r = node.getBoundingClientRect();
  node.style.left = Math.max(4, Math.min(CARD.x + 14, window.innerWidth - r.width - 8)) + 'px';
  node.style.top = (CARD.y + 16 + r.height > window.innerHeight ? Math.max(4, CARD.y - r.height - 10) : CARD.y + 16) + 'px';
  CARD.node = node;
  CARD.index = i;
}

// Only the rows near the viewport exist in the DOM; large histories stay responsive.
const V = { start: 0, end: 0, top: null, rows: null, bottom: null, metrics: null, maxW: 1 };
const OVERSCAN = 30;
let windowFrame = 0;

function scheduleWindow() {
  if (windowFrame) return;
  windowFrame = requestAnimationFrame(() => { windowFrame = 0; renderWindow(false); });
}

function renderWindow(force) {
  if (!V.rows) return;
  const box = el.commits;
  const offset = V.top.offsetTop;
  const height = box.clientHeight || 600;
  const first = Math.floor(Math.max(0, box.scrollTop - offset) / ROW_H);
  const last = Math.min(S.commits.length, first + Math.ceil(height / ROW_H) + 1);
  const margin = OVERSCAN / 2;
  const covered = (V.start === 0 || first - V.start >= margin) && (V.end === S.commits.length || V.end - last >= margin) && first >= V.start && last <= V.end;
  if (!force && covered) return;
  const start = Math.max(0, first - OVERSCAN);
  const end = Math.min(S.commits.length, last + OVERSCAN);
  const selected = new Set(S.selected);
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) frag.append(commitRow(S.commits[i], i, selected));
  V.rows.replaceChildren(frag);
  V.top.style.height = start * ROW_H + 'px';
  V.bottom.style.height = (S.commits.length - end) * ROW_H + 'px';
  V.start = start;
  V.end = end;
}

function commitRow(c, i, selected) {
  const isMine = S.me && c.ae.toLowerCase() === S.me;
  const merge = c.p.length > 1;
  const row = h('div', {
    class: 'commit-row' + (merge ? ' merge' : '') + (isMine ? ' mine' : '') + (selected.has(c.h) ? ' selected' : ''),
    'data-i': i
  });
  const g = S.showGraph ? drawGraphRow(S.graph[i], V.maxW, c.h === S.head, V.metrics.spacing) : drawGraphRow({ col: 0, color: 0, segs: [] }, 1, c.h === S.head);
  const repoLabel = c.repo ? baseName(c.repo) + ((c.repositories || []).length > 1 ? ` +${c.repositories.length - 1}` : '') : '';
  row.append(
    h('div', { class: 'c-graph' }, g),
    h('div', { class: 'c-repo', title: c.repo ? `${(c.repositories || [c.repo]).join('\n')}\nClick to show only this repository` : '', text: repoLabel }),
    h('div', { class: 'c-subject', title: c.s }, h('span', { class: 'refs' }, refChips(c)), h('span', { class: 'subject', text: c.s })),
    h('div', { class: 'c-author', title: `${c.an} <${c.ae}>`, text: c.an }),
    h('div', { class: 'c-date', title: new Date(c.at * 1000).toLocaleString(), text: fmtDate(c.at) })
  );
  return row;
}

function openCommitAt(i) {
  const c = S.commits[i];
  if (c) vscode.postMessage({ type: 'openCommit', hash: c.h });
}

let rowsBound = false;
function bindCommitEvents() {
  if (rowsBound) return;
  rowsBound = true;
  el.commits.addEventListener('scroll', () => { scheduleWindow(); hideCard(); }, { passive: true });
  new ResizeObserver(() => { scheduleWindow(); if (!columnWidths().graph) applyColumns(); }).observe(el.commits);
  el.commits.addEventListener('click', (e) => {
    const cell = e.target.closest('.c-repo');
    const row = e.target.closest('.commit-row');
    if (!cell || !row || !S.multiRepo) return;
    const c = S.commits[Number(row.dataset.i)];
    if (c && c.repo) vscode.postMessage({ type: 'focusRepository', repo: c.repo });
  });
  el.commits.addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.c-graph');
    const row = cell && cell.closest('.commit-row');
    if (row) scheduleCard(Number(row.dataset.i), e.clientX, e.clientY);
    else if (CARD.node || CARD.showTimer) scheduleHideCard();
  });
  el.commits.addEventListener('mouseleave', scheduleHideCard);
  el.commits.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.commit-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.button === 2) {
      if (!S.selected.includes(S.commits[i].h)) selectIndex(i, false, false, false);
      return;
    }
    if (e.button !== 0) return;
    selectIndex(i, e.ctrlKey || e.metaKey, e.shiftKey, false);
  });
  el.commits.addEventListener('contextmenu', (e) => {
    hideCard();
    const row = e.target.closest('.commit-row');
    if (!row) return;
    const c = S.commits[Number(row.dataset.i)];
    const hashes = orderedSelection();
    row.dataset.vscodeContext = JSON.stringify({
      preventDefaultContextMenuItems: true, webviewSection: 'commit', repo: c.repo || S.repo, hash: c.h, hashes,
      multi: hashes.length > 1, commitCount: hashes.length, isHead: hashes.length === 1 && c.h === S.head, isMerge: c.p.length > 1
    });
  });
  el.commits.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.commit-row');
    if (row) openCommitAt(Number(row.dataset.i));
  });
}

function onCommitKey(e) {
  if (e.key === 'Enter' && S.anchor >= 0) {
    e.preventDefault();
    return openCommitAt(S.anchor);
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    return navigate(e.key === 'ArrowRight' ? 1 : -1);
  }
  if (e.key === 'a' && (e.ctrlKey || e.metaKey) && S.commits.length) {
    e.preventDefault();
    S.anchor = 0;
    return selectIndex(S.commits.length - 1, false, true, false);
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const cur = S.anchor < 0 ? -1 : S.anchor;
  const next = Math.max(0, Math.min(S.commits.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)));
  selectIndex(next, false, e.shiftKey, true);
}

let detailTimer;
function selectIndex(i, toggle, range, scroll) {
  const h0 = S.commits[i].h;
  if (range && S.anchor >= 0) {
    const [a, b] = S.anchor < i ? [S.anchor, i] : [i, S.anchor];
    S.selected = S.commits.slice(a, b + 1).map(c => c.h);
  } else if (toggle) {
    S.selected = S.selected.includes(h0) ? S.selected.filter(x => x !== h0) : [...S.selected, h0];
    S.anchor = i;
  } else {
    S.selected = [h0];
    S.anchor = i;
  }
  const selected = new Set(S.selected);
  for (const r of el.commits.querySelectorAll('.commit-row')) {
    r.classList.toggle('selected', selected.has(S.commits[Number(r.dataset.i)].h));
  }
  if (scroll && V.top) {
    const box = el.commits;
    const top = V.top.offsetTop + i * ROW_H;
    const covered = el.header.offsetHeight;
    if (top - covered < box.scrollTop) box.scrollTop = top - covered;
    else if (top + ROW_H > box.scrollTop + box.clientHeight) box.scrollTop = top + ROW_H - box.clientHeight;
    renderWindow(false);
  }
  if (el.cherry) el.cherry.disabled = !S.selected.length;
  clearTimeout(detailTimer);
  const ordered = orderedSelection();
  detailTimer = setTimeout(() => vscode.postMessage({ type: 'select', hashes: ordered }), 80);
}

// ---------------- details ----------------

function renderDetails() {
  const pane = el.detailsPane;
  pane.textContent = '';
  const d = S.details;
  if (!d || d.none) {
    pane.append(h('div', { class: 'empty', text: 'Select a commit to see its changes.' }));
    return;
  }
  const nodes = treeNodes(d.files, S.ui.groupFiles, 'f:');
  const tb = h('div', { class: 'toolbar' },
    button('changes', 'Show All Changes', () => vscode.postMessage({ type: 'showAllChanges' })),
    button('group', 'Group By Directory', () => { S.ui.groupFiles = !S.ui.groupFiles; saveUi(); renderDetails(); }, { active: S.ui.groupFiles }),
    button('expand', 'Expand All', () => { S.collapsedFiles.clear(); renderDetails(); }),
    button('collapse', 'Collapse All', () => { S.collapsedFiles = new Set(allDirKeys(nodes)); renderDetails(); }),
    h('span', { class: 'spacer' }),
    h('span', { class: 'dim', text: d.compare ? `${d.left.slice(0, 8)} \u2194 ${d.right.slice(0, 8)}` : `${d.files.length} file${d.files.length === 1 ? '' : 's'}` })
  );
  const files = h('div', { class: 'files' });
  const repoRoot = h('div', { class: 'tree-row dir root' }, h('span', { class: 'twisty' }, icon('chevronDown')), icon('repo'), h('span', { class: 'name', text: d.repo ? baseName(d.repo) : S.repoName }), h('span', { class: 'dim', text: `${d.files.length} files` }));
  files.append(repoRoot);
  const hl = new Set(d.highlight || []);
  const isHl = (p) => hl.size && [...hl].some(x => p === x || p.startsWith(x + '/'));
  renderTree(files, nodes, 1, {
    collapsed: S.collapsedFiles,
    onToggle: renderDetails,
    renderFile: (f) => {
      const name = S.ui.groupFiles ? baseName(f.path) : f.path;
      const row = h('div', {
        class: 'tree-row file ' + statusClass(f.status) + (isHl(f.path) ? ' hl' : ''),
        title: `${statusTitle(f.status)}: ${f.path}${f.oldPath ? `\nfrom ${f.oldPath}` : ''}`,
        ctx: { webviewSection: 'commitFile', repo: d.repo || S.repo, left: d.left, right: d.right, path: f.path, oldPath: f.oldPath || '', status: f.status }
      }, h('span', { class: 'twisty' }), icon('file', 'ic-file'), h('span', { class: 'name', text: name }),
      f.oldPath ? h('span', { class: 'dim', text: `\u2190 ${f.oldPath}` }) : null);
      row.addEventListener('click', () => {
        for (const r of files.querySelectorAll('.tree-row.selected')) r.classList.remove('selected');
        row.classList.add('selected');
        vscode.postMessage({ type: 'openFile', file: f });
      });
      return row;
    }
  });
  const msg = h('div', { class: 'message' });
  msg.style.height = S.ui.hMessage + 'px';
  const split = h('div', { class: 'hsplitter' });
  makeSplitter(split, msg, -1, (v) => { S.ui.hMessage = v; saveUi(); }, true);
  if (d.info) {
    const i = d.info;
    msg.append(h('div', { class: 'msg-text', text: i.message }));
    const hashEl = h('a', { class: 'hash', href: '#', title: 'Copy', text: i.hash.slice(0, 10) });
    hashEl.addEventListener('click', (e) => { e.preventDefault(); navigator.clipboard && navigator.clipboard.writeText(i.hash); });
    msg.append(h('div', { class: 'meta' }, hashEl, ` ${i.an} <${i.ae}> on ${new Date(i.at * 1000).toLocaleString()}`));
    if (i.cn !== i.an || i.ct !== i.at) msg.append(h('div', { class: 'meta dim', text: `committed by ${i.cn} <${i.ce}> on ${new Date(i.ct * 1000).toLocaleString()}` }));
    if (i.parents.length) {
      const p = h('div', { class: 'meta dim' }, i.parents.length > 1 ? 'parents ' : 'parent ');
      for (const ph of i.parents) {
        const a = h('a', { href: '#', class: 'hash', text: ph.slice(0, 8) });
        a.addEventListener('click', (e) => { e.preventDefault(); if (S.part === 'details') vscode.postMessage({ type: 'locate', hash: ph }); else reveal(ph, ''); });
        p.append(a, ' ');
      }
      msg.append(p);
    }
    if (S.containing && S.containing.hash === i.hash) {
      const br = S.containing.branches;
      const shown = br.slice(0, 20).join(', ') + (br.length > 20 ? ` and ${br.length - 20} more` : '');
      msg.append(h('div', { class: 'meta dim', text: `In ${br.length} branch${br.length === 1 ? '' : 'es'}: ${shown}` }));
    } else msg.append(h('div', { class: 'meta dim', text: 'In branches: \u2026' }));
  } else if (d.compare) {
    msg.append(h('div', { class: 'meta', text: d.count > 2 || d.range ? `Combined changes of ${d.count} commits (${d.left.slice(0, 10)}..${d.right.slice(0, 10)})` : `Changes between ${d.left.slice(0, 10)} and ${d.right.slice(0, 10)}` }));
  }
  if (S.ui.showMessage !== false) {
    msg.append(h('button', { class: 'message-toggle', title: 'Hide commit details', onClick: (e) => { e.stopPropagation(); S.ui.showMessage = false; saveUi(); renderDetails(); } }, icon('collapse')));
    pane.append(tb, files, split, msg);
  } else {
    pane.append(tb, files, h('button', { class: 'message-toggle reveal', title: 'Show commit details', onClick: () => { S.ui.showMessage = true; saveUi(); renderDetails(); } }, icon('expand')));
  }
}

// ---------------- messages ----------------

window.addEventListener('message', (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'init':
      S.mode = m.mode;
      S.part = m.part || 'all';
      Object.assign(S.ui, m.opts || {});
      build();
      bindCommitEvents();
      break;
    case 'reveal':
      if (S.part === 'commits' || S.part === 'all') reveal(m.hash, m.name);
      break;
    case 'nav':
      if ((S.part === 'commits' || S.part === 'all') && S.anchor >= 0 && S.commits[S.anchor].h === m.hash) navigate(m.dir);
      break;
    case 'filter': {
      const changed = JSON.stringify(S.filter) !== JSON.stringify(m);
      S.filter = m;
      S.repo = m.repo;
      S.repoName = m.repoName;
      if (changed) renderFilterbar();
      break;
    }
    case 'menuData':
      renderRepositoryMenu(m);
      break;
    case 'loading':
      if (S.part === 'commits' || S.part === 'all') {
        let indicator = el.center.querySelector('.log-loading');
        if (!indicator) { indicator = h('div', { class: 'log-loading', role: 'status' }); el.center.insertBefore(indicator, el.commits); }
        indicator.textContent = m.text;
      }
      break;
    case 'branches':
      S.branches = m;
      S.head = m.head;
      if (S.selectedBranch) {
        const all = m[S.selectedBranch.kind === 'tag' ? 'tags' : S.selectedBranch.kind] || [];
        const b = all.find(x => x.name === S.selectedBranch.name);
        S.selectedBranch = b ? { ...S.selectedBranch, hash: b.hash } : null;
      }
      renderBranches();
      break;
    case 'log': {
      el.center.querySelector('.log-loading')?.remove();
      if (S.part !== 'commits' && S.part !== 'all') { S.head = m.head; break; }
      S.error = m.error || '';
      S.commits = m.commits;
      S.head = m.head;
      S.me = m.me;
      S.hasMore = m.hasMore;
      S.showGraph = m.graph;
      S.graph = m.graph ? (m.graphLayout === 'lanes' ? computeGraph(m.commits) : computeRepositoryGraph(m.commits)) : [];
      hideCard();
      const prev = S.selected.filter(x => m.commits.some(c => c.h === x));
      S.selected = prev;
      S.anchor = prev.length ? m.commits.findIndex(c => c.h === prev[0]) : -1;
      renderCommits(m.keepScroll || (!!prev.length && !m.select), m.select);
      if (!m.select && !prev.length && m.commits.length) selectIndex(0, false, false, false);
      else if (!m.select && prev.length) vscode.postMessage({ type: 'select', hashes: orderedSelection() });
      break;
    }
    case 'loaded':
      el.center?.querySelector('.log-loading')?.remove();
      break;
    case 'commitStats': {
      S.stats.set(m.hash, m.text);
      const shown = CARD.node && S.commits[CARD.index];
      if (shown && shown.h === m.hash) CARD.node.querySelector('.card-stats').textContent = m.text;
      break;
    }
    case 'empty':
      S.commits = [];
      if (S.part === 'commits' || S.part === 'all') renderCommits(false);
      break;
    case 'details':
      S.details = m;
      if (S.part === 'details' || S.part === 'all') renderDetails();
      break;
    case 'containing':
      S.containing = m;
      if ((S.part === 'details' || S.part === 'all') && S.details && S.details.info && S.details.info.hash === m.hash) renderDetails();
      break;
  }
});

vscode.postMessage({ type: 'ready' });
