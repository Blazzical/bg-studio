// BG Studio Combiner — stitch multiple images into one meme.
//
// State:
//   S.panels        Array<{ id, img, name, w, h, filters, fxOpen }>   ordered top-to-bottom or left-to-right
//                   filters: per-panel filter params (see filterString); fxOpen: its filter panel is expanded
//   S.layout        'stack' | 'row' | 'grid'
//   S.gridCols      integer, cols for grid layout
//   S.sizing        'orig' | 'matchWidest' | 'matchNarrowest' | 'matchTallest' | 'matchShortest'
//   S.align         'start' | 'center' | 'end'   (cross-axis alignment for uneven panels)
//   S.gap           px between panels
//   S.bg            fill colour (canvas + gutter)
//   S.borderW       per-panel border width
//   S.borderColor   per-panel border colour

import { filterString, pixelateCanvas } from './engine/filters.js';
import { makeFilterPanel } from './engine/filter-panel.js';

const S = {
  panels: [],
  layout: 'stack',
  gridCols: 2,
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
      filters: {}, fxOpen: false,
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

// ---------- Layout ----------

// Returns { totalW, totalH, positions: Array<{x, y, w, h}> }.
// x/y/w/h are INSIDE the border (border is drawn outward around them).
function computeLayout() {
  const dims = scaledDims();
  const gap = Math.max(0, S.gap);
  const bw = Math.max(0, S.borderW);
  const n = dims.length;
  if (n === 0) return { totalW: 1, totalH: 1, positions: [] };
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
      // Center-line stroke, so half sits inside and half outside the image
      // rectangle. Compensate the border in cross-axis alignment above.
      ctx.strokeRect(pos.x, pos.y, pos.w, pos.h);
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

['stack', 'row', 'grid'].forEach(m => {
  document.getElementById('lay-' + m).addEventListener('click', () => {
    S.layout = m;
    ['stack', 'row', 'grid'].forEach(x =>
      document.getElementById('lay-' + x).classList.toggle('active-mode', x === m));
    document.getElementById('grid-cols-row').classList.toggle('hidden', m !== 'grid');
    layoutAndDraw();
  });
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
});

// Initial render.
renderPanelList();
layoutAndDraw();
