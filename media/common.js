/* Shared helpers for the Git Tool webviews. */
/* global acquireVsCodeApi */
'use strict';

const vscode = acquireVsCodeApi();

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  chevronRight: '<path d="M6 4l4 4-4 4"/>',
  chevronDown: '<path d="M4 6l4 4 4-4"/>',
  left: '<path d="M10 3L5 8l5 5"/>',
  right: '<path d="M6 3l5 5-5 5"/>',
  folder: '<path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z"/>',
  file: '<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/>',
  star: '<path fill="currentColor" stroke="none" d="M8 1.2l2 4.2 4.6.6-3.4 3.2.9 4.6L8 11.5l-4.1 2.3.9-4.6L1.4 6l4.6-.6z"/>',
  starOutline: '<path d="M8 1.8l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.2l-3.7 2.1.8-4.2L2 6.2l4.2-.5z"/>',
  branch: '<circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="4.5" r="1.5"/><path d="M5 5v6M11 6c0 3-6 2-6 5"/>',
  current: '<path d="M2 8.5V3h5.5l7 7-5.5 5.5z"/><circle cx="5" cy="5.8" r="1"/>',
  tag: '<path d="M2 2h5.5l7 7-5.5 5.5-7-7z"/><circle cx="5" cy="5" r="1"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  update: '<path d="M12 4L4.5 11.5M4 6v6h6"/>',
  fetch: '<path d="M12 2.5L5.5 9M5 4.5v5h5M3 14h10"/>',
  trash: '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.8 10h6.4L12 4"/>',
  compare: '<path d="M2 5h11l-3-3M14 11H3l3 3"/>',
  locate: '<circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1.2"/><path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15"/>',
  group: '<path d="M1.5 3h4l1.5 1.5h7.5V13h-13z"/><path d="M5 8h6M5 10.5h4"/>',
  expand: '<path d="M4.5 6L8 2.5 11.5 6M4.5 10L8 13.5 11.5 10"/>',
  collapse: '<path d="M4.5 2.5L8 6l3.5-3.5M4.5 13.5L8 10l3.5 3.5"/>',
  refresh: '<path d="M13.5 8A5.5 5.5 0 1 1 11.8 4"/><path d="M13 1.5V5H9.5"/>',
  eye: '<path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/>',
  cherry: '<circle cx="4.5" cy="11.5" r="2.5"/><circle cx="11.5" cy="11.5" r="2.5"/><path d="M4.5 9C5.5 5.5 8 3 12.5 1.5M11.5 9c0-3 .5-5 1-7.5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14.5 14.5"/>',
  history: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  rollback: '<path d="M2.5 2.5V6.5H6.5"/><path d="M3 6.5A5.5 5.5 0 1 1 4.5 12.5"/>',
  diff: '<path d="M5 2v7M1.5 5.5h7M2 13h7M10.5 3h4v10h-4"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  repo: '<path d="M3 13V3.5A1.5 1.5 0 0 1 4.5 2H13v9H4.5A1.5 1.5 0 0 0 3 12.5 1.5 1.5 0 0 0 4.5 14H13"/>',
  shelve: '<path d="M1.5 3h13v3h-13zM2.5 6v7.5h11V6M6 9h4"/>',
  upload: '<path d="M8 13V3M4 7l4-4 4 4M3 14.5h10"/>',
  changes: '<path d="M3 2.5h7l3 3v8H3z"/><path d="M6 8h4M8 6v4"/>',
  open: '<path d="M9 2.5h4.5V7M13.5 2.5L7 9M11 9.5v4H2.5V5h4"/>'
};

function icon(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/** Tiny DOM builder: h('div', {class, title, onClick, ctx}, ...children). */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'ctx') el.dataset.vscodeContext = JSON.stringify({ preventDefaultContextMenuItems: true, ...v });
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function button(iconName, title, onClick, opts = {}) {
  return h('button', { class: 'tbtn' + (opts.active ? ' active' : '') + (opts.cls ? ' ' + opts.cls : ''), title, onClick, disabled: opts.disabled }, iconName ? icon(iconName) : null, opts.label || null);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtDate(sec) {
  const d = new Date(sec * 1000);
  const now = new Date();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

function statusClass(s) {
  return { M: 'st-m', A: 'st-a', D: 'st-d', R: 'st-r', C: 'st-a', '?': 'st-u', U: 'st-c', T: 'st-m' }[s] || 'st-m';
}

function statusTitle(s) {
  return { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', '?': 'Unversioned', U: 'Conflict', T: 'Type changed' }[s] || s;
}

function baseName(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
}

function dirName(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Converts files into tree nodes; single-child folder chains are compressed (a/b/c). */
function treeNodes(files, group, keyPrefix) {
  if (!group) return files.slice().sort((a, b) => a.path.localeCompare(b.path)).map(f => ({ file: f }));
  const root = { children: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    parts.pop();
    let n = root;
    for (const p of parts) {
      if (!n.children.has(p)) n.children.set(p, { name: p, children: new Map(), files: [] });
      n = n.children.get(p);
    }
    n.files.push(f);
  }
  const count = (n) => n.files.length + [...n.children.values()].reduce((s, c) => s + count(c), 0);
  const conv = (n, prefix) => {
    const out = [];
    const dirs = [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (let d of dirs) {
      let name = d.name;
      let full = prefix + d.name;
      while (d.files.length === 0 && d.children.size === 1) {
        const c = d.children.values().next().value;
        name += '/' + c.name;
        full += '/' + c.name;
        d = c;
      }
      const children = conv(d, full + '/');
      const paths = [];
      const collect = (items) => { for (const item of items) item.file ? paths.push(item.file.path) : collect(item.children); };
      collect(children);
      out.push({ dir: name, key: full, count: count(d), paths, children });
    }
    for (const f of n.files.sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)))) out.push({ file: f });
    return out;
  };
  return conv(root, keyPrefix || '');
}

function allDirKeys(nodes, out = []) {
  for (const n of nodes) if (n.dir) { out.push(n.key); allDirKeys(n.children, out); }
  return out;
}

/**
 * Renders tree nodes. opts: { collapsed: Set, onToggle(), renderFile(file, depth) -> element, dirCtx?(node), renderDirActions?(node) }
 */
function renderTree(container, nodes, depth, opts) {
  for (const n of nodes) {
    if (n.dir) {
      const isCollapsed = opts.collapsed.has(n.key);
      const row = h('div', { class: 'tree-row dir', title: n.key, ctx: opts.dirCtx ? opts.dirCtx(n) : undefined },
        h('span', { class: 'twisty' }, icon(isCollapsed ? 'chevronRight' : 'chevronDown')),
        icon('folder', 'ic-folder'),
        h('span', { class: 'name', text: n.dir }),
        h('span', { class: 'dim', text: `${n.count} file${n.count === 1 ? '' : 's'}` }),
        h('span', { class: 'spacer' }), opts.renderDirActions ? opts.renderDirActions(n) : null);
      row.style.paddingLeft = depth * 14 + 4 + 'px';
      row.addEventListener('click', () => {
        if (isCollapsed) opts.collapsed.delete(n.key);
        else opts.collapsed.add(n.key);
        opts.onToggle();
      });
      container.append(row);
      if (!isCollapsed) renderTree(container, n.children, depth + 1, opts);
    } else {
      const row = opts.renderFile(n.file, depth);
      row.style.paddingLeft = depth * 14 + 4 + 'px';
      container.append(row);
    }
  }
}

/** Makes `handle` resize `target` horizontally (dir 1: grow to the right, -1: to the left). */
function makeSplitter(handle, target, dir, onDone, vertical) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = vertical ? e.clientY : e.clientX;
    const startSize = vertical ? target.getBoundingClientRect().height : target.getBoundingClientRect().width;
    const move = (ev) => {
      const delta = ((vertical ? ev.clientY : ev.clientX) - start) * dir;
      const size = Math.max(80, startSize + delta);
      if (vertical) target.style.height = size + 'px';
      else target.style.width = size + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      onDone(vertical ? target.getBoundingClientRect().height : target.getBoundingClientRect().width);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}
