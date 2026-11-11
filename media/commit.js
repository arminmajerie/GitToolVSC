/* Commit and Shelf webview. */
/* global vscode, h, icon, button, fmtDate, statusClass, statusTitle, baseName, dirName, treeNodes, allDirKeys, renderTree */
'use strict';

const GROUPS = [
  { id: 'conflicts', label: 'Merge Conflicts' },
  { id: 'staged', label: 'Staged' },
  { id: 'unstaged', label: 'Unstaged' },
  { id: 'untracked', label: 'Unversioned Files' }
];

const st = vscode.getState() || {};
const S = {
  tab: 'commit',
  data: null,
  selected: new Set(),
  anchor: null,
  collapsed: new Set(),
  collapsedGroups: new Set(),
  stashOpen: new Set(),
  stashFiles: {},
  message: st.message || '',
  messages: st.messages || {},
  amend: !!st.amend,
  ui: { groupByDir: true }
};

const el = {};

function persist() {
  if (S.repo) S.messages[S.repo] = S.message;
  vscode.setState({ message: S.message, messages: S.messages, amend: S.amend });
}

function key(group, path) {
  return group + '\0' + path;
}

function selectedIn(group) {
  return [...S.selected].filter(k => k.startsWith(group + '\0')).map(k => k.slice(group.length + 1));
}

function selectedPaths() {
  return [...S.selected].map(k => k.slice(k.indexOf('\0') + 1));
}

function repoData() {
  const repos = S.data && S.data.repositories;
  return (repos && repos.find(r => r.repo === S.repo)) || (repos && repos[0]) || S.data;
}

function repoMessage(type, extra = {}) {
  vscode.postMessage({ type, repo: (repoData() || {}).repo, ...extra });
}

function repoMessageFor(repo, type, extra = {}) {
  vscode.postMessage({ type, repo, ...extra });
}

function repositories() {
  return (S.data && S.data.repositories) || (S.data ? [S.data] : []);
}

function repoDepth(r, all) {
  let depth = 0;
  let parent = r.parent;
  while (parent) {
    depth++;
    parent = all.find(x => x.repo === parent)?.parent;
  }
  return depth;
}

function renderRepositoryTree() {
  const all = repositories();
  const box = h('div', { class: 'repository-tree' });
  for (const r of all) {
    const ownStaged = (r.staged || []).filter(f => !(r.childPaths || []).includes(f.path)).length;
    const ownUnstaged = (r.unstaged || []).filter(f => !(r.childPaths || []).includes(f.path)).length;
    const childDirty = (r.staged || []).length + (r.unstaged || []).length - ownStaged - ownUnstaged;
    const check = h('input', { type: 'checkbox', checked: r.checked !== false });
    check.addEventListener('click', e => e.stopPropagation());
    check.addEventListener('change', () => {
      r.checked = check.checked;
      vscode.postMessage({ type: 'setChecked', repos: all.filter(x => x.checked !== false).map(x => x.repo) });
    });
    const row = h('div', { class: 'repository-row' + (r.repo === S.repo ? ' active' : ''), title: r.repo });
    row.style.paddingLeft = 4 + repoDepth(r, all) * 16 + 'px';
    row.append(check, h('span', { class: 'repo-name', text: r.path ? r.path : r.repoName }),
      h('span', { class: 'dim', text: `${ownStaged} staged · ${ownUnstaged} unstaged${childDirty ? ` · ${childDirty} child` : ''}` }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'dim', text: r.branch || '' }),
      button('check', 'Commit repository', e => { e.stopPropagation(); repoMessageFor(r.repo, 'commit', { message: S.messages[r.repo] || S.message, amend: S.amend, push: false }); }),
      button('upload', 'Commit and push repository', e => { e.stopPropagation(); repoMessageFor(r.repo, 'commit', { message: S.messages[r.repo] || S.message, amend: S.amend, push: true }); }),
      button('upload', 'Push repository', e => { e.stopPropagation(); repoMessageFor(r.repo, 'push'); }),
      button('upload', 'Force push repository', e => { e.stopPropagation(); repoMessageFor(r.repo, 'forcePush'); }));
    row.addEventListener('click', () => { persist(); S.repo = r.repo; S.message = S.messages[S.repo] || ''; S.selected.clear(); S.anchor = null; render(); });
    box.append(row);
  }
  for (const m of (S.data && S.data.uninitialized) || []) {
    const parent = all.find(r => r.repo === m.parent);
    const row = h('div', { class: 'repository-row unavailable', title: m.url || 'Submodule is not initialized' });
    row.style.paddingLeft = 20 + (parent ? repoDepth(parent, all) * 16 : 0) + 'px';
    row.append(h('span', { class: 'repo-name', text: m.path }), h('span', { class: 'dim', text: 'not initialized' }));
    box.append(row);
  }
  return box;
}

// ---------------- layout ----------------

function build() {
  const app = document.getElementById('app');
  app.textContent = '';
  el.tabs = h('div', { class: 'tabs' });
  el.body = h('div', { class: 'tab-body' });
  app.append(h('div', { class: 'commit-root' }, el.tabs, el.body));
  render();
}

function render() {
  renderTabs();
  const scroller = el.body.querySelector('.changes');
  const scroll = scroller ? scroller.scrollTop : 0;
  el.body.textContent = '';
  if (!S.data) {
    el.body.append(h('div', { class: 'empty', text: 'Loading repositories…' }));
    return;
  }
  if (!S.data.repo) {
    el.body.append(h('div', { class: 'empty' }, 'No repository. ', h('button', { class: 'link', text: 'Select repository', onClick: () => vscode.postMessage({ type: 'selectRepo' }) })));
    return;
  }
  if (S.tab === 'commit') renderCommitTab();
  else renderShelfTab();
  const next = el.body.querySelector('.changes');
  if (next && scroll) next.scrollTop = scroll;
}

function renderTabs() {
  el.tabs.textContent = '';
  const tab = (id, label) => h('button', { class: 'tab' + (S.tab === id ? ' active' : ''), text: label, onClick: () => { S.tab = id; render(); } });
  const active = repoData();
  const count = active && active.stashes ? active.stashes.length : 0;
  el.tabs.append(tab('commit', 'Commit'), tab('shelf', count ? `Shelf (${count})` : 'Shelf'), h('span', { class: 'spacer' }));
  if (active && active.repo) {
    el.tabs.append(h('button', { class: 'tbtn repo', title: `${active.repo}\nClick to switch repository`, onClick: () => vscode.postMessage({ type: 'selectRepo' }) },
      icon('repo'), h('span', { text: active.repoName }), active.branch ? h('span', { class: 'dim', text: active.branch }) : null));
  }
}

// ---------------- commit tab ----------------

function renderCommitTab() {
  const d = repoData();
  const sel = selectedPaths();
  const hasSel = sel.length > 0;
  const tb = h('div', { class: 'toolbar' },
    button('refresh', 'Refresh', () => repoMessage('refresh')),
    button('rollback', 'Rollback selected...', () => repoMessage('rollback', { paths: selectedIn('staged').concat(selectedIn('unstaged'), selectedIn('conflicts')) }), { disabled: !hasSel }),
    button('update', 'Update Project (pull)', () => repoMessage('update')),
    button('diff', 'Show Diff', showSelectedDiff, { disabled: !hasSel }),
    button('plus', 'Stage selected', () => repoMessage('stage', { paths: selectedIn('unstaged').concat(selectedIn('untracked'), selectedIn('conflicts')) }), { disabled: !hasSel }),
    button('minus', 'Unstage selected', () => repoMessage('unstage', { paths: selectedIn('staged') }), { disabled: !selectedIn('staged').length }),
    button('shelve', 'Shelve Changes...', () => repoMessage('shelve', { paths: sel })),
    h('div', { class: 'vsep' }),
    button('group', 'Group By Directory', () => { S.ui.groupByDir = !S.ui.groupByDir; vscode.postMessage({ type: 'saveUi', opts: S.ui }); render(); }, { active: S.ui.groupByDir }),
    button('expand', 'Expand All', () => { S.collapsed.clear(); S.collapsedGroups.clear(); for (const r of repositories()) for (const g of GROUPS) S.collapsed.add('open:' + g.id + ':' + r.repo); render(); }),
    button('collapse', 'Collapse All', () => {
      for (const g of GROUPS) S.collapsedGroups.add(g.id);
      render();
    })
  );
  const tree = h('div', { class: 'changes', tabindex: '0' });
  if (d.state) tree.append(h('div', { class: 'banner', text: `${d.state} in progress. Resolve conflicts, then continue from the Git menu (Merge... / Rebase...).` }));
  let total = 0;
  for (const g of GROUPS) {
    const files = repositories().flatMap(r => r[g.id] || []);
    total += files.length;
    if (!files.length && g.id !== 'staged' && g.id !== 'unstaged') continue;
    const collapsed = S.collapsedGroups.has(g.id);
    const actions = h('span', { class: 'row-actions' });
    if (g.id === 'staged' && files.length) actions.append(button('minus', 'Unstage All', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'groupOperation', operation: 'unstage', group: g.id }); }));
    if ((g.id === 'unstaged' || g.id === 'untracked') && files.length) {
      actions.append(button('plus', 'Stage All', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'groupOperation', operation: 'stage', group: g.id }); }));
    }
    if (g.id === 'unstaged' && files.length) actions.append(button('rollback', 'Rollback All...', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'groupOperation', operation: 'rollback', group: g.id }); }));
    const header = h('div', { class: 'tree-row section group-' + g.id },
      h('span', { class: 'twisty' }, files.length ? icon(collapsed ? 'chevronRight' : 'chevronDown') : null),
      h('span', { class: 'name', text: g.label }), files.length ? h('span', { class: 'dim', text: `${files.length} file${files.length === 1 ? '' : 's'}` }) : null, h('span', { class: 'spacer' }), actions);
    header.addEventListener('click', () => { if (collapsed) S.collapsedGroups.delete(g.id); else S.collapsedGroups.add(g.id); render(); });
    tree.append(header);
    if (collapsed || !files.length) continue;
    for (const r of repositories()) {
    const own = r[g.id] || [];
    if (!own.length) continue;
    const repoKey = g.id + ':' + r.repo;
    const isCollapsed = !S.collapsed.has('open:' + repoKey);
    const checkbox = h('input', { type: 'checkbox', checked: r.checked !== false, 'aria-label': 'Include ' + r.repoName });
    checkbox.addEventListener('click', e => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      r.checked = checkbox.checked;
      vscode.postMessage({ type: 'setChecked', repos: repositories().filter(x => x.checked !== false).map(x => x.repo) });
      render();
    });
    const repoHeader = h('div', { class: 'tree-row repository-group', ctx: { webviewSection: 'change', repo: r.repo, changeGroup: g.id, paths: own.map(f => f.path) } },
      h('span', { class: 'twisty' }, icon(isCollapsed ? 'chevronRight' : 'chevronDown')), checkbox, icon('repo'),
      h('span', { class: 'name', text: r.repoName }), h('span', { class: 'dim', text: own.length + ' files' }),
      h('span', { class: 'dim branch-badge', text: r.branch || '' }), h('span', { class: 'spacer' }),
      button(g.id === 'staged' ? 'minus' : 'plus', g.id === 'staged' ? 'Unstage repository' : 'Stage repository', e => {
        e.stopPropagation(); repoMessageFor(r.repo, g.id === 'staged' ? 'unstage' : 'stage', { paths: own.map(f => f.path) });
      }));
    repoHeader.addEventListener('click', () => {
      if (isCollapsed) S.collapsed.add('open:' + repoKey); else S.collapsed.delete('open:' + repoKey);
      render();
    });
    tree.append(repoHeader);
    if (isCollapsed) continue;
    const nodes = treeNodes(own, S.ui.groupByDir, repoKey + ':');
    renderTree(tree, nodes, 2, {
      collapsed: S.collapsed,
      onToggle: render,
      dirCtx: (n) => ({ webviewSection: 'change', repo: r.repo, changeGroup: g.id, path: n.paths[0] || '', paths: n.paths }),
      renderDirActions: (n) => {
        if (g.id === 'staged') return button('minus', 'Unstage folder', (e) => { e.stopPropagation(); repoMessageFor(r.repo, 'unstage', { paths: n.paths }); });
        if (g.id === 'unstaged' || g.id === 'untracked') return button('plus', 'Stage folder', (e) => { e.stopPropagation(); repoMessageFor(r.repo, 'stage', { paths: n.paths }); });
        return null;
      },
      renderFile: (f) => fileRow(g.id, { ...f, gitlink: (r.childPaths || []).includes(f.path) }, r.repo)
    });
    }
  }
  if (!total) tree.append(h('div', { class: 'empty', text: 'No local changes.' }));

  const amend = h('input', { type: 'checkbox', id: 'amend', checked: S.amend });
  amend.addEventListener('change', () => {
    S.amend = amend.checked;
    persist();
    repoMessage('amend', { checked: S.amend, message: S.message });
    updateCommitButton();
  });
  // Reuse the textarea so re-rendering keeps its undo history, size and selection.
  let msg = el.msg;
  if (!msg) {
    msg = h('textarea', { class: 'msg', placeholder: 'Commit Message', spellcheck: 'true' });
    msg.addEventListener('input', () => { S.message = msg.value; persist(); updateCommitButton(); });
    msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(false); } });
    el.msg = msg;
  }
  if (msg.value !== S.message) msg.value = S.message;
  el.commitBtn = h('button', { class: 'primary', onClick: () => commit(false) });
  el.pushBtn = h('button', { class: 'secondary', text: 'Commit&Push', onClick: () => commit(true) });
  const push = h('button', { class: 'secondary push-icon', title: 'Push', onClick: () => vscode.postMessage({ type: 'pushChecked' }) }, h('img', { src: window.vscgitAssets.push, alt: 'Push' }));
  const forcePush = h('button', { class: 'secondary push-icon', title: 'Force push', onClick: () => vscode.postMessage({ type: 'pushChecked', force: true }) }, h('img', { src: window.vscgitAssets.forcePush, alt: 'Force push' }));
  const commitAll = h('button', { class: 'secondary', text: 'Commit', onClick: () => vscode.postMessage({ type: 'commitChecked', message: S.message, amend: S.amend, push: false }) });
  const commitPushAll = h('button', { class: 'secondary', text: 'Commit&Push', onClick: () => vscode.postMessage({ type: 'commitChecked', message: S.message, amend: S.amend, push: true }) });
  const box = h('div', { class: 'commit-box' },
    h('div', { class: 'row' }, h('label', { for: 'amend', class: 'check' }, amend, ' Amend'), button('history', 'Commit Message History', () => repoMessage('history'))),
    msg,
    h('div', { class: 'row' }, commitAll, commitPushAll, h('span', { class: 'push-actions' }), push, forcePush));
  el.body.append(tb, tree, box);
  updateCommitButton();
}

function updateCommitButton() {
  const d = repoData();
  if (!el.commitBtn || !d) return;
  const staged = (d.staged || []).length;
  const unstaged = (d.unstaged || []).length;
  el.commitBtn.textContent = S.amend ? 'Amend Commit' : staged ? 'Commit' : 'Commit All';
  el.commitBtn.title = S.amend ? 'Amend the last commit' : staged ? `Commit ${staged} staged file(s)` : 'Commit all tracked changes (git commit -a)';
  const can = !!S.message.trim() && (S.amend || staged > 0 || unstaged > 0) && !(d.conflicts || []).length;
  el.commitBtn.disabled = !can;
  el.pushBtn.disabled = !can;
}

function commit(push) {
  if (!S.message.trim()) return;
  vscode.postMessage({ type: 'commitChecked', message: S.message, amend: S.amend, push });
}

function fileRow(group, f, repo = repoData().repo) {
  const repoMessage = (type, extra = {}) => repoMessageFor(repo, type, extra);
  const k = key(group, f.path);
  const name = S.ui.groupByDir ? baseName(f.path) : baseName(f.path);
  const dir = S.ui.groupByDir ? '' : dirName(f.path);
  const actions = h('span', { class: 'row-actions' });
  if (group === 'staged') actions.append(button('minus', 'Unstage', (e) => { e.stopPropagation(); repoMessage('unstage', { paths: [f.path] }); }));
  else actions.append(button('plus', 'Stage', (e) => { e.stopPropagation(); repoMessage('stage', { paths: [f.path] }); }));
  if (group === 'unstaged') actions.append(button('rollback', 'Rollback...', (e) => { e.stopPropagation(); repoMessage('rollback', { paths: [f.path] }); }));
  actions.append(button('open', 'Open File', (e) => { e.stopPropagation(); repoMessage('open', { path: f.path }); }));
  const stagedCls = group === 'staged' && f.status !== 'D' ? (f.status === 'A' || f.status === 'C' ? ' staged-a' : ' staged-m') : '';
  const row = h('div', {
    class: 'tree-row file ' + statusClass(f.status) + stagedCls + (S.selected.has(k) ? ' selected' : ''),
    title: `${statusTitle(f.status)}: ${f.path}${f.oldPath ? `\nfrom ${f.oldPath}` : ''}`,
    'data-key': k
  },
  h('span', { class: 'twisty' }), icon(f.gitlink ? 'repo' : 'file', 'ic-file'), h('span', { class: 'name', text: name }),
  f.gitlink ? h('span', { class: 'dim', text: 'submodule pointer' }) : null,
  dir ? h('span', { class: 'dim', text: dir }) : null,
  f.oldPath ? h('span', { class: 'dim', text: `\u2190 ${f.oldPath}` }) : null,
  h('span', { class: 'spacer' }), actions, stagedCls ? h('span', { class: 'badge-s', title: stagedCls === ' staged-a' ? 'Staged (new file)' : 'Staged (modified)', text: 'S' }) : null);
  const setCtx = () => {
    const sameGroup = S.selected.has(k) ? selectedIn(group) : [f.path];
    row.dataset.vscodeContext = JSON.stringify({ preventDefaultContextMenuItems: true, webviewSection: 'change', repo, changeGroup: group, path: f.path, oldPath: f.oldPath || '', status: f.status, paths: sameGroup });
  };
  setCtx();
  row.addEventListener('contextmenu', () => {
    if (S.repo !== repo) { S.repo = repo; S.selected.clear(); S.anchor = null; }
    if (!S.selected.has(k)) { S.selected = new Set([k]); S.anchor = k; markSelection(); }
    setCtx();
  });
  row.addEventListener('click', (e) => {
    if (S.repo !== repo) { S.repo = repo; S.selected.clear(); S.anchor = null; }
    if (e.ctrlKey || e.metaKey) {
      if (S.selected.has(k)) S.selected.delete(k); else S.selected.add(k);
      S.anchor = k;
    } else if (e.shiftKey && S.anchor) {
      const rows = [...document.querySelectorAll('.changes .tree-row.file')].map(r => r.dataset.key);
      const a = rows.indexOf(S.anchor);
      const b = rows.indexOf(k);
      S.selected = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else {
      S.selected = new Set([k]);
      S.anchor = k;
      repoMessage('diff', { group, file: f });
    }
    markSelection();
  });
  row.addEventListener('dblclick', () => repoMessage('open', { path: f.path }));
  return row;
}

function markSelection() {
  for (const r of document.querySelectorAll('.changes .tree-row.file')) r.classList.toggle('selected', S.selected.has(r.dataset.key));
  const tb = el.body.querySelector('.toolbar');
  if (tb) {
    // Re-render toolbar enablement cheaply by re-rendering the tab when selection emptiness changes.
    const btns = tb.querySelectorAll('button');
    const has = S.selected.size > 0;
    btns[1].disabled = !has;
    btns[3].disabled = !has;
    btns[4].disabled = !has;
    btns[5].disabled = !selectedIn('staged').length;
  }
}

function showSelectedDiff() {
  for (const k of S.selected) {
    const i = k.indexOf('\0');
    const group = k.slice(0, i);
    const p = k.slice(i + 1);
    const f = (repoData()[group] || []).find(x => x.path === p);
    if (f) { repoMessage('diff', { group, file: f }); break; }
  }
}

// ---------------- shelf tab ----------------

function renderShelfTab() {
  const d = repoData();
  const tb = h('div', { class: 'toolbar' },
    button('shelve', 'Shelve Changes...', () => repoMessage('shelve', { paths: [] }), { label: 'Shelve Changes...' }),
    h('span', { class: 'spacer' }),
    button('refresh', 'Refresh', () => repoMessage('refresh')));
  const list = h('div', { class: 'changes' });
  if (!d.stashes.length) list.append(h('div', { class: 'empty', text: 'No shelved changes. Shelved changes are stored as git stashes.' }));
  for (const s of d.stashes) {
    const open = S.stashOpen.has(s.ref);
    const actions = h('span', { class: 'row-actions' },
      button('upload', 'Unshelve (apply)', (e) => { e.stopPropagation(); repoMessage('stash', { action: 'apply', ref: s.ref }); }),
      button('check', 'Unshelve and remove (pop)', (e) => { e.stopPropagation(); repoMessage('stash', { action: 'pop', ref: s.ref }); }),
      button('changes', 'Show All Changes', (e) => { e.stopPropagation(); repoMessage('stash', { action: 'changes', ref: s.ref }); }),
      button('trash', 'Delete', (e) => { e.stopPropagation(); repoMessage('stash', { action: 'drop', ref: s.ref }); }));
    const row = h('div', { class: 'tree-row stash', title: `${s.ref}\n${s.message}`, ctx: { webviewSection: 'stash', repo: d.repo, ref: s.ref } },
      h('span', { class: 'twisty' }, icon(open ? 'chevronDown' : 'chevronRight')), icon('shelve', 'ic-folder'),
      h('span', { class: 'name', text: s.message }), h('span', { class: 'dim', text: fmtDate(s.date) }), h('span', { class: 'spacer' }), actions);
    row.style.paddingLeft = '4px';
    row.addEventListener('click', () => {
      if (open) S.stashOpen.delete(s.ref);
      else { S.stashOpen.add(s.ref); repoMessage('stashFiles', { ref: s.ref }); }
      render();
    });
    list.append(row);
    if (open) {
      const files = S.stashFiles[s.ref];
      if (!files) list.append(h('div', { class: 'tree-row dim-row', text: 'Loading\u2026' }));
      else {
        renderTree(list, treeNodes(files, S.ui.groupByDir, 'stash:' + s.ref + ':'), 1, {
          collapsed: S.collapsed,
          onToggle: render,
          renderFile: (f) => {
            const r = h('div', { class: 'tree-row file ' + statusClass(f.status), title: `${statusTitle(f.status)}: ${f.path}` },
              h('span', { class: 'twisty' }), icon('file', 'ic-file'), h('span', { class: 'name', text: S.ui.groupByDir ? baseName(f.path) : f.path }));
            r.addEventListener('click', () => repoMessage('stashDiff', { ref: s.ref, file: f }));
            return r;
          }
        });
      }
    }
  }
  el.body.append(tb, list);
}

// ---------------- messages ----------------

window.addEventListener('message', (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'batchProgress': {
      let progress = document.getElementById('batch-progress');
      if (!progress) {
        progress = h('div', { id: 'batch-progress', role: 'status' });
        document.body.prepend(progress);
      }
      progress.textContent = m.message;
      break;
    }
    case 'loadError':
      el.body.textContent = '';
      el.body.append(h('div', { class: 'empty', text: 'Could not load repositories: ' + m.message }), h('button', { text: 'Retry', onClick: () => vscode.postMessage({ type: 'refresh' }) }));
      break;
    case 'init':
      Object.assign(S.ui, m.opts || {});
      build();
      break;
    case 'status': {
      const repoChanged = !S.data || S.data.repo !== m.repo;
      S.data = m;
      if (!S.repo || !(m.repositories || []).some(r => r.repo === S.repo)) { S.repo = m.repo; S.message = S.messages[S.repo] || S.message; }
      if (repoChanged) { S.selected.clear(); S.stashFiles = {}; S.stashOpen.clear(); }
      else {
        const active = repoData();
        const valid = new Set();
        for (const g of GROUPS) for (const f of active[g.id] || []) valid.add(key(g.id, f.path));
        S.selected = new Set([...S.selected].filter(k => valid.has(k)));
        S.stashFiles = {};
        for (const r of S.stashOpen) repoMessage('stashFiles', { ref: r });
      }
      const ae = document.activeElement;
      const hadMsgFocus = ae && ae === el.msg;
      const start = hadMsgFocus ? el.msg.selectionStart : 0;
      const end = hadMsgFocus ? el.msg.selectionEnd : 0;
      const msgScroll = el.msg ? el.msg.scrollTop : 0;
      render();
      if (el.msg) el.msg.scrollTop = msgScroll;
      if (hadMsgFocus && el.msg) { el.msg.focus(); el.msg.setSelectionRange(start, end); }
      break;
    }
    case 'stashFiles':
      S.stashFiles[m.ref] = m.files;
      if (S.tab === 'shelf') render();
      break;
    case 'setMessage':
      S.message = m.text;
      persist();
      if (el.msg) el.msg.value = m.text;
      updateCommitButton();
      break;
    case 'committed':
      S.message = '';
      S.amend = false;
      persist();
      render();
      break;
  }
});

vscode.postMessage({ type: 'ready' });
