// BG Studio — local meme generator + background remover.
// Background removal runs fully in-browser via @imgly/background-removal (WASM/ONNX).
import { removeBackground } from 'https://esm.sh/@imgly/background-removal@1.5.5';

// ---------- State ----------
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

const state = {
  w: 800, h: 600,
  fill: '#ffffff',
  transparent: false,
  bg: null,          // { img } background image drawn to fill canvas
  layers: [],        // draw order: last = top
  selectedId: null,
  nextId: 1,
  edgeHover: null,   // which canvas edge ('n'/'s'/'e'/'w' combos) the cursor is near, for the crop affordance
};

function syncCanvasInputs() {
  document.getElementById('canvas-w').value = state.w;
  document.getElementById('canvas-h').value = state.h;
}

function uid() { return state.nextId++; }
function selected() { return state.layers.find(l => l.id === state.selectedId) || null; }

// Brush tool state. Operates on the selected image/paint layer's backing canvas.
const brush = {
  active: false,
  mode: 'paint',     // 'paint' = lay down colour (source-over) | 'erase' = rub out (destination-out)
  shape: 'circle',   // 'circle' | 'square'
  size: 40,          // diameter in canvas px
  feather: 8,        // soft-edge blur in canvas px
  color: '#ff3b3b',
  cursor: null,      // [x,y] preview position in canvas coords
};

// ---------- Geometry helpers ----------
function rot(x, y, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}
// half extents of a layer in canvas pixels (after its scale)
function halfExtents(l) { return [l.w * l.scale / 2, l.h * l.scale / 2]; }

function corners(l) {
  const [hw, hh] = halfExtents(l);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const [dx, dy] = rot(sx * hw, sy * hh, l.rotation);
    return [l.cx + dx, l.cy + dy];
  });
}
function rotateHandlePos(l) {
  const [, hh] = halfExtents(l);
  const [dx, dy] = rot(0, -(hh + 26), l.rotation);
  return [l.cx + dx, l.cy + dy];
}
// world point -> layer-local (un-rotated, un-scaled-to-base) coords
function toLocal(l, px, py) {
  const [lx, ly] = rot(px - l.cx, py - l.cy, -l.rotation);
  return [lx, ly];
}
function hitLayer(l, px, py) {
  const [lx, ly] = toLocal(l, px, py);
  const [hw, hh] = halfExtents(l);
  return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
}

// Map a canvas-space point to a pixel coordinate inside a layer's backing canvas,
// undoing its rotation, scale and horizontal flip.
function canvasToImagePx(l, px, py) {
  let [lx, ly] = rot(px - l.cx, py - l.cy, -l.rotation);
  if (l.flipH) lx = -lx;
  return [lx / l.scale + l.w / 2, ly / l.scale + l.h / 2];
}

// Stamp the brush once at an image-pixel coordinate.
function brushStamp(l, ix, iy) {
  const wctx = l.work.getContext('2d');
  const r = (brush.size / 2) / l.scale;
  const fb = brush.feather / l.scale;
  wctx.save();
  wctx.globalCompositeOperation = brush.mode === 'erase' ? 'destination-out' : 'source-over';
  if (fb > 0) wctx.filter = `blur(${fb.toFixed(2)}px)`;
  wctx.fillStyle = brush.mode === 'erase' ? '#000' : brush.color;
  wctx.beginPath();
  if (brush.shape === 'square') wctx.rect(ix - r, iy - r, r * 2, r * 2);
  else wctx.arc(ix, iy, r, 0, Math.PI * 2);
  wctx.fill();
  wctx.restore();
}

// Stamp along a segment so dragging makes a continuous stroke.
function stampLine(l, x0, y0, x1, y1) {
  const stepC = Math.max(1, (brush.size / 2) * 0.25);
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(dist / stepC));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const cx = x0 + (x1 - x0) * t, cy = y0 + (y1 - y0) * t;
    const [ix, iy] = canvasToImagePx(l, cx, cy);
    brushStamp(l, ix, iy);
  }
}

// ---------- Text measuring ----------
function fontString(l) {
  return `${l.fontSize}px ${l.font}`;
}
function measureText(l) {
  ctx.save();
  ctx.font = fontString(l);
  const txt = l.upper ? l.text.toUpperCase() : l.text;
  const lines = txt.split('\n');
  let maxW = 1;
  for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln || ' ').width);
  ctx.restore();
  const lineH = l.fontSize * 1.15;
  l.w = maxW + l.strokeW * 2 + 8;
  l.h = lineH * lines.length + l.strokeW * 2 + 4;
  l._lines = lines;
  l._lineH = lineH;
}

// ---------- Drawing ----------
function drawLayer(c, l) {
  c.save();
  c.globalAlpha = l.opacity;
  c.translate(l.cx, l.cy);
  c.rotate(l.rotation);
  if (l.flipH) c.scale(-1, 1);
  if (l.type === 'image' && l.img) {
    const w = l.w * l.scale, h = l.h * l.scale;
    c.drawImage(l.img, -w / 2, -h / 2, w, h);
  } else if (l.type === 'text') {
    c.scale(l.scale, l.scale);
    c.font = fontString(l);
    const align = l.align || 'center';
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    const lines = l._lines || [l.text];
    const lineH = l._lineH || l.fontSize * 1.15;
    const totalH = lineH * lines.length;
    const pad = l.strokeW + 4;
    const ax = align === 'left' ? -l.w / 2 + pad : align === 'right' ? l.w / 2 - pad : 0;
    lines.forEach((ln, i) => {
      const y = -totalH / 2 + lineH * (i + 0.5);
      if (l.strokeW > 0) {
        c.strokeStyle = l.stroke;
        c.lineWidth = l.strokeW;
        c.strokeText(ln, ax, y);
      }
      c.fillStyle = l.color;
      c.fillText(ln, ax, y);
    });
  } else if (l.type === 'table') {
    c.scale(l.scale, l.scale);
    c.translate(-l.w / 2, -l.h / 2);
    drawTable(c, l);
  }
  c.restore();
}

function composite(c) {
  c.clearRect(0, 0, state.w, state.h);
  if (!state.transparent) {
    c.fillStyle = state.fill;
    c.fillRect(0, 0, state.w, state.h);
  }
  if (state.bg && state.bg.img) {
    c.drawImage(state.bg.img, 0, 0, state.w, state.h);
  }
  for (const l of state.layers) drawLayer(c, l);
}

function drawHandles(l) {
  const cs = corners(l);
  ctx.save();
  ctx.strokeStyle = '#6d8bff';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(cs[0][0], cs[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(cs[i][0], cs[i][1]);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  // rotate handle stem
  const rp = rotateHandlePos(l);
  const topMid = [(cs[0][0] + cs[1][0]) / 2, (cs[0][1] + cs[1][1]) / 2];
  ctx.beginPath();
  ctx.moveTo(topMid[0], topMid[1]);
  ctx.lineTo(rp[0], rp[1]);
  ctx.stroke();
  // corner squares
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#4f6cf0';
  for (const [x, y] of cs) {
    ctx.beginPath();
    ctx.rect(x - 5, y - 5, 10, 10);
    ctx.fill(); ctx.stroke();
  }
  // rotate circle
  ctx.beginPath();
  ctx.arc(rp[0], rp[1], 6, 0, Math.PI * 2);
  ctx.fillStyle = '#6d8bff';
  ctx.fill();
  ctx.restore();
}

function drawBrushPreview() {
  const [cx, cy] = brush.cursor;
  const r = brush.size / 2;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = brush.mode === 'erase' ? '#ff6b6b' : '#ffffff';
  if (brush.shape === 'square') ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
  else { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
}

function drawTableSelection(l) {
  if (!l.sel) return;
  const [r0, c0, r1, c1] = selBounds(l);
  const box = [
    [c0 * l.cellW, r0 * l.cellH], [(c1 + 1) * l.cellW, r0 * l.cellH],
    [(c1 + 1) * l.cellW, (r1 + 1) * l.cellH], [c0 * l.cellW, (r1 + 1) * l.cellH],
  ].map(([bx, by]) => tableBaseToCanvas(l, bx, by));
  ctx.save();
  ctx.strokeStyle = '#6d8bff';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(box[0][0], box[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(box[i][0], box[i][1]);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawEdgeHover(edge) {
  ctx.save();
  ctx.strokeStyle = '#6d8bff';
  ctx.lineWidth = 4;
  ctx.setLineDash([]);
  const w = state.w, h = state.h, o = 2;
  ctx.beginPath();
  if (edge.includes('n')) { ctx.moveTo(0, o); ctx.lineTo(w, o); }
  if (edge.includes('s')) { ctx.moveTo(0, h - o); ctx.lineTo(w, h - o); }
  if (edge.includes('w')) { ctx.moveTo(o, 0); ctx.lineTo(o, h); }
  if (edge.includes('e')) { ctx.moveTo(w - o, 0); ctx.lineTo(w - o, h); }
  ctx.stroke();
  ctx.restore();
}

function draw() {
  composite(ctx);
  const l = selected();
  if (l && !brush.active) drawHandles(l);
  if (l && l.type === 'table' && !brush.active) drawTableSelection(l);
  if (brush.active && brush.cursor) drawBrushPreview();
  const eh = (drag && drag.mode === 'canvasResize') ? drag.edge : state.edgeHover;
  if (eh && !brush.active) drawEdgeHover(eh);
}

// Some Firefox GPU drivers leave an accelerated canvas blank until the next
// composited frame. After an async image load, force fresh frames so the newly
// drawn pixels actually present.
function repaintSoon() {
  requestAnimationFrame(() => { draw(); requestAnimationFrame(draw); });
}

function resizeCanvas() {
  canvas.width = state.w;
  canvas.height = state.h;
  draw();
}

// ---------- Pointer interaction ----------
function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return [
    (e.clientX - r.left) * (canvas.width / r.width),
    (e.clientY - r.top) * (canvas.height / r.height),
  ];
}
function near(ax, ay, bx, by, d) {
  return Math.hypot(ax - bx, ay - by) <= d;
}

// Which canvas edge(s) the point is hovering near, as a string of 'n','s','e','w'
// (corners combine, e.g. 'ne'). Returns null when away from any edge. The band is
// ~9 screen px wide, converted into canvas pixels.
function canvasEdgeAt(px, py) {
  const r = canvas.getBoundingClientRect();
  const T = 9 * (canvas.width / Math.max(1, r.width));
  const w = state.w, h = state.h;
  const inX = px >= -T && px <= w + T;
  const inY = py >= -T && py <= h + T;
  let edge = '';
  if (py >= -T && py <= T && inX) edge += 'n';
  if (py >= h - T && py <= h + T && inX) edge += 's';
  if (px >= -T && px <= T && inY) edge += 'w';
  if (px >= w - T && px <= w + T && inY) edge += 'e';
  // Drop contradictory pairs on a tiny canvas (can't be on both top and bottom).
  if (edge.includes('n') && edge.includes('s')) edge = edge.replace(py < h / 2 ? 's' : 'n', '');
  if (edge.includes('w') && edge.includes('e')) edge = edge.replace(px < w / 2 ? 'e' : 'w', '');
  return edge || null;
}
function edgeCursor(edge) {
  if (edge === 'nw' || edge === 'se') return 'nwse-resize';
  if (edge === 'ne' || edge === 'sw') return 'nesw-resize';
  if (edge === 'n' || edge === 's') return 'ns-resize';
  if (edge === 'e' || edge === 'w') return 'ew-resize';
  return 'default';
}

// Crop (or extend) the canvas to the selected layer's axis-aligned bounding box,
// shifting every layer so that box lands at the canvas origin.
function cropToLayer() {
  const l = selected();
  if (!l) { flashToast('Select a layer to crop to'); return; }
  const cs = corners(l);
  const xs = cs.map(c => c[0]), ys = cs.map(c => c[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const newW = clampInt(Math.round(Math.max(...xs) - minX), 16, 8000);
  const newH = clampInt(Math.round(Math.max(...ys) - minY), 16, 8000);
  for (const ly of state.layers) { ly.cx -= minX; ly.cy -= minY; }
  state.w = newW; state.h = newH;
  syncCanvasInputs();
  resizeCanvas();
}

let drag = null; // { mode, startX, startY, layer, ... }

canvas.addEventListener('pointerdown', (e) => {
  const [px, py] = canvasPoint(e);
  // Brush mode: paint/erase onto the selected image/paint layer.
  if (brush.active) {
    let bl = selected();
    if (!bl || bl.type !== 'image') {
      for (let i = state.layers.length - 1; i >= 0; i--) {
        if (state.layers[i].type === 'image' && hitLayer(state.layers[i], px, py)) {
          bl = state.layers[i]; selectLayer(bl.id); break;
        }
      }
    }
    if (!bl || bl.type !== 'image') { flashToast('Select an image or paint layer to brush on'); return; }
    drag = { mode: 'brush', layer: bl, lastX: px, lastY: py };
    canvas.setPointerCapture(e.pointerId);
    stampLine(bl, px, py, px, py);
    brush.cursor = [px, py];
    draw();
    return;
  }
  const l = selected();
  // handle grabs take priority on the already-selected layer
  if (l) {
    const rp = rotateHandlePos(l);
    if (near(px, py, rp[0], rp[1], 11)) {
      drag = { mode: 'rotate', layer: l, startAngle: Math.atan2(py - l.cy, px - l.cx), startRot: l.rotation };
      canvas.setPointerCapture(e.pointerId); return;
    }
    const cs = corners(l);
    for (let i = 0; i < 4; i++) {
      if (near(px, py, cs[i][0], cs[i][1], 11)) {
        const distNow = Math.hypot(px - l.cx, py - l.cy);
        drag = { mode: 'scale', layer: l, startScale: l.scale, startDist: distNow || 1 };
        canvas.setPointerCapture(e.pointerId); return;
      }
    }
  }
  // canvas edge → crop/extend the canvas (mid-edge wins over moving a layer)
  const edge = canvasEdgeAt(px, py);
  if (edge) {
    const r = canvas.getBoundingClientRect();
    drag = {
      mode: 'canvasResize', edge,
      startClientX: e.clientX, startClientY: e.clientY,
      sx: canvas.width / Math.max(1, r.width), sy: canvas.height / Math.max(1, r.height),
      startW: state.w, startH: state.h,
      starts: state.layers.map(ly => ({ l: ly, cx: ly.cx, cy: ly.cy })),
    };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  // otherwise pick topmost layer under cursor
  let pick = null;
  for (let i = state.layers.length - 1; i >= 0; i--) {
    if (hitLayer(state.layers[i], px, py)) { pick = state.layers[i]; break; }
  }
  if (pick) {
    selectLayer(pick.id);
    if (pick.type === 'table') {
      const [bx, by] = canvasToImagePx(pick, px, py);
      const cc = Math.floor(bx / pick.cellW), rr = Math.floor(by / pick.cellH);
      if (rr >= 0 && cc >= 0 && rr < pick.rows && cc < pick.cols) {
        const [ar, ac] = anchorOf(pick, rr, cc);
        if (e.shiftKey && pick.sel) pick.sel.end = [ar, ac];
        else pick.sel = { start: [ar, ac], end: [ar, ac] };
        syncControls();
      }
    }
    drag = { mode: 'move', layer: pick, offX: px - pick.cx, offY: py - pick.cy };
    canvas.setPointerCapture(e.pointerId);
  } else {
    selectLayer(null);
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (brush.active) {
    const [bx, by] = canvasPoint(e);
    brush.cursor = [bx, by];
    if (drag && drag.mode === 'brush') {
      stampLine(drag.layer, drag.lastX, drag.lastY, bx, by);
      drag.lastX = bx; drag.lastY = by;
    }
    draw();
    return;
  }
  if (!drag) {
    // cursor affordance
    const [px, py] = canvasPoint(e);
    const l = selected();
    let cur = 'default';
    if (l) {
      const rp = rotateHandlePos(l);
      if (near(px, py, rp[0], rp[1], 11)) cur = 'grab';
      else if (corners(l).some(c => near(px, py, c[0], c[1], 11))) cur = 'nwse-resize';
    }
    let edge = null;
    if (cur === 'default') {
      edge = canvasEdgeAt(px, py);
      if (edge) cur = edgeCursor(edge);
      else if (l && hitLayer(l, px, py)) cur = 'move';
    }
    if (state.edgeHover !== edge) { state.edgeHover = edge; draw(); }
    canvas.style.cursor = cur;
    return;
  }
  if (drag.mode === 'canvasResize') {
    const dxC = (e.clientX - drag.startClientX) * drag.sx;
    const dyC = (e.clientY - drag.startClientY) * drag.sy;
    let w = drag.startW, h = drag.startH;
    if (drag.edge.includes('e')) w = drag.startW + dxC;
    if (drag.edge.includes('w')) w = drag.startW - dxC;
    if (drag.edge.includes('s')) h = drag.startH + dyC;
    if (drag.edge.includes('n')) h = drag.startH - dyC;
    w = Math.max(16, Math.min(8000, Math.round(w)));
    h = Math.max(16, Math.min(8000, Math.round(h)));
    // Dragging the top/left edge moves the origin, so shift content to compensate.
    const shiftX = drag.edge.includes('w') ? w - drag.startW : 0;
    const shiftY = drag.edge.includes('n') ? h - drag.startH : 0;
    for (const s of drag.starts) { s.l.cx = s.cx + shiftX; s.l.cy = s.cy + shiftY; }
    state.w = w; state.h = h;
    syncCanvasInputs();
    resizeCanvas();
    return;
  }
  const [px, py] = canvasPoint(e);
  const l = drag.layer;
  if (drag.mode === 'move') {
    l.cx = px - drag.offX;
    l.cy = py - drag.offY;
  } else if (drag.mode === 'scale') {
    const d = Math.hypot(px - l.cx, py - l.cy);
    l.scale = Math.max(0.02, drag.startScale * (d / drag.startDist));
  } else if (drag.mode === 'rotate') {
    const a = Math.atan2(py - l.cy, px - l.cx);
    let r = drag.startRot + (a - drag.startAngle);
    if (e.shiftKey) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12); // snap 15°
    l.rotation = r;
  }
  draw();
});

function endDrag(e) {
  if (drag) { try { canvas.releasePointerCapture(e.pointerId); } catch {} drag = null; }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => {
  if (brush.active) { brush.cursor = null; draw(); }
  if (state.edgeHover) { state.edgeHover = null; draw(); }
});

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (e.key === 'b' || e.key === 'B') { toggleBrush(); return; }
  if (brush.active && e.key === '[') { setBrushSize(brush.size - 4); return; }
  if (brush.active && e.key === ']') { setBrushSize(brush.size + 4); return; }
  const l = selected();
  if (!l) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteLayer(l.id); }
  else if (e.key === 'ArrowLeft') { l.cx -= e.shiftKey ? 10 : 1; draw(); }
  else if (e.key === 'ArrowRight') { l.cx += e.shiftKey ? 10 : 1; draw(); }
  else if (e.key === 'ArrowUp') { l.cy -= e.shiftKey ? 10 : 1; draw(); }
  else if (e.key === 'ArrowDown') { l.cy += e.shiftKey ? 10 : 1; draw(); }
});

// ---------- Layer ops ----------
// A backing canvas holding the layer's editable pixels (brush paints/erases onto this).
function makeWork(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

function addImageLayer(img, src, name) {
  const work = makeWork(img);
  // First image on an otherwise-empty canvas: size the canvas to the image and
  // drop it in at 1:1, filling the whole stage.
  const emptyCanvas = state.layers.length === 0 && !state.bg;
  let fit;
  if (emptyCanvas) {
    state.w = clampInt(work.width, 16, 8000);
    state.h = clampInt(work.height, 16, 8000);
    syncCanvasInputs();
    resizeCanvas();
    // scale stays 1 unless the image was larger than the max canvas (then fit it).
    fit = Math.min(state.w / work.width, state.h / work.height);
  } else {
    const max = Math.min(state.w, state.h) * 0.8;
    fit = Math.min(1, max / Math.max(work.width, work.height));
  }
  const l = {
    id: uid(), type: 'image', subtype: 'image', name: name || 'image',
    baseImg: img, work, img: work, src,
    w: work.width, h: work.height,
    cx: state.w / 2, cy: state.h / 2,
    scale: fit, rotation: 0, flipH: false, opacity: 1,
  };
  state.layers.push(l);
  selectLayer(l.id);
}

// A blank, transparent, full-canvas layer to use the brush as a general paintbrush.
function addPaintLayer() {
  const c = document.createElement('canvas');
  c.width = state.w; c.height = state.h;
  const l = {
    id: uid(), type: 'image', subtype: 'paint', name: 'paint',
    baseImg: null, work: c, img: c, src: null,
    w: c.width, h: c.height,
    cx: state.w / 2, cy: state.h / 2,
    scale: 1, rotation: 0, flipH: false, opacity: 1,
  };
  state.layers.push(l);
  selectLayer(l.id);
  if (!brush.active) toggleBrush(true);
}

// ---------- Tables ----------
function newCell() { return { text: '', bg: '#ffffff', fg: '', align: 'center', cspan: 1, rspan: 1 }; }

function tableResize(l) { l.w = l.cols * l.cellW; l.h = l.rows * l.cellH; }

function addTableLayer() {
  const rows = 3, cols = 3, cellW = 120, cellH = 44;
  const cells = Array.from({ length: rows }, () => Array.from({ length: cols }, newCell));
  const l = {
    id: uid(), type: 'table', name: 'table',
    rows, cols, cellW, cellH,
    borderW: 1, borderColor: '#333333',
    fontSize: 18, fontColor: '#111111', font: 'Arial, sans-serif',
    cells, sel: { start: [0, 0], end: [0, 0] },
    w: cols * cellW, h: rows * cellH,
    cx: state.w / 2, cy: state.h / 2,
    scale: 1, rotation: 0, flipH: false, opacity: 1,
  };
  state.layers.push(l);
  selectLayer(l.id);
}

// Which cells are hidden because a neighbour spans over them.
function computeCovered(l) {
  const cov = Array.from({ length: l.rows }, () => Array(l.cols).fill(false));
  for (let r = 0; r < l.rows; r++) {
    for (let c = 0; c < l.cols; c++) {
      const cell = l.cells[r][c];
      const cs = Math.min(cell.cspan || 1, l.cols - c), rs = Math.min(cell.rspan || 1, l.rows - r);
      for (let rr = 0; rr < rs; rr++) for (let cc = 0; cc < cs; cc++) {
        if (rr === 0 && cc === 0) continue;
        cov[r + rr][c + cc] = true;
      }
    }
  }
  return cov;
}

// The anchor (top-left) cell of whatever merge covers (r,c).
function anchorOf(l, r, c) {
  for (let ar = 0; ar <= r; ar++) {
    for (let ac = 0; ac <= c; ac++) {
      const cell = l.cells[ar][ac];
      const cs = Math.min(cell.cspan || 1, l.cols - ac), rs = Math.min(cell.rspan || 1, l.rows - ar);
      if (r >= ar && r < ar + rs && c >= ac && c < ac + cs) return [ar, ac];
    }
  }
  return [r, c];
}

function drawTable(c, l) {
  const cov = computeCovered(l);
  c.font = `${l.fontSize}px ${l.font}`;
  c.textBaseline = 'middle';
  for (let r = 0; r < l.rows; r++) {
    for (let cl = 0; cl < l.cols; cl++) {
      if (cov[r][cl]) continue;
      const cell = l.cells[r][cl];
      const cs = Math.min(cell.cspan || 1, l.cols - cl), rs = Math.min(cell.rspan || 1, l.rows - r);
      const x = cl * l.cellW, y = r * l.cellH, w = cs * l.cellW, h = rs * l.cellH;
      if (cell.bg) {
        c.fillStyle = cell.bg;
        if (l.borderW > 0) {
          c.fillRect(x, y, w, h);
        } else {
          // Borderless: overlap neighbours by ~1px so anti-aliasing leaves no seam grid.
          const o = 0.75 / l.scale;
          c.fillRect(x - o, y - o, w + 2 * o, h + 2 * o);
        }
      }
      if (l.borderW > 0) { c.strokeStyle = l.borderColor; c.lineWidth = l.borderW; c.strokeRect(x, y, w, h); }
      if (cell.text) {
        c.fillStyle = cell.fg || l.fontColor;
        const pad = 6;
        const lines = String(cell.text).split('\n');
        const lineH = l.fontSize * 1.2;
        const totalH = lineH * lines.length;
        let tx, align = cell.align || 'center';
        if (align === 'left') tx = x + pad;
        else if (align === 'right') tx = x + w - pad;
        else tx = x + w / 2;
        c.textAlign = align;
        lines.forEach((ln, i) => c.fillText(ln, tx, y + h / 2 - totalH / 2 + lineH * (i + 0.5)));
      }
    }
  }
}

// Base-pixel -> canvas coords, honouring the table's transform (for the selection box).
function tableBaseToCanvas(l, bx, by) {
  let lx = (bx - l.w / 2) * l.scale, ly = (by - l.h / 2) * l.scale;
  if (l.flipH) lx = -lx;
  const [dx, dy] = rot(lx, ly, l.rotation);
  return [l.cx + dx, l.cy + dy];
}

function selBounds(l) {
  const A = l.sel.start, B = l.sel.end;
  const ca = l.cells[A[0]][A[1]], cb = l.cells[B[0]][B[1]];
  const r0 = Math.min(A[0], B[0]), c0 = Math.min(A[1], B[1]);
  const r1 = Math.max(A[0] + (ca.rspan || 1) - 1, B[0] + (cb.rspan || 1) - 1);
  const c1 = Math.max(A[1] + (ca.cspan || 1) - 1, B[1] + (cb.cspan || 1) - 1);
  return [r0, c0, Math.min(r1, l.rows - 1), Math.min(c1, l.cols - 1)];
}
function forEachSelCell(l, fn) {
  const [r0, c0, r1, c1] = selBounds(l);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(l.cells[r][c]);
}
function selCell(l) { const [r, c] = l.sel.start; return l.cells[r][c]; }

function mergeSelection(l) {
  const [r0, c0, r1, c1] = selBounds(l);
  if (r0 === r1 && c0 === c1) return;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { l.cells[r][c].cspan = 1; l.cells[r][c].rspan = 1; }
  l.cells[r0][c0].cspan = c1 - c0 + 1;
  l.cells[r0][c0].rspan = r1 - r0 + 1;
  l.sel = { start: [r0, c0], end: [r0, c0] };
}
function unmergeSelection(l) { const [r, c] = l.sel.start; l.cells[r][c].cspan = 1; l.cells[r][c].rspan = 1; }

function setTableRows(l, n) {
  n = Math.max(1, Math.min(50, n));
  while (l.cells.length < n) l.cells.push(Array.from({ length: l.cols }, newCell));
  while (l.cells.length > n) l.cells.pop();
  l.rows = n; clampTable(l); tableResize(l);
}
function setTableCols(l, n) {
  n = Math.max(1, Math.min(50, n));
  for (const row of l.cells) { while (row.length < n) row.push(newCell()); while (row.length > n) row.pop(); }
  l.cols = n; clampTable(l); tableResize(l);
}
function clampTable(l) {
  for (let r = 0; r < l.rows; r++) for (let c = 0; c < l.cols; c++) {
    const cell = l.cells[r][c];
    cell.cspan = Math.min(cell.cspan || 1, l.cols - c);
    cell.rspan = Math.min(cell.rspan || 1, l.rows - r);
  }
  l.sel.start = [Math.min(l.sel.start[0], l.rows - 1), Math.min(l.sel.start[1], l.cols - 1)];
  l.sel.end = [Math.min(l.sel.end[0], l.rows - 1), Math.min(l.sel.end[1], l.cols - 1)];
}

function addTextLayer() {
  const l = {
    id: uid(), type: 'text', name: 'text',
    text: 'YOUR TEXT', fontSize: 48, color: '#ffffff',
    stroke: '#000000', strokeW: 6, font: "Impact, 'Arial Black', sans-serif",
    upper: true, align: 'center',
    w: 10, h: 10, cx: state.w / 2, cy: state.h / 2,
    scale: 1, rotation: 0, flipH: false, opacity: 1,
  };
  measureText(l);
  state.layers.push(l);
  selectLayer(l.id);
}

function deleteLayer(id) {
  state.layers = state.layers.filter(l => l.id !== id);
  if (state.selectedId === id) selectLayer(null);
  else { renderLayerList(); draw(); }
}

function moveLayer(id, dir) {
  const i = state.layers.findIndex(l => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.layers.length) return;
  [state.layers[i], state.layers[j]] = [state.layers[j], state.layers[i]];
  renderLayerList(); draw();
}

// ---------- Selection / UI sync ----------
function selectLayer(id) {
  state.selectedId = id;
  syncControls();
  renderLayerList();
  draw();
}

function syncControls() {
  const l = selected();
  document.getElementById('no-selection').classList.toggle('hidden', !!l);
  document.getElementById('layer-controls').classList.toggle('hidden', !l);
  if (!l) return;
  document.getElementById('btn-remove-bg').classList.toggle('hidden', l.type !== 'image');
  document.getElementById('text-editor').classList.toggle('hidden', l.type !== 'text');
  document.getElementById('table-editor').classList.toggle('hidden', l.type !== 'table');
  document.getElementById('layer-opacity').value = Math.round(l.opacity * 100);
  if (l.type === 'text') {
    document.getElementById('text-value').value = l.text;
    document.getElementById('text-size').value = l.fontSize;
    document.getElementById('text-color').value = l.color;
    document.getElementById('text-stroke').value = l.stroke;
    document.getElementById('text-stroke-w').value = l.strokeW;
    document.getElementById('text-font').value = l.font;
    document.getElementById('text-upper').checked = l.upper;
    ['left', 'center', 'right'].forEach(a =>
      document.getElementById('txt-align-' + a).classList.toggle('active-mode', (l.align || 'center') === a));
  } else if (l.type === 'table') {
    syncTablePanel(l);
  }
}

function syncTablePanel(l) {
  l = l || selected();
  if (!l || l.type !== 'table') return;
  document.getElementById('tbl-rows').value = l.rows;
  document.getElementById('tbl-cols').value = l.cols;
  document.getElementById('tbl-border-w').value = l.borderW;
  document.getElementById('tbl-border-color').value = l.borderColor;
  document.getElementById('tbl-font-size').value = l.fontSize;
  document.getElementById('tbl-font-color').value = l.fontColor;
  const cell = selCell(l);
  document.getElementById('tbl-cell-text').value = cell ? cell.text : '';
  if (cell && cell.bg) document.getElementById('tbl-cell-bg').value = cell.bg;
  document.getElementById('tbl-cell-fg').value = (cell && cell.fg) || l.fontColor;
  ['left', 'center', 'right'].forEach(a =>
    document.getElementById('tbl-align-' + a).classList.toggle('active-mode', cell && cell.align === a));
}

function renderLayerList() {
  const ul = document.getElementById('layer-list');
  ul.innerHTML = '';
  // show top layer first
  [...state.layers].reverse().forEach(l => {
    const li = document.createElement('li');
    li.className = l.id === state.selectedId ? 'active' : '';
    const label = l.type === 'text' ? (l.upper ? l.text.toUpperCase() : l.text) : l.name;
    const ico = l.type === 'text' ? '🅣' : l.type === 'table' ? '▦' : (l.subtype === 'paint' ? '🖌' : '🖼');
    li.innerHTML = `<span class="ico">${ico}</span><span class="name"></span>`;
    li.querySelector('.name').textContent = label || l.type;
    li.addEventListener('click', () => selectLayer(l.id));
    ul.appendChild(li);
  });
}

// ---------- Background removal ----------
const bgStatus = document.getElementById('bg-status');
function setStatus(cls, msg) {
  bgStatus.className = 'status ' + cls;
  bgStatus.textContent = msg;
  bgStatus.classList.remove('hidden');
}

document.getElementById('btn-remove-bg').addEventListener('click', async () => {
  const l = selected();
  if (!l || l.type !== 'image') return;
  const btn = document.getElementById('btn-remove-bg');
  btn.disabled = true;
  setStatus('working', 'Loading model… (first run downloads ~40MB)');
  try {
    const blob = await removeBackground(l.src, {
      progress: (key, current, total) => {
        const pct = total ? Math.round((current / total) * 100) : 0;
        if (key.startsWith('fetch')) setStatus('working', `Downloading model ${pct}%`);
        else setStatus('working', `Processing ${pct}%`);
      },
      output: { format: 'image/png' },
    });
    const url = URL.createObjectURL(blob);
    const img = await decodeBlob(blob);
    if (l.src && l.src.startsWith('blob:')) URL.revokeObjectURL(l.src);
    l.baseImg = img;
    l.work = makeWork(img);     // fresh editable canvas from the cut-out
    l.img = l.work;
    l.w = l.work.width; l.h = l.work.height;
    l.src = url;                // keep cut-out as new source (re-runnable)
    setStatus('ok', '✓ Background removed');
    draw();
    repaintSoon();
  } catch (err) {
    console.error(err);
    setStatus('err', 'Failed: ' + (err && err.message ? err.message : err));
  } finally {
    btn.disabled = false;
  }
});

// ---------- File / image loading ----------
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = async () => {
      // Firefox can fire onload before the bitmap is rasterised; force a decode so
      // the very first drawImage isn't blank.
      try { if (img.decode) await img.decode(); } catch { /* ignore */ }
      res(img);
    };
    img.onerror = rej;
    img.src = src;
  });
}
function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}

// Decode a Blob to a guaranteed-rasterised drawable. createImageBitmap is the most
// reliable path (esp. Firefox, where <img>.onload can precede the bitmap being ready).
async function decodeBlob(blob) {
  try {
    if (typeof createImageBitmap === 'function') return await createImageBitmap(blob);
  } catch { /* fall through to <img> */ }
  return loadImage(URL.createObjectURL(blob));
}

// Add an image Blob/File as a new layer, keeping a data URL as its re-runnable source.
async function blobToLayer(blob, name) {
  const src = await readFileAsDataURL(blob);
  const img = await decodeBlob(blob);
  addImageLayer(img, src, name || 'image');
  repaintSoon();
}

document.getElementById('file-add').addEventListener('change', async (e) => {
  for (const file of e.target.files) await blobToLayer(file, file.name);
  e.target.value = '';
});

// Paste an image from the clipboard as a new layer.
// Cross-browser: Chrome fires a `paste` event on the body, but Firefox only fires
// `paste` on editable elements — so for Firefox (and the toolbar button) we use the
// async Clipboard API instead. Ignored while typing in a field.
function inField() { return ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName); }

async function addImageFromBlob(blob, name) {
  await blobToLayer(blob, name || 'pasted');
  flashToast('Pasted image layer');
}

async function pasteFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    flashToast('Clipboard paste not supported here — use “Add image layer”');
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find(t => t.startsWith('image/'));
      if (type) { await addImageFromBlob(await item.getType(type)); return; }
    }
    flashToast('No image found on the clipboard');
  } catch (err) {
    console.error(err);
    flashToast('Paste failed: ' + ((err && err.message) || err));
  }
}

// Chrome path: the native paste event carries the image directly (no permission prompt).
let lastPasteEvent = 0;
document.addEventListener('paste', async (e) => {
  if (inField()) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      e.preventDefault();
      const file = it.getAsFile();
      if (file) { lastPasteEvent = Date.now(); await addImageFromBlob(file, file.name); }
      return;
    }
  }
});

// Firefox path: the paste event won't fire on the canvas, so on Ctrl/Cmd+V fall back
// to the async clipboard read (unless the native event already handled it, i.e. Chrome).
document.addEventListener('keydown', (e) => {
  if (inField()) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
    setTimeout(() => { if (Date.now() - lastPasteEvent > 250) pasteFromClipboard(); }, 80);
  }
});

document.getElementById('btn-paste-image').addEventListener('click', pasteFromClipboard);

document.getElementById('file-bg').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = await decodeBlob(file);
  state.bg = { img };
  // size the canvas to the background (ImageBitmap uses width/height, <img> naturalWidth)
  state.w = img.naturalWidth || img.width;
  state.h = img.naturalHeight || img.height;
  syncCanvasInputs();
  resizeCanvas();
  repaintSoon();
  e.target.value = '';
});

// ---------- Toolbar bindings ----------
document.getElementById('btn-add-text').addEventListener('click', addTextLayer);
document.getElementById('btn-add-paint').addEventListener('click', addPaintLayer);

// ---------- Brush tool ----------
function toggleBrush(on) {
  brush.active = on === undefined ? !brush.active : on;
  document.getElementById('brush-opts').classList.toggle('hidden', !brush.active);
  const btn = document.getElementById('btn-brush-toggle');
  btn.textContent = brush.active ? '🖌 Brush: On' : '🖌 Brush: Off';
  btn.classList.toggle('primary', brush.active);
  canvas.style.cursor = brush.active ? 'crosshair' : 'default';
  if (!brush.active) brush.cursor = null;
  draw();
}
function setBrushMode(m) {
  brush.mode = m;
  document.getElementById('bm-paint').classList.toggle('active-mode', m === 'paint');
  document.getElementById('bm-erase').classList.toggle('active-mode', m === 'erase');
}
function setBrushShape(s) {
  brush.shape = s;
  document.getElementById('bs-circle').classList.toggle('active-mode', s === 'circle');
  document.getElementById('bs-square').classList.toggle('active-mode', s === 'square');
}
function setBrushSize(v) {
  brush.size = Math.max(1, Math.min(300, Math.round(v)));
  document.getElementById('brush-size').value = brush.size;
  document.getElementById('brush-size-val').textContent = brush.size;
  if (brush.cursor) draw();
}
function restoreLayer() {
  const l = selected();
  if (!l || l.type !== 'image') { flashToast('Select an image / paint layer'); return; }
  if (l.subtype === 'paint') {
    l.work.getContext('2d').clearRect(0, 0, l.work.width, l.work.height);
  } else if (l.baseImg) {
    l.work = makeWork(l.baseImg);
    l.img = l.work;
  }
  draw();
}

document.getElementById('btn-brush-toggle').addEventListener('click', () => toggleBrush());
document.getElementById('bm-paint').addEventListener('click', () => setBrushMode('paint'));
document.getElementById('bm-erase').addEventListener('click', () => setBrushMode('erase'));
document.getElementById('bs-circle').addEventListener('click', () => setBrushShape('circle'));
document.getElementById('bs-square').addEventListener('click', () => setBrushShape('square'));
document.getElementById('brush-size').addEventListener('input', (e) => setBrushSize(+e.target.value));
document.getElementById('brush-feather').addEventListener('input', (e) => {
  brush.feather = +e.target.value;
  document.getElementById('brush-feather-val').textContent = brush.feather;
});
document.getElementById('brush-color').addEventListener('input', (e) => { brush.color = e.target.value; });
document.getElementById('btn-brush-restore').addEventListener('click', restoreLayer);

// ---------- Table bindings ----------
document.getElementById('btn-add-table').addEventListener('click', addTableLayer);

['left', 'center', 'right'].forEach(a => {
  document.getElementById('txt-align-' + a).addEventListener('click', () => {
    const l = selected(); if (!l || l.type !== 'text') return;
    l.align = a; measureText(l); syncControls(); draw();
  });
});

function bindTable(id, fn) {
  document.getElementById(id).addEventListener('input', (e) => {
    const l = selected(); if (!l || l.type !== 'table') return;
    fn(l, e.target); draw();
  });
}
bindTable('tbl-rows', (l, t) => setTableRows(l, parseInt(t.value, 10) || 1));
bindTable('tbl-cols', (l, t) => setTableCols(l, parseInt(t.value, 10) || 1));
bindTable('tbl-border-w', (l, t) => l.borderW = clampInt(t.value, 0, 20));
bindTable('tbl-border-color', (l, t) => l.borderColor = t.value);
bindTable('tbl-font-size', (l, t) => l.fontSize = clampInt(t.value, 6, 120));
bindTable('tbl-font-color', (l, t) => l.fontColor = t.value);
bindTable('tbl-cell-text', (l, t) => { const c = selCell(l); if (c) c.text = t.value; });
bindTable('tbl-cell-bg', (l, t) => forEachSelCell(l, c => c.bg = t.value));
bindTable('tbl-cell-fg', (l, t) => forEachSelCell(l, c => c.fg = t.value));

document.getElementById('tbl-cell-bg-clear').addEventListener('click', () => {
  const l = selected(); if (!l || l.type !== 'table') return;
  forEachSelCell(l, c => c.bg = ''); draw();
});
document.getElementById('tbl-cell-fg-clear').addEventListener('click', () => {
  const l = selected(); if (!l || l.type !== 'table') return;
  forEachSelCell(l, c => c.fg = ''); syncTablePanel(l); draw();
});
['left', 'center', 'right'].forEach(a => {
  document.getElementById('tbl-align-' + a).addEventListener('click', () => {
    const l = selected(); if (!l || l.type !== 'table') return;
    forEachSelCell(l, c => c.align = a); syncTablePanel(l); draw();
  });
});
document.getElementById('tbl-merge').addEventListener('click', () => {
  const l = selected(); if (!l || l.type !== 'table') return;
  mergeSelection(l); syncTablePanel(l); draw();
});
document.getElementById('tbl-unmerge').addEventListener('click', () => {
  const l = selected(); if (!l || l.type !== 'table') return;
  unmergeSelection(l); syncTablePanel(l); draw();
});
document.getElementById('btn-crop-canvas').addEventListener('click', cropToLayer);
document.getElementById('btn-delete').addEventListener('click', () => { const l = selected(); if (l) deleteLayer(l.id); });
document.getElementById('btn-forward').addEventListener('click', () => { const l = selected(); if (l) moveLayer(l.id, 1); });
document.getElementById('btn-back').addEventListener('click', () => { const l = selected(); if (l) moveLayer(l.id, -1); });
document.getElementById('btn-flip-h').addEventListener('click', () => { const l = selected(); if (l) { l.flipH = !l.flipH; draw(); } });
document.getElementById('btn-reset-rot').addEventListener('click', () => { const l = selected(); if (l) { l.rotation = 0; draw(); } });

document.getElementById('layer-opacity').addEventListener('input', (e) => {
  const l = selected(); if (l) { l.opacity = e.target.value / 100; draw(); }
});

// canvas settings
document.getElementById('canvas-w').addEventListener('change', (e) => { state.w = clampInt(e.target.value, 16, 8000); resizeCanvas(); });
document.getElementById('canvas-h').addEventListener('change', (e) => { state.h = clampInt(e.target.value, 16, 8000); resizeCanvas(); });
document.getElementById('canvas-fill').addEventListener('input', (e) => { state.fill = e.target.value; state.transparent = false; draw(); });
document.getElementById('btn-transparent').addEventListener('click', () => { state.transparent = true; state.bg = null; draw(); });
function clampInt(v, lo, hi) { v = parseInt(v, 10) || lo; return Math.max(lo, Math.min(hi, v)); }

// text editing
function bindText(id, fn) {
  document.getElementById(id).addEventListener('input', (e) => {
    const l = selected(); if (!l || l.type !== 'text') return;
    fn(l, e.target);
    measureText(l); draw(); renderLayerList();
  });
}
bindText('text-value', (l, t) => l.text = t.value);
bindText('text-size', (l, t) => l.fontSize = clampInt(t.value, 6, 400));
bindText('text-color', (l, t) => l.color = t.value);
bindText('text-stroke', (l, t) => l.stroke = t.value);
bindText('text-stroke-w', (l, t) => l.strokeW = clampInt(t.value, 0, 40));
bindText('text-font', (l, t) => l.font = t.value);
bindText('text-upper', (l, t) => l.upper = t.checked);

// ---------- Export / copy ----------
function renderToBlob() {
  const off = document.createElement('canvas');
  off.width = state.w; off.height = state.h;
  composite(off.getContext('2d'));
  return new Promise(res => off.toBlob(res, 'image/png'));
}

document.getElementById('btn-export').addEventListener('click', async () => {
  const blob = await renderToBlob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bg-studio-' + Date.now() + '.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

document.getElementById('btn-copy').addEventListener('click', async () => {
  try {
    const blob = await renderToBlob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    flash('btn-copy', '✓ Copied');
  } catch (err) {
    console.error(err);
    flash('btn-copy', 'Copy failed');
  }
});
function flash(id, msg) {
  const b = document.getElementById(id);
  const old = b.textContent;
  b.textContent = msg;
  setTimeout(() => { b.textContent = old; }, 1400);
}

let toastTimer = null;
function flashToast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

// ---------- Build stamp ----------
// Bump this on every change so the bottom-right label proves which app.js is live.
const BUILD = 'build 2026-07-01 · r11 · canvas-crop';
(function stampBuild() {
  const el = document.createElement('div');
  el.id = 'build-stamp';
  el.textContent = BUILD;
  document.body.appendChild(el);
})();

// ---------- Init ----------
resizeCanvas();
syncControls();
renderLayerList();
