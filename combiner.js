// BG Studio Combiner — stitch multiple images into one meme.
//
// State:
//   S.panels        Array<{ id, img, name, w, h, filters, fxOpen, size }>   ordered top-to-bottom or left-to-right
//                   filters: per-panel filter params (see filterString); fxOpen: its filter panel is expanded
//                   size: mosaic size multiplier (linear, 1 = as big as its own pixels suggest)
//   S.layout        'stack' | 'row' | 'grid' | 'mosaic'
//   S.gridCols      integer, cols for grid layout
//   S.mosaicShape   'auto' | target width/height ratio as a string ('1', '1.7778', ...)
//   S.mosaicKeepOrder  mosaic leaves follow S.panels order (otherwise it may reorder them)
//   S.mosaicSeed    seed for the mosaic search; 🎲 Try another bumps it
//   S.sizing        'orig' | 'matchWidest' | 'matchNarrowest' | 'matchTallest' | 'matchShortest'
//   S.align         'start' | 'center' | 'end'   (cross-axis alignment for uneven panels)
//   S.gap           px between panels
//   S.bg            fill colour (canvas + gutter)
//   S.borderW       per-panel border width
//   S.borderColor   per-panel border colour

import { filterString, pixelateCanvas } from './engine/filters.js';
import { makeFilterPanel } from './engine/filter-panel.js';
import { initMobileShell } from './engine/mobile-shell.js';
import { addImageHistory } from './engine/history.js';

const S = {
  panels: [],
  layout: 'stack',
  gridCols: 2,
  mosaicShape: 'auto',
  mosaicKeepOrder: false,
  mosaicSeed: 1,
  sizing: 'matchWidest',
  align: 'center',
  gap: 0,
  bg: '#ffffff',
  borderW: 0,
  borderColor: '#000000',
};

const canvas = document.getElementById('preview');
const ctx = canvas.getContext('2d');
const stage = document.getElementById('stage');

function uid() { return Math.random().toString(36).slice(2, 10); }

// ---------- Load / add panels ----------

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

async function addPanelFromBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    S.panels.push({
      id: uid(), img,
      name: (name || 'image').replace(/\.[^.]+$/, ''),
      w: img.naturalWidth, h: img.naturalHeight,
      filters: {}, fxOpen: false, size: 1,
    });
  } finally {
    // Don't revoke — the <img> keeps the blob URL as its .src.
  }
  renderPanelList();
  layoutAndDraw();
}

async function handleFiles(files) {
  for (const f of files) {
    if (!/^image\//.test(f.type)) continue;
    try { await addPanelFromBlob(f, f.name); } catch (e) { console.error(e); }
  }
}

// ---------- Sizing strategy ----------

// Returns Array<{w, h}> — each panel's target rendered dimensions.
function scaledDims() {
  if (S.panels.length === 0) return [];
  const ws = S.panels.map(p => p.w);
  const hs = S.panels.map(p => p.h);
  let targetW = null, targetH = null;
  if (S.sizing === 'matchWidest')    targetW = Math.max(...ws);
  if (S.sizing === 'matchNarrowest') targetW = Math.min(...ws);
  if (S.sizing === 'matchTallest')   targetH = Math.max(...hs);
  if (S.sizing === 'matchShortest')  targetH = Math.min(...hs);
  return S.panels.map(p => {
    if (targetW !== null) return { w: targetW, h: p.h * (targetW / p.w) };
    if (targetH !== null) return { w: p.w * (targetH / p.h), h: targetH };
    return { w: p.w, h: p.h };
  });
}

// ---------- Mosaic ----------
//
// A mosaic is a slicing tree: each internal node puts its two children side by
// side ('h', equal heights) or one above the other ('v', equal widths). Any such
// tree tiles a rectangle exactly, whatever the images' aspect ratios, so there is
// never empty space - the search only decides which tree looks best: overall
// shape close to the target, and every panel scaled by as nearly the same factor
// as possible, so a big image stays bigger than a small one. Each panel's wanted
// area is its own pixel area times its Size multiplier squared.
//
// Gaps and borders keep it exact: every subtree's outer width is an affine
// function of its outer height, w = A*h + B, which composes through both kinds
// of node (see mosaicFit), so placement can solve each split precisely.

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// {A, B} with outer width = A * outer height + B. `memo` (a Map) lets
// mosaicPlace reuse every subtree's fit instead of recomputing it per level.
function mosaicFit(node, aspects, gap, bw, memo) {
  if (memo && memo.has(node)) return memo.get(node);
  let f;
  if (node.leaf !== undefined) {
    const a = aspects[node.leaf];
    f = { A: a, B: 2 * bw * (1 - a) };
  } else {
    const f1 = mosaicFit(node.a, aspects, gap, bw, memo);
    const f2 = mosaicFit(node.b, aspects, gap, bw, memo);
    if (node.dir === 'h') {
      f = { A: f1.A + f2.A, B: f1.B + f2.B + gap };
    } else {
      // 'v': h = h1 + gap + h2 with hi = (w - Bi) / Ai, solved back for w.
      const k = 1 / f1.A + 1 / f2.A;
      const c = gap - f1.B / f1.A - f2.B / f2.A;
      f = { A: 1 / k, B: -c / k };
    }
  }
  if (memo) memo.set(node, f);
  return f;
}

// Fills out[leaf] with the outer box of every leaf inside the box x,y,w,h.
function mosaicPlace(node, x, y, w, h, aspects, gap, bw, out, memo = new Map()) {
  if (node.leaf !== undefined) { out[node.leaf] = { x, y, w, h }; return; }
  const f1 = mosaicFit(node.a, aspects, gap, bw, memo);
  if (node.dir === 'h') {
    const w1 = f1.A * h + f1.B;
    mosaicPlace(node.a, x, y, w1, h, aspects, gap, bw, out, memo);
    mosaicPlace(node.b, x + w1 + gap, y, w - w1 - gap, h, aspects, gap, bw, out, memo);
  } else {
    const h1 = (w - f1.B) / f1.A;
    mosaicPlace(node.a, x, y, w, h1, aspects, gap, bw, out, memo);
    mosaicPlace(node.b, x, y + h1 + gap, w, h - h1 - gap, aspects, gap, bw, out, memo);
  }
}

// Lower is better. Scored without gap/border so it is cheap and the chosen
// arrangement doesn't jump around while the Gap slider is dragged. The size
// term is the spread of log(actual area / wanted area): 0 when every panel got
// the same scale factor, whatever that factor is.
function mosaicScore(tree, aspects, want, target) {
  const memo = new Map();
  const { A } = mosaicFit(tree, aspects, 0, 0, memo);
  const boxes = [];
  mosaicPlace(tree, 0, 0, A, 1, aspects, 0, 0, boxes, memo);
  const logs = boxes.map((b, i) => Math.log(b.w * b.h / want[i]));
  const mean = logs.reduce((s, v) => s + v, 0) / logs.length;
  const spread = Math.sqrt(logs.reduce((s, v) => s + (v - mean) ** 2, 0) / logs.length);
  const off = Math.abs(Math.log(A / (target || 1)));
  // Auto: any shape from 16:10 landscape to 10:16 portrait is fine; beyond that it costs.
  const shape = target ? off : Math.max(0, off - Math.log(1.6));
  return 2 * shape + spread;
}

// Random tree over items (leaf indices, in order), steered towards aspect target T.
function mosaicRandomTree(items, T, aspects, want, rnd) {
  if (items.length === 1) return { leaf: items[0] };
  const n = items.length;
  // A row of everything has aspect sum(a); a column 1/sum(1/a). Split side by
  // side more often when the target leans towards the row's shape.
  const row = items.reduce((s, i) => s + aspects[i], 0);
  const col = 1 / items.reduce((s, i) => s + 1 / aspects[i], 0);
  const lean = Math.log(T / Math.sqrt(row * col)) / (Math.log(row / col) / 2 || 1);
  const pH = Math.min(0.9, Math.max(0.1, 0.5 + lean / 2));
  const dir = rnd() < pH ? 'h' : 'v';
  // Split where the wanted area runs past a random point in the middle half,
  // so a big panel tends to get a side of the cut to itself.
  const total = items.reduce((s, i) => s + want[i], 0);
  const cut = total * (0.25 + 0.5 * rnd());
  let k = 0, acc = 0;
  while (k < n - 1 && acc + want[items[k]] / 2 < cut) acc += want[items[k++]];
  k = Math.max(1, k);
  const f = items.slice(0, k).reduce((s, i) => s + want[i], 0) / total;
  const T1 = dir === 'h' ? T * f : T / f;
  const T2 = dir === 'h' ? T * (1 - f) : T / (1 - f);
  return {
    dir,
    a: mosaicRandomTree(items.slice(0, k), T1, aspects, want, rnd),
    b: mosaicRandomTree(items.slice(k), T2, aspects, want, rnd),
  };
}

function cloneTree(t) {
  return t.leaf !== undefined ? { leaf: t.leaf } : { dir: t.dir, a: cloneTree(t.a), b: cloneTree(t.b) };
}
function treeNodes(t, out = []) {
  out.push(t);
  if (t.leaf === undefined) { treeNodes(t.a, out); treeNodes(t.b, out); }
  return out;
}
function treeLeaves(t) { return treeNodes(t).filter(x => x.leaf !== undefined).map(x => x.leaf); }

function mosaicSearch(aspects, want, target, keepOrder, seed) {
  const n = aspects.length;
  const rnd = mulberry32(seed * 2654435761);
  const T = target || 1;
  let best = null, bestScore = Infinity;
  const consider = (t) => {
    const sc = mosaicScore(t, aspects, want, target);
    if (sc < bestScore) { best = t; bestScore = sc; }
    return sc;
  };
  // Random restarts, then hill-climb the winner.
  const order = [...Array(n).keys()];
  const restarts = Math.max(200, Math.min(3000, Math.round(40000 / n)));
  for (let r = 0; r < restarts; r++) {
    if (!keepOrder) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    consider(mosaicRandomTree(order, T, aspects, want, rnd));
  }
  const climbs = Math.max(1500, Math.min(6000, Math.round(200000 / n)));
  for (let c = 0; c < climbs; c++) {
    const t = cloneTree(best);
    const nodes = treeNodes(t);
    const inner = nodes.filter(x => x.leaf === undefined);
    const leaves = nodes.filter(x => x.leaf !== undefined);
    const m = rnd() * (keepOrder ? 0.6 : 1);   // order fixed: only re-roll and flip apply
    if (m < 0.3 && inner.length > 1) {
      // Re-roll one subtree over the same panels, aimed at the shape it has now.
      const x = inner[1 + Math.floor(rnd() * (inner.length - 1))];
      const items = treeLeaves(x);
      if (!keepOrder) {
        for (let i = items.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [items[i], items[j]] = [items[j], items[i]];
        }
      }
      Object.assign(x, mosaicRandomTree(items, mosaicFit(x, aspects, 0, 0).A, aspects, want, rnd));
    } else if (m < 0.6 && inner.length) {
      const x = inner[Math.floor(rnd() * inner.length)];
      x.dir = x.dir === 'h' ? 'v' : 'h';
    } else if (m < 0.8 && inner.length) {
      // Swap a node's children: mirrors that part, keeps the multiset of panels
      // (only allowed when order is free, as it reverses their sequence).
      if (keepOrder) continue;
      const x = inner[Math.floor(rnd() * inner.length)];
      [x.a, x.b] = [x.b, x.a];
    } else {
      if (keepOrder || leaves.length < 2) continue;
      const i = Math.floor(rnd() * leaves.length);
      const j = Math.floor(rnd() * leaves.length);
      [leaves[i].leaf, leaves[j].leaf] = [leaves[j].leaf, leaves[i].leaf];
    }
    consider(t);
  }
  return best;
}

// The search is a few ms, but filter sliders redraw on every input event -
// keep the tree until something that changes the arrangement changes.
let mosaicCache = { key: '', tree: null };

function mosaicLayout() {
  const n = S.panels.length;
  const gap = Math.max(0, S.gap);
  const bw = Math.max(0, S.borderW);
  const aspects = S.panels.map(p => p.w / p.h);
  const want = S.panels.map(p => p.w * p.h * (p.size || 1) ** 2);
  const target = S.mosaicShape === 'auto' ? null : parseFloat(S.mosaicShape);
  const key = [S.panels.map(p => `${p.id}:${p.w}x${p.h}x${p.size || 1}`).join(','),
               S.mosaicShape, S.mosaicKeepOrder, S.mosaicSeed].join('|');
  if (mosaicCache.key !== key) {
    mosaicCache = { key, tree: mosaicSearch(aspects, want, target, S.mosaicKeepOrder, S.mosaicSeed) };
  }
  const tree = mosaicCache.tree;
  const { A, B } = mosaicFit(tree, aspects, gap, bw);

  // Scale: the typical panel lands at its wanted size (geometric mean of
  // actual/wanted area = 1), so 1x panels sit near their native resolution.
  // The long side is capped to keep exports sane.
  const unit = [];
  mosaicPlace(tree, 0, 0, mosaicFit(tree, aspects, 0, 0).A, 1, aspects, 0, 0, unit);
  const meanLog = unit.reduce((s, b, i) => s + Math.log(b.w * b.h / want[i]), 0) / n;
  let H = Math.exp(-meanLog / 2);
  const MAX_SIDE = 8000;
  H = Math.min(H, MAX_SIDE, (MAX_SIDE - B) / A);
  H = Math.max(H, 2 * bw + n * (gap + 2 * bw) + 10);
  const W = A * H + B;

  // Snap the edges to whole pixels: neighbours share an edge value, so both
  // round to the same column and no background seam shows between them.
  const totalW = Math.round(W), totalH = Math.round(H);
  const boxes = [];
  mosaicPlace(tree, 0, 0, totalW, totalH, aspects, gap, bw, boxes);
  const positions = boxes.map(b => {
    const x0 = Math.round(b.x), y0 = Math.round(b.y);
    const x1 = Math.round(b.x + b.w), y1 = Math.round(b.y + b.h);
    return { x: x0 + bw, y: y0 + bw, w: x1 - x0 - 2 * bw, h: y1 - y0 - 2 * bw };
  });
  return { totalW, totalH, positions };
}

// ---------- Layout ----------

// Returns { totalW, totalH, positions: Array<{x, y, w, h}> }.
// x/y/w/h are INSIDE the border (border is drawn outward around them).
function computeLayout() {
  const dims = scaledDims();
  const gap = Math.max(0, S.gap);
  const bw = Math.max(0, S.borderW);
  const n = dims.length;
  if (n === 0) return { totalW: 1, totalH: 1, positions: [] };
  if (S.layout === 'mosaic') return mosaicLayout();
  const outer = d => ({ w: d.w + bw * 2, h: d.h + bw * 2 });

  if (S.layout === 'stack') {
    const maxOuterW = Math.max(...dims.map(d => outer(d).w));
    let y = 0;
    const positions = dims.map(d => {
      const o = outer(d);
      const dx = S.align === 'start' ? 0
               : S.align === 'end'   ? maxOuterW - o.w
               :                       (maxOuterW - o.w) / 2;
      const pos = { x: dx + bw, y: y + bw, w: d.w, h: d.h };
      y += o.h + gap;
      return pos;
    });
    return { totalW: maxOuterW, totalH: y - gap, positions };
  }

  if (S.layout === 'row') {
    const maxOuterH = Math.max(...dims.map(d => outer(d).h));
    let x = 0;
    const positions = dims.map(d => {
      const o = outer(d);
      const dy = S.align === 'start' ? 0
               : S.align === 'end'   ? maxOuterH - o.h
               :                       (maxOuterH - o.h) / 2;
      const pos = { x: x + bw, y: dy + bw, w: d.w, h: d.h };
      x += o.w + gap;
      return pos;
    });
    return { totalW: x - gap, totalH: maxOuterH, positions };
  }

  // grid — flow left-to-right, wrap every S.gridCols. Column widths are the
  // max across a column; row heights the max across a row. Each cell is
  // aligned within its column-width × row-height box by S.align.
  const cols = Math.max(1, Math.floor(S.gridCols));
  const rows = Math.ceil(n / cols);
  const colWidths = new Array(cols).fill(0);
  const rowHeights = new Array(rows).fill(0);
  for (let i = 0; i < n; i++) {
    const o = outer(dims[i]);
    const c = i % cols;
    const r = Math.floor(i / cols);
    colWidths[c] = Math.max(colWidths[c], o.w);
    rowHeights[r] = Math.max(rowHeights[r], o.h);
  }
  const positions = new Array(n);
  let y = 0;
  for (let r = 0; r < rows; r++) {
    let x = 0;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i < n) {
        const d = dims[i];
        const o = outer(d);
        const dx = S.align === 'start' ? 0
                 : S.align === 'end'   ? colWidths[c] - o.w
                 :                       (colWidths[c] - o.w) / 2;
        const dy = S.align === 'start' ? 0
                 : S.align === 'end'   ? rowHeights[r] - o.h
                 :                       (rowHeights[r] - o.h) / 2;
        positions[i] = { x: x + dx + bw, y: y + dy + bw, w: d.w, h: d.h };
      }
      x += colWidths[c] + gap;
    }
    y += rowHeights[r] + gap;
  }
  const totalW = colWidths.reduce((a, b) => a + b, 0) + gap * (cols - 1);
  const totalH = rowHeights.reduce((a, b) => a + b, 0) + gap * (rows - 1);
  return { totalW, totalH, positions };
}

// Draw a panel's image with its filters. Pixelate isn't a CSS filter, so it's
// done first on a scratch canvas at the rendered size; the rest go through
// ctx.filter (drop-shadow can then spill into the gutter, as it should).
function drawPanelImage(c, p, x, y, w, h) {
  const f = p.filters || {};
  let src = p.img;
  if (f.pixelate > 0) {
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.round(w)); tmp.height = Math.max(1, Math.round(h));
    tmp.getContext('2d').drawImage(p.img, 0, 0, tmp.width, tmp.height);
    pixelateCanvas(tmp, f.pixelate);
    src = tmp;
  }
  c.filter = filterString(f);
  c.drawImage(src, x, y, w, h);
  c.filter = 'none';
}

function layoutAndDraw() {
  const { totalW, totalH, positions } = computeLayout();
  const W = Math.max(1, Math.round(totalW));
  const H = Math.max(1, Math.round(totalH));
  canvas.width = W;
  canvas.height = H;
  ctx.fillStyle = S.bg;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < S.panels.length; i++) {
    const p = S.panels[i];
    const pos = positions[i];
    drawPanelImage(ctx, p, pos.x, pos.y, pos.w, pos.h);
    if (S.borderW > 0) {
      ctx.strokeStyle = S.borderColor;
      ctx.lineWidth = S.borderW;
      // Stroke centred half a border-width out, so it fills exactly the bw
      // ring the layout reserved around the image and covers none of it.
      const bw = S.borderW;
      ctx.strokeRect(pos.x - bw / 2, pos.y - bw / 2, pos.w + bw, pos.h + bw);
    }
  }
  const info = S.panels.length === 0
    ? 'no panels yet'
    : `${W} × ${H} px · ${S.panels.length} panel${S.panels.length === 1 ? '' : 's'}`;
  document.getElementById('dims-out').textContent = info;
  stage.classList.toggle('empty', S.panels.length === 0);
}

// ---------- Panel list UI ----------

function makeThumb(p, size = 44) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const cctx = c.getContext('2d');
  const scale = Math.min(size / p.w, size / p.h);
  const tw = p.w * scale, th = p.h * scale;
  drawPanelImage(cctx, p, (size - tw) / 2, (size - th) / 2, tw, th);
  return c;
}

function renderPanelList() {
  const list = document.getElementById('panel-list');
  list.innerHTML = '';
  if (S.panels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cp-empty';
    empty.textContent = 'No panels yet.';
    list.appendChild(empty);
    return;
  }
  S.panels.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'cp-row';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'thumb-wrap';
    thumbWrap.appendChild(makeThumb(p));

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name'; name.textContent = p.name; name.title = p.name;
    const dims = document.createElement('div');
    dims.className = 'dims'; dims.textContent = `${p.w} × ${p.h}`;
    meta.appendChild(name); meta.appendChild(dims);
    if (S.layout === 'mosaic') {
      const size = document.createElement('select');
      size.className = 'cp-size';
      size.title = 'How big this panel should be in the mosaic, relative to its own pixel size';
      for (const [v, label] of [[0.5, '½× smaller'], [1, '1× size'], [1.5, '1.5× bigger'],
                                [2, '2× bigger'], [3, '3× bigger'], [4, '4× bigger']]) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label; o.selected = (p.size || 1) === v;
        size.appendChild(o);
      }
      size.addEventListener('change', () => { p.size = parseFloat(size.value); layoutAndDraw(); });
      meta.appendChild(size);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    const btn = (label, title, fn, disabled = false) => {
      const b = document.createElement('button');
      b.className = 'ghost small'; b.textContent = label; b.title = title;
      if (disabled) b.disabled = true;
      b.addEventListener('click', fn);
      return b;
    };
    const fxBtn = btn('🎨', 'Filters for this panel', () => { p.fxOpen = !p.fxOpen; renderPanelList(); });
    fxBtn.classList.toggle('active-mode', p.fxOpen || filterString(p.filters) !== 'none' || p.filters.pixelate > 0);
    actions.appendChild(fxBtn);
    actions.appendChild(btn('↑', 'Move up', () => move(i, -1), i === 0));
    actions.appendChild(btn('↓', 'Move down', () => move(i, 1), i === S.panels.length - 1));
    actions.appendChild(btn('✕', 'Remove', () => remove(i)));

    row.appendChild(thumbWrap);
    row.appendChild(meta);
    row.appendChild(actions);
    list.appendChild(row);

    if (p.fxOpen) {
      const fx = document.createElement('div');
      fx.className = 'fx-controls cp-fx';
      makeFilterPanel(fx, () => p.filters, () => {
        layoutAndDraw();
        thumbWrap.replaceChildren(makeThumb(p));
        fxBtn.classList.add('active-mode');
      });
      list.appendChild(fx);
    }
  });
}

function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= S.panels.length) return;
  [S.panels[i], S.panels[j]] = [S.panels[j], S.panels[i]];
  renderPanelList(); layoutAndDraw();
}
function remove(i) {
  S.panels.splice(i, 1);
  renderPanelList(); layoutAndDraw();
}

// ---------- Controls ----------

document.getElementById('file-add').addEventListener('change', async (e) => {
  await handleFiles(e.target.files);
  e.target.value = '';
});

const LAYOUTS = ['stack', 'row', 'grid', 'mosaic'];
LAYOUTS.forEach(m => {
  document.getElementById('lay-' + m).addEventListener('click', () => {
    S.layout = m;
    LAYOUTS.forEach(x =>
      document.getElementById('lay-' + x).classList.toggle('active-mode', x === m));
    document.getElementById('grid-cols-row').classList.toggle('hidden', m !== 'grid');
    document.getElementById('mosaic-opts').classList.toggle('hidden', m !== 'mosaic');
    // Mosaic picks every panel's size itself; the per-panel Size picker steers it.
    document.getElementById('sizing-panel').classList.toggle('hidden', m === 'mosaic');
    renderPanelList();
    layoutAndDraw();
  });
});
document.getElementById('mosaic-shape').addEventListener('change', (e) => {
  S.mosaicShape = e.target.value; layoutAndDraw();
});
document.getElementById('mosaic-keep-order').addEventListener('change', (e) => {
  S.mosaicKeepOrder = e.target.checked; layoutAndDraw();
});
document.getElementById('mosaic-shuffle').addEventListener('click', () => {
  S.mosaicSeed++; layoutAndDraw();
});
document.getElementById('grid-cols').addEventListener('input', (e) => {
  S.gridCols = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1));
  layoutAndDraw();
});
document.getElementById('sizing').addEventListener('change', (e) => {
  S.sizing = e.target.value; layoutAndDraw();
});
document.getElementById('align').addEventListener('change', (e) => {
  S.align = e.target.value; layoutAndDraw();
});
document.getElementById('gap').addEventListener('input', (e) => {
  S.gap = Math.max(0, Math.min(200, parseInt(e.target.value, 10) || 0)); layoutAndDraw();
});
document.getElementById('bg').addEventListener('input', (e) => {
  S.bg = e.target.value; layoutAndDraw();
});
document.getElementById('border-w').addEventListener('input', (e) => {
  S.borderW = Math.max(0, Math.min(40, parseInt(e.target.value, 10) || 0)); layoutAndDraw();
});
document.getElementById('border-color').addEventListener('input', (e) => {
  S.borderColor = e.target.value; layoutAndDraw();
});

document.getElementById('btn-clear').addEventListener('click', () => {
  if (S.panels.length === 0) return;
  if (!window.confirm('Remove all panels?')) return;
  S.panels = [];
  renderPanelList(); layoutAndDraw();
});

// ---------- Drag-and-drop onto the page ----------

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  stage.classList.add('drop-hover');
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) stage.classList.remove('drop-hover');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  stage.classList.remove('drop-hover');
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) await handleFiles(files);
});

// ---------- Paste ----------

window.addEventListener('paste', async (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const blobs = [];
  for (const it of items) {
    if (it.kind === 'file' && /^image\//.test(it.type)) blobs.push(it.getAsFile());
  }
  if (blobs.length) {
    e.preventDefault();
    for (const b of blobs) await addPanelFromBlob(b, 'pasted');
  }
});

// ---------- Export / copy ----------

function toBlob() {
  return new Promise(res => canvas.toBlob(res, 'image/png'));
}

document.getElementById('btn-export').addEventListener('click', async () => {
  if (S.panels.length === 0) return;
  const blob = await toBlob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'combined-' + Date.now() + '.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

document.getElementById('btn-copy').addEventListener('click', async () => {
  if (S.panels.length === 0) return;
  try {
    const blob = await toBlob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    const b = document.getElementById('btn-copy');
    const old = b.textContent; b.textContent = '✓ Copied';
    setTimeout(() => { b.textContent = old; }, 1200);
  } catch (err) {
    console.error(err);
    const b = document.getElementById('btn-copy');
    const old = b.textContent; b.textContent = 'Copy failed';
    setTimeout(() => { b.textContent = old; }, 1400);
  }
  // Into the editor's meme history too, even if the clipboard write was refused.
  try { await addImageHistory(canvas, `Combined (${S.panels.length} panel${S.panels.length === 1 ? '' : 's'})`); }
  catch (err) { console.error(err); }
});

// Initial render.
renderPanelList();
layoutAndDraw();

initMobileShell();
