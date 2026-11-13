const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeRepositoryLogs } = require('../out/repositoryLog');
const { computeGraph, computeRepositoryGraph, graphWidth, graphMetrics } = require('../media/graph');
test('aggregate log keeps repository ownership, deduplicates shared objects and applies a global limit', () => {
  const commit = (h, at) => ({ h, at, p: [], an: 'Test', ae: 'test@local', refs: '', s: h });
  const rows = mergeRepositoryLogs([
    { repo: '/root', commits: [commit('shared', 100), commit('old', 50)] },
    { repo: '/root/child', commits: [commit('new', 200), commit('shared', 100)] },
  ], 2);
  assert.deepEqual(rows.map(row => row.h), ['new', 'shared']);
  assert.equal(rows[0].repo, '/root/child');
  assert.deepEqual(rows[1].repositories, ['/root', '/root/child']);
});

test('interleaved repository histories retain separate connected graph lanes', () => {
  const commit = (h, p, at) => ({ h, p, at, an: 'Test', ae: 'test@local', refs: '', s: h });
  const commits = mergeRepositoryLogs([
    { repo: '/root', commits: [commit('a2', ['a1'], 400), commit('a1', [], 100)] },
    { repo: '/child', commits: [commit('b2', ['b1'], 300), commit('b1', [], 200)] },
  ], 10);
  const graph = computeGraph(commits);
  assert.deepEqual(commits.map(c => c.h), ['a2', 'b2', 'b1', 'a1']);
  assert.equal(graph[0].col, graph[3].col, 'root commits remain connected');
  assert.equal(graph[1].col, graph[2].col, 'child commits remain connected');
  assert.notEqual(graph[0].col, graph[1].col, 'independent histories occupy separate lanes');
  assert.ok(graph[1].segs.some(s => s.kind === 'pass'), 'root flow continues behind child commits');
  assert.ok(graph[2].segs.some(s => s.kind === 'top'), 'child parent receives its incoming line');
});

test('a parent with a newer timestamp still follows its child in the combined graph', () => {
  const commit = (h, p, at) => ({ h, p, at, an: 'Test', ae: 'test@local', refs: '', s: h });
  const rows = mergeRepositoryLogs([
    { repo: '/root', commits: [commit('child', ['parent'], 100), commit('parent', [], 300)] },
    { repo: '/other', commits: [commit('other', [], 200)] },
  ], 10);
  assert.ok(rows.findIndex(c => c.h === 'child') < rows.findIndex(c => c.h === 'parent'));
  assert.deepEqual(mergeRepositoryLogs([{ repo: '/root', commits: [commit('child', ['parent'], 100), commit('parent', [], 300)] }], 1).map(c => c.h), ['child']);
});

test('graph lanes keep a fixed readable spacing beyond twenty independent histories', () => {
  const tips = Array.from({ length: 30 }, (_, i) => ({ h: `tip${i}`, p: [`parent${i}`] }));
  const parents = tips.map((_, i) => ({ h: `parent${i}`, p: [] }));
  const graph = computeGraph([...tips, ...parents]);
  assert.equal(graphWidth(graph), 30);
  assert.ok(graph.every(row => row.col < graphWidth(graph)));
  const metrics = graphMetrics(graph);
  assert.equal(metrics.spacing, 14, 'lanes are never squeezed together');
  assert.ok(graph.every(row => 8 + row.col * metrics.spacing < metrics.pixels), 'every lane lies inside the drawn graph');
});

test('compact histories reuse space without inventing edges between unrelated repositories', () => {
  const commits = [
    { h: 'a2', p: ['a1'], repo: '/a' },
    { h: 'b2', p: ['b1'], repo: '/b' },
    { h: 'a1', p: [], repo: '/a' },
    { h: 'b1', p: [], repo: '/b' },
  ];
  const rows = computeRepositoryGraph(commits);
  assert.equal(graphWidth(rows), 1);
  assert.ok(rows.every(row => !row.segs.some(s => s.kind === 'pass')));
  assert.equal(rows[0].gapAfter, true);
  assert.equal(rows[2].gapBefore, true);
  assert.equal(rows[0].color, rows[2].color);
  assert.notEqual(rows[0].color, rows[1].color);
});

test('topological aggregate option keeps independent histories together while date order interleaves them', () => {
  const commit = (h, p, at) => ({ h, p, at, an: 'Test', ae: 'test@local', refs: '', s: h });
  const logs = [
    { repo: '/a', commits: [commit('a2', ['a1'], 400), commit('a1', [], 100)] },
    { repo: '/b', commits: [commit('b2', ['b1'], 300), commit('b1', [], 200)] },
  ];
  assert.deepEqual(mergeRepositoryLogs(logs, 10, 'date').map(c => c.h), ['a2', 'b2', 'b1', 'a1']);
  assert.deepEqual(mergeRepositoryLogs(logs, 10, 'topo').map(c => c.h), ['a2', 'a1', 'b2', 'b1']);
});
