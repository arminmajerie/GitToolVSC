/* Synthetic demo data and a fake VS Code webview API for the README recordings. */
'use strict';

(function () {
  const PEOPLE = [
    ['Alice Andersson', 'alice@example.com'], ['Bjorn Berg', 'bjorn@example.com'], ['Carla Costa', 'carla@example.com'],
    ['Dev Patel', 'dev@example.com'], ['You', 'me@example.com']
  ];
  const TOPICS = ['Add retry to export job', 'Fix date parsing in report', 'Cache user settings', 'Speed up nightly import',
    'Validate input files', 'Log transfer errors', 'Clean up workflow names', 'Support CSV upload',
    'Update deploy pipeline', 'Handle empty batches', 'Refactor scheduler', 'Add health endpoint', 'Tidy README',
    'Bump dependencies', 'Fix flaky test', 'Rename task variables'];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 9301 + 49297) % 233280; return Math.floor((seed / 233280) * n); };
  let t = 1762000000;
  let n = 0;
  const hash = () => { n++; let s = ''; for (let i = 0; i < 5; i++) s += ((n * 2654435761 + i * 40503 + n * i * 97) % 4294967296).toString(16).padStart(8, '0'); return s.slice(0, 40); };
  const all = [];
  const mk = (parents, subject, who) => {
    t += 1800 + rnd(9000);
    const p = PEOPLE[who ?? rnd(PEOPLE.length)];
    const c = { h: hash(), p: parents, an: p[0], ae: p[1], at: t, refs: '', s: subject };
    all.push(c);
    return c;
  };
  let main = mk([], 'Initial import', 0);
  const open = [];
  let ticket = 1180;
  for (let step = 0; step < 34; step++) {
    const r = rnd(10);
    if (r < 3 || !open.length) {
      ticket++;
      const name = `feature/${ticket}-${TOPICS[rnd(TOPICS.length)].toLowerCase().replace(/[^a-z]+/g, '-').slice(0, 30).replace(/-$/, '')}`;
      open.push({ name, head: main, ticket, count: 0, who: rnd(PEOPLE.length) });
    }
    const f = open[rnd(open.length)];
    f.head = mk([f.head.h], `#${f.ticket} ${TOPICS[rnd(TOPICS.length)]}`, f.who);
    f.count++;
    if (f.count >= 2 + rnd(3) && open.length > 1) {
      main = mk([main.h, f.head.h], `Merge pull request #${300 + step} from ${f.name}`, rnd(4));
      open.splice(open.indexOf(f), 1);
    } else if (rnd(6) === 0) {
      main = mk([main.h], `#${ticket} Hotfix ${TOPICS[rnd(TOPICS.length)].toLowerCase()}`);
    }
  }
  main.refs = 'origin/main, main, tag: v1.4.0';
  const current = open[0];
  current.head.refs = `HEAD -> ${current.name}, origin/${current.name}`;
  for (const f of open.slice(1)) f.head.refs = `origin/${f.name}`;
  const commits = all.slice().sort((a, b) => b.at - a.at);
  const branch = (name, c, extra) => Object.assign({ name, hash: c.h }, extra || {});
  const branches = {
    type: 'branches', repo: 'C:\\Git\\demo-service', current: current.name, head: current.head.h,
    local: [branch('main', main, { favorite: true, upstream: 'origin/main' }), branch(current.name, current.head, { upstream: 'origin/' + current.name, track: '[ahead 1]' })],
    remote: [branch('origin/main', main, { favorite: true }), ...open.map(f => branch('origin/' + f.name, f.head))],
    tags: [branch('v1.4.0', main)]
  };
  const FILES = [
    'src/export/ExportJob.ts', 'src/export/RetryPolicy.ts', 'src/report/DateParser.ts', 'src/settings/UserSettings.ts',
    'test/export/ExportJob.test.ts', 'pipelines/deploy.yml', 'README.md', 'src/scheduler/Scheduler.ts'
  ];
  const filesFor = (h) => {
    const k = parseInt(h.slice(0, 4), 16);
    return FILES.filter((_, i) => (k >> i) & 1 || i === k % FILES.length).map((p, i) => ({ status: i === 1 && k % 3 === 0 ? 'A' : 'M', path: p }));
  };
  window.DEMO = { commits, branches, head: current.head.h, filesFor, repo: branches.repo, repoName: 'demo-service' };

  // ---- fake webview API ----
  const params = new URLSearchParams(location.search);
  const part = params.get('part') || 'all';
  const page = document.body.className;
  const relay = (msg) => (window.parent !== window ? window.parent.postMessage({ relay: msg }, '*') : window.postMessage(msg, '*'));
  const local = (msg) => window.postMessage(msg, '*');
  window.LAST = null;
  window.acquireVsCodeApi = () => ({
    getState() { return undefined; },
    setState() {},
    postMessage(m) {
      window.LAST = m;
      const D = window.DEMO;
      if (page === 'page-log') {
        if (m.type === 'ready') {
          local({ type: 'init', mode: 'main', part, opts: { wBranches: 260, wDetails: 330 } });
          local({ type: 'filter', repo: D.repo, repoName: D.repoName, text: '', user: '', paths: '', options: '' });
          local(D.branches);
          local({ type: 'log', commits: D.commits, head: D.head, me: 'me@example.com', hasMore: true, graph: true });
        } else if (m.type === 'select') {
          const sel = m.hashes.map(x => D.commits.find(c => c.h === x));
          const c = sel[0];
          if (sel.length === 1) {
            relay({ type: 'details', repo: D.repo, left: c.p[0] || '~empty', right: c.h, files: D.filesFor(c.h),
              info: { hash: c.h, parents: c.p, an: c.an, ae: c.ae, at: c.at, cn: c.an, ce: c.ae, ct: c.at, refs: c.refs, message: c.s + '\n\nReviewed and tested locally.' } });
            relay({ type: 'containing', hash: c.h, branches: ['main', 'origin/main'] });
          } else {
            const files = [...new Map(sel.flatMap(s => D.filesFor(s.h)).map(f => [f.path, f])).values()];
            relay({ type: 'details', repo: D.repo, left: sel[sel.length - 1].p[0], right: c.h, files, compare: true, count: sel.length, range: true });
          }
        } else if (m.type === 'branchFilter') {
          const name = m.ref;
          const b = [...D.branches.local, ...D.branches.remote].find(x => x.name === name);
          if (b) relay({ type: 'reveal', hash: b.hash, name: '' });
        } else if (m.type === 'locate') relay({ type: 'reveal', hash: m.hash, name: '' });
      } else if (page === 'page-commit' && m.type === 'ready') {
        local({ type: 'init', opts: {} });
        local(window.COMMIT_STATUS);
      } else if (page === 'page-commit' && m.type === 'stashFiles') {
        local({ type: 'stashFiles', ref: m.ref, files: [{ status: 'M', path: 'src/export/ExportJob.ts' }, { status: 'A', path: 'src/export/BatchSize.ts' }] });
      } else if (page === 'page-rebase' && m.type === 'ready') {
        const mine = D.commits.filter(c => c.p.length === 1).slice(0, 5).reverse();
        local({ type: 'init', repoName: D.repoName, branch: D.branches.current, base: mine[0].p[0].slice(0, 8),
          commits: mine.map(c => ({ hash: c.h, author: c.an, at: c.at, subject: c.s, message: c.s })) });
      }
    }
  });

  // ---- recording helpers (driven from the capture script) ----
  window.demoCaption = (text) => {
    let el = document.getElementById('demo-caption');
    if (!text) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'demo-caption'; document.body.append(el); }
    el.textContent = text;
  };
  window.demoSpot = (el) => {
    for (const x of document.querySelectorAll('.demo-spot')) x.classList.remove('demo-spot');
    if (el) el.classList.add('demo-spot');
  };
  window.demoCursor = (x, y) => {
    let c = document.querySelector('.demo-cursor');
    if (x === undefined) { if (c) c.remove(); return; }
    if (!c) { c = document.createElement('div'); c.className = 'demo-cursor'; document.body.append(c); }
    c.style.left = x + 'px';
    c.style.top = y + 'px';
  };
  /** Draws a VS Code style context menu; items: strings, '-' for separators, '>Label' for submenus. */
  window.demoMenu = (id, x, y, items, active) => {
    let m = document.getElementById(id);
    if (!items) { if (m) m.remove(); return; }
    if (!m) { m = document.createElement('div'); m.id = id; m.className = 'demo-menu'; document.body.append(m); }
    m.textContent = '';
    m.style.left = x + 'px';
    m.style.top = y + 'px';
    items.forEach((it, i) => {
      if (it === '-') { const s = document.createElement('div'); s.className = 'sep'; m.append(s); return; }
      const r = document.createElement('div');
      r.className = 'item' + (i === active ? ' active' : '') + (it.startsWith('~') ? ' disabled' : '');
      const label = it.replace(/^[>~]/, '');
      const [text, key] = label.split('|');
      r.append(Object.assign(document.createElement('span'), { textContent: text }));
      r.append(Object.assign(document.createElement('span'), { className: 'key', textContent: it.startsWith('>') ? '\u203a' : key || '' }));
      m.append(r);
    });
  };
})();
