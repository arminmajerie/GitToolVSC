/* Commit graph layout and drawing for the Git log. */
'use strict';

const GRAPH_COLORS = ['#4fa3e0', '#e5a03a', '#7ac46b', '#c678dd', '#e06c75', '#56b6c2', '#d19a66', '#98c379', '#61afef', '#be5046'];
const LANE_W = 12;
const ROW_H = 22;

/**
 * Lays out lanes for commits in display order (children before parents).
 * Returns one row per commit: { col, color, width, segs: [{ kind: 'top'|'bottom'|'pass', from, to, color }] }.
 */
function computeGraph(commits) {
  const lanes = [];
  let nextColor = 0;
  const rows = [];
  for (const c of commits) {
    let col = lanes.findIndex(l => l && l.hash === c.h);
    let fresh = false;
    if (col < 0) {
      col = lanes.findIndex(l => !l);
      if (col < 0) { col = lanes.length; lanes.push(null); }
      lanes[col] = { hash: c.h, color: nextColor++ };
      fresh = true;
    }
    const color = lanes[col].color;
    const before = lanes.slice();
    const segs = [];
    before.forEach((l, j) => {
      if (l && l.hash === c.h && !(j === col && fresh)) segs.push({ kind: 'top', from: j, to: col, color: l.color });
    });
    lanes.forEach((l, j) => { if (l && l.hash === c.h && j !== col) lanes[j] = null; });
    if (!c.p.length) lanes[col] = null;
    else {
      lanes[col] = { hash: c.p[0], color };
      segs.push({ kind: 'bottom', from: col, to: col, color });
      for (let k = 1; k < c.p.length; k++) {
        let idx = lanes.findIndex(l => l && l.hash === c.p[k]);
        if (idx < 0) {
          idx = lanes.findIndex(l => !l);
          if (idx < 0) { idx = lanes.length; lanes.push(null); }
          lanes[idx] = { hash: c.p[k], color: nextColor++ };
        }
        segs.push({ kind: 'bottom', from: col, to: idx, color: lanes[idx].color });
      }
    }
    before.forEach((l, j) => {
      if (l && l.hash !== c.h && lanes[j] && lanes[j].hash === l.hash) segs.push({ kind: 'pass', from: j, to: j, color: l.color });
    });
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    rows.push({ col, color, segs, width: Math.max(before.length, lanes.length, col + 1) });
  }
  return rows;
}

function laneX(i, spacing = LANE_W) {
  return 8 + i * spacing;
}

// Separate repositories have no Git edges between them. Reuse their horizontal
// space and mark interruptions rather than drawing every unrelated passing lane.
function computeRepositoryGraph(commits) {
  const groups = new Map();
  commits.forEach((commit, index) => {
    const key = commit.repo || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ commit, index });
  });
  const rows = new Array(commits.length);
  let colorOffset = 0;
  for (const entries of groups.values()) {
    const graph = computeGraph(entries.map(e => e.commit));
    graph.forEach((row, i) => {
      rows[entries[i].index] = { ...row, color: row.color + colorOffset,
        segs: row.segs.map(s => ({ ...s, color: s.color + colorOffset })),
        gapBefore: i > 0 && entries[i - 1].index !== entries[i].index - 1,
        gapAfter: i + 1 < entries.length && entries[i + 1].index !== entries[i].index + 1 };
    });
    colorOffset += 1 + Math.max(0, ...graph.map(row => row.color));
  }
  return rows;
}

function graphWidth(rows) {
  return rows.reduce((width, row) => Math.max(width, row.width), 1);
}

function graphMetrics(rows, availableWidth) {
  const lanes = graphWidth(rows);
  const budget = Math.max(40, Math.min(240, availableWidth * 0.3));
  const spacing = Math.min(LANE_W, (budget - 8) / lanes);
  return { lanes, spacing, pixels: 8 + lanes * spacing };
}

function drawGraphRow(row, width, isHead, spacing = LANE_W) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  const w = laneX(width, spacing);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(ROW_H));
  svg.setAttribute('class', 'graph');
  const mid = ROW_H / 2;
  for (const s of row.segs) {
    const line = document.createElementNS(NS, 'path');
    let x1, y1, x2, y2;
    if (s.kind === 'pass') { x1 = x2 = laneX(s.from, spacing); y1 = 0; y2 = ROW_H; }
    else if (s.kind === 'top') { x1 = laneX(s.from, spacing); y1 = 0; x2 = laneX(s.to, spacing); y2 = mid; }
    else { x1 = laneX(s.from, spacing); y1 = mid; x2 = laneX(s.to, spacing); y2 = ROW_H; }
    line.setAttribute('d', x1 === x2 ? `M${x1},${y1} L${x2},${y2}` : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', GRAPH_COLORS[s.color % GRAPH_COLORS.length]);
    line.setAttribute('stroke-width', '1.6');
    if ((row.gapBefore && y1 === 0) || (row.gapAfter && y2 === ROW_H)) line.setAttribute('stroke-dasharray', '2 2');
    svg.append(line);
    // Open arrowheads mean the edge continues across omitted repository rows.
    for (const [gap, x, y, direction] of [[row.gapBefore && y1 === 0, x1, 2, -1], [row.gapAfter && y2 === ROW_H, x2, ROW_H - 2, 1]]) {
      if (!gap) continue;
      const arrow = document.createElementNS(NS, 'path');
      arrow.setAttribute('d', `M${x - 2.5},${y - direction * 3} L${x},${y} L${x + 2.5},${y - direction * 3}`);
      arrow.setAttribute('fill', 'none');
      arrow.setAttribute('stroke', GRAPH_COLORS[s.color % GRAPH_COLORS.length]);
      svg.append(arrow);
    }
  }
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('cx', laneX(row.col, spacing));
  dot.setAttribute('cy', mid);
  dot.setAttribute('r', isHead ? '4.5' : '3.5');
  const col = GRAPH_COLORS[row.color % GRAPH_COLORS.length];
  if (isHead) {
    dot.setAttribute('fill', 'var(--vscode-editor-background)');
    dot.setAttribute('stroke', col);
    dot.setAttribute('stroke-width', '2');
  } else dot.setAttribute('fill', col);
  svg.append(dot);
  return svg;
}

if (typeof module !== 'undefined') module.exports = { computeGraph, computeRepositoryGraph, graphWidth, graphMetrics };
