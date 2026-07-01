// BG Studio — local meme generator + background remover.
// Background removal runs fully in-browser via @imgly/background-removal (WASM/ONNX).
import { removeBackground, preload } from 'https://esm.sh/@imgly/background-removal@1.5.5';

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
  const ox = l.crop ? l.crop.x : 0, oy = l.crop ? l.crop.y : 0;
  return [lx / l.scale + l.w / 2 + ox, ly / l.scale + l.h / 2 + oy];
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
  const hlPad = l.hlOn ? (l.hlPad || 0) : 0;
  l._maxW = maxW;
  l.w = maxW + l.strokeW * 2 + 8 + hlPad * 2;
  l.h = lineH * lines.length + l.strokeW * 2 + 4 + hlPad * 2;
  l._lines = lines;
  l._lineH = lineH;
}

// Draw the highlight background (and optional border) behind a text layer, in the
// same scaled/aligned space as the glyphs. 'block' = one box behind the whole
// paragraph; 'marker' = a tight box per line (highlighter-pen look).
function drawTextHighlight(c, l, lines, lineH, align) {
  const pad = l.hlPad || 0, rad = l.hlRadius || 0, maxW = l._maxW || 1;
  const totalH = lineH * lines.length;
  c.save();
  c.font = fontString(l);
  c.fillStyle = l.hlColor || '#ffe14d';
  const box = (x, y, w, h) => {
    const r = Math.max(0, Math.min(rad, w / 2, h / 2));
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r);
    else {
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
    }
    c.fill();
    if (l.hlBorderW > 0) { c.lineWidth = l.hlBorderW; c.strokeStyle = l.hlBorderColor || '#000'; c.stroke(); }
  };
  if (l.hlStyle === 'marker') {
    lines.forEach((ln, i) => {
      const tw = c.measureText(ln || ' ').width;
      const left = (align === 'left' ? -maxW / 2 : align === 'right' ? maxW / 2 - tw : -tw / 2) - pad;
      const boxH = l.fontSize * 1.05 + pad * 0.8;
      const cy = -totalH / 2 + lineH * (i + 0.5);
      box(left, cy - boxH / 2, tw + 2 * pad, boxH);
    });
  } else {
    box(-maxW / 2 - pad, -totalH / 2 - pad, maxW + 2 * pad, totalH + 2 * pad);
  }
  c.restore();
}

// ---------- Vector shapes ----------
// A vector layer stores its geometry in local coordinates centred on the origin,
// then rides the same cx/cy + scale + rotation transform as every other layer.
// pts-based subtypes (line, path) keep an array of local points; the others are
// parameterised (rect/ellipse by w,h · star by radius/points/inner · squiggle by
// w/amp/waves). isClosed decides whether a fill is meaningful.
function isPointVec(l) { return l && l.type === 'vector' && (l.subtype === 'line' || l.subtype === 'path'); }
function isClosedVec(l) {
  if (l.subtype === 'rect' || l.subtype === 'ellipse' || l.subtype === 'star') return true;
  if (l.subtype === 'path') return !!l.closed;
  return false;
}

// Build the shape as a Path2D in local (unscaled, unrotated) coordinates.
function vectorPath(l) {
  const p = new Path2D();
  if (l.subtype === 'line' || l.subtype === 'path') {
    // Each point is [x, y] (corner) or [x, y, hIn, hOut] where hIn/hOut are
    // [dx,dy] control-handle offsets from the anchor. A segment a->b is a curve
    // when a has an out-handle or b has an in-handle, else a straight line.
    const pts = l.pts, n = pts.length;
    if (n) p.moveTo(pts[0][0], pts[0][1]);
    const segs = l.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const aOut = a[3], bIn = b[2];
      if (aOut || bIn) {
        p.bezierCurveTo(a[0] + (aOut ? aOut[0] : 0), a[1] + (aOut ? aOut[1] : 0),
                        b[0] + (bIn ? bIn[0] : 0), b[1] + (bIn ? bIn[1] : 0), b[0], b[1]);
      } else { p.lineTo(b[0], b[1]); }
    }
    if (l.closed) p.closePath();
  } else if (l.subtype === 'rect') {
    p.rect(-l.w / 2, -l.h / 2, l.w, l.h);
  } else if (l.subtype === 'ellipse') {
    p.ellipse(0, 0, l.w / 2, l.h / 2, 0, 0, Math.PI * 2);
  } else if (l.subtype === 'star') {
    const n = l.points, ro = l.radius, ri = ro * l.inner;
    for (let i = 0; i < n * 2; i++) {
      const r = i % 2 === 0 ? ro : ri;
      const a = -Math.PI / 2 + i * Math.PI / n;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      i === 0 ? p.moveTo(x, y) : p.lineTo(x, y);
    }
    p.closePath();
  } else if (l.subtype === 'squiggle') {
    const steps = Math.max(24, l.waves * 16);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = -l.w / 2 + t * l.w;
      const y = Math.sin(t * l.waves * Math.PI * 2) * l.amp;
      i === 0 ? p.moveTo(x, y) : p.lineTo(x, y);
    }
  }
  return p;
}

// Re-centre pts-based geometry so the origin sits at the bounding-box centre,
// nudging cx/cy so the shape doesn't visually jump. Keeps handles/rotation sane.
function recenterVector(l) {
  if (!l.pts) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of l.pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2;
  if (!ox && !oy) return;
  for (const pt of l.pts) { pt[0] -= ox; pt[1] -= oy; }
  const [dx, dy] = rot((l.flipH ? -1 : 1) * ox * l.scale, oy * l.scale, l.rotation);
  l.cx += dx; l.cy += dy;
}

// Keep l.w / l.h (the local bounding box the handles wrap) in sync with geometry.
function recomputeVectorBounds(l) {
  if (l.subtype === 'rect' || l.subtype === 'ellipse') return;  // w,h are authoritative
  if (l.subtype === 'star') { l.w = l.h = 2 * l.radius; return; }
  if (l.subtype === 'squiggle') { l.h = 2 * l.amp + Math.max(l.strokeW, 2); return; }
  recenterVector(l);  // line, path
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of l.pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  l.w = Math.max(maxX - minX, 1); l.h = Math.max(maxY - minY, 1);
}

// Set a vector's width ('x') or height ('y') directly. Box shapes take it as-is;
// pts-based shapes (line/path) scale their points along that axis to fit.
function setVectorDim(l, axis, target) {
  if (l.subtype === 'rect' || l.subtype === 'ellipse') { l[axis === 'x' ? 'w' : 'h'] = target; return; }
  if (l.pts) {
    const cur = axis === 'x' ? l.w : l.h;
    if (cur > 1) {
      const s = target / cur, k = axis === 'x' ? 0 : 1;
      for (const p of l.pts) { p[k] *= s; if (p[2]) p[2][k] *= s; if (p[3]) p[3][k] *= s; }
    }
  }
}

// A local point -> canvas coords (for drawing/grabbing vertex handles).
function vectorPointCanvas(l, pt) {
  let lx = pt[0] * l.scale, ly = pt[1] * l.scale;
  if (l.flipH) lx = -lx;
  const [dx, dy] = rot(lx, ly, l.rotation);
  return [l.cx + dx, l.cy + dy];
}
// Canvas coords -> a local point (for setting a dragged vertex).
function canvasToVectorLocal(l, px, py) {
  let [lx, ly] = rot(px - l.cx, py - l.cy, -l.rotation);
  if (l.flipH) lx = -lx;
  return [lx / l.scale, ly / l.scale];
}
// Canvas position of an anchor's handle knob, or null if that handle is absent.
// (Handle offsets live at pt[2] = in, pt[3] = out.)
function vectorHandleCanvas(l, i, which) {
  const h = l.pts[i][which];
  if (!h) return null;
  return vectorPointCanvas(l, [l.pts[i][0] + h[0], l.pts[i][1] + h[1]]);
}

// Precise hit test: inside the fill (closed shapes) or within the stroke + a few
// canvas-px of slop, rather than the loose bounding box hitLayer uses.
function hitVector(l, px, py) {
  const [lx, ly] = canvasToVectorLocal(l, px, py);
  const path = vectorPath(l);
  let hit = false;
  ctx.save();
  if (isClosedVec(l) && l.fill) hit = ctx.isPointInPath(path, lx, ly);
  if (!hit && (l.strokeW > 0 || !l.fill)) {
    ctx.lineWidth = Math.max(l.strokeW, 4 / l.scale) + 10 / l.scale;
    hit = ctx.isPointInStroke(path, lx, ly);
  }
  ctx.restore();
  return hit;
}
// Unified hit test used by picking / hover.
function layerHit(l, px, py) { return l.type === 'vector' ? hitVector(l, px, py) : hitLayer(l, px, py); }

function addVectorLayer(subtype) {
  const d = Math.min(state.w, state.h);
  const l = {
    id: uid(), type: 'vector', subtype, name: subtype,
    stroke: '#ffd23b', strokeW: 6, fill: '',
    cap: 'round', join: 'round', dashed: false,
    cx: state.w / 2, cy: state.h / 2,
    scale: 1, rotation: 0, flipH: false, opacity: 1,
  };
  if (subtype === 'line') { const L = d * 0.4; l.pts = [[-L / 2, 0], [L / 2, 0]]; }
  else if (subtype === 'path') { const L = d * 0.3; l.pts = [[-L / 2, L / 3], [0, -L / 3], [L / 2, L / 3]]; }
  else if (subtype === 'rect') { l.w = d * 0.4; l.h = d * 0.28; l.fill = '#6d8bff'; }
  else if (subtype === 'ellipse') { l.w = d * 0.34; l.h = d * 0.34; l.fill = '#6d8bff'; }
  else if (subtype === 'star') { l.points = 5; l.inner = 0.5; l.radius = d * 0.22; l.fill = '#ffd23b'; l.stroke = '#f0a500'; }
  else if (subtype === 'squiggle') { l.w = d * 0.5; l.amp = d * 0.06; l.waves = 4; }
  recomputeVectorBounds(l);
  state.layers.push(l);
  selectLayer(l.id);
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
    if (l.crop) c.drawImage(l.img, l.crop.x, l.crop.y, l.crop.w, l.crop.h, -w / 2, -h / 2, w, h);
    else c.drawImage(l.img, -w / 2, -h / 2, w, h);
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
    const maxW = l._maxW || 1;
    const ax = align === 'left' ? -maxW / 2 : align === 'right' ? maxW / 2 : 0;
    if (l.hlOn) drawTextHighlight(c, l, lines, lineH, align);
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
  } else if (l.type === 'vector') {
    c.scale(l.scale, l.scale);
    const path = vectorPath(l);
    c.lineCap = l.cap; c.lineJoin = l.join;
    if (l.dashed && l.strokeW > 0) c.setLineDash([l.strokeW * 2.4, l.strokeW * 1.8]);
    if (isClosedVec(l) && l.fill) { c.fillStyle = l.fill; c.fill(path); }
    if (l.strokeW > 0) { c.strokeStyle = l.stroke; c.lineWidth = l.strokeW; c.stroke(path); }
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

function drawVectorHandles(l) {
  const cs = corners(l);
  ctx.save();
  // faint bounding outline for context
  ctx.strokeStyle = 'rgba(109,139,255,.5)';
  ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(cs[0][0], cs[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(cs[i][0], cs[i][1]);
  ctx.closePath(); ctx.stroke();
  ctx.setLineDash([]);
  // bezier control handles (drawn under the anchor dots)
  for (let i = 0; i < l.pts.length; i++) {
    const [ax, ay] = vectorPointCanvas(l, l.pts[i]);
    for (const which of [2, 3]) {
      const hp = vectorHandleCanvas(l, i, which);
      if (!hp) continue;
      ctx.strokeStyle = 'rgba(109,139,255,.9)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(hp[0], hp[1]); ctx.stroke();
      ctx.fillStyle = '#c9d4ff'; ctx.strokeStyle = '#4f6cf0';
      ctx.beginPath(); ctx.arc(hp[0], hp[1], 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
  // endpoint / vertex dots — square for corner anchors, round for smooth ones
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#4f6cf0'; ctx.lineWidth = 1.5;
  for (const pt of l.pts) {
    const [x, y] = vectorPointCanvas(l, pt);
    ctx.beginPath();
    if (pt[2] || pt[3]) ctx.arc(x, y, 6, 0, Math.PI * 2);
    else ctx.rect(x - 5, y - 5, 10, 10);
    ctx.fill(); ctx.stroke();
  }
  // while the pen is mid-path, rubber-band from the last anchor to the cursor
  if (penMode && pen.layer === l && pen.cursor && l.pts.length) {
    const [lx, ly] = vectorPointCanvas(l, l.pts[l.pts.length - 1]);
    ctx.strokeStyle = 'rgba(255,210,59,.8)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(pen.cursor[0], pen.cursor[1]); ctx.stroke();
    ctx.setLineDash([]);
    // highlight the first anchor as the close target
    const [fx, fy] = vectorPointCanvas(l, l.pts[0]);
    ctx.strokeStyle = '#ffd23b'; ctx.beginPath(); ctx.arc(fx, fy, 8, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

// ---------- Pen tool (Photoshop-style path drawing) ----------
// penMode = clicking the canvas appends anchors to `pen.layer`; click-drag pulls
// out symmetric bezier handles. Clicking the first anchor closes the path.
let penMode = false;
const pen = { layer: null, cursor: null };
function finishPen() { pen.layer = null; pen.cursor = null; }
function togglePen(on) {
  penMode = on === undefined ? !penMode : on;
  if (penMode) {
    if (brush.active) toggleBrush(false);
    if (cropMode) { cropMode = false; updateCropButton(); }
  } else { finishPen(); }
  const btn = document.getElementById('btn-pen-toggle');
  if (btn) {
    btn.textContent = penMode ? '✒ Pen: On — click to add points' : '✒ Pen tool';
    btn.classList.toggle('primary', penMode);
  }
  canvas.style.cursor = penMode ? 'crosshair' : 'default';
  draw();
}

// ---------- Image crop mode ----------
let cropMode = false;
function fullSize(l) { return { w: (l.work ? l.work.width : l.w), h: (l.work ? l.work.height : l.h) }; }
// World position of the FULL image's centre, given the current crop + transform.
function fullCenterWorld(l) {
  const cr = l.crop || { x: 0, y: 0, ...fullSize(l) };
  const f = fullSize(l);
  const dx = f.w / 2 - (cr.x + cr.w / 2), dy = f.h / 2 - (cr.y + cr.h / 2);
  const [rx, ry] = rot((l.flipH ? -1 : 1) * dx * l.scale, dy * l.scale, l.rotation);
  return [l.cx + rx, l.cy + ry];
}
// Reposition the layer centre so the full image's centre stays pinned at G.
function centerFromGhost(l, G) {
  const cr = l.crop, f = fullSize(l);
  const dx = (cr.x + cr.w / 2) - f.w / 2, dy = (cr.y + cr.h / 2) - f.h / 2;
  const [rx, ry] = rot((l.flipH ? -1 : 1) * dx * l.scale, dy * l.scale, l.rotation);
  l.cx = G[0] + rx; l.cy = G[1] + ry;
}
// The 8 crop handles (4 corners + 4 edge midpoints) with the edges each controls.
function cropHandles(l) {
  const cs = corners(l);
  const mid = (a, b) => [(cs[a][0] + cs[b][0]) / 2, (cs[a][1] + cs[b][1]) / 2];
  return [
    { p: cs[0], e: ['n', 'w'] }, { p: cs[1], e: ['n', 'e'] }, { p: cs[2], e: ['s', 'e'] }, { p: cs[3], e: ['s', 'w'] },
    { p: mid(0, 1), e: ['n'] }, { p: mid(1, 2), e: ['e'] }, { p: mid(2, 3), e: ['s'] }, { p: mid(3, 0), e: ['w'] },
  ];
}
function drawCropUI(l) {
  const f = fullSize(l), G = fullCenterWorld(l);
  ctx.save();                                   // ghost of the full image
  ctx.globalAlpha = 0.28;
  ctx.translate(G[0], G[1]); ctx.rotate(l.rotation); if (l.flipH) ctx.scale(-1, 1);
  ctx.drawImage(l.img, -f.w * l.scale / 2, -f.h * l.scale / 2, f.w * l.scale, f.h * l.scale);
  ctx.restore();
  const cs = corners(l);
  ctx.save();
  ctx.strokeStyle = '#ffd23b'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.moveTo(cs[0][0], cs[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(cs[i][0], cs[i][1]);
  ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#e0a500';
  for (const h of cropHandles(l)) { ctx.beginPath(); ctx.rect(h.p[0] - 5, h.p[1] - 5, 10, 10); ctx.fill(); ctx.stroke(); }
  ctx.restore();
}

function draw() {
  composite(ctx);
  const l = selected();
  if (l && !brush.active) {
    if (cropMode && l.type === 'image') drawCropUI(l);
    else (isPointVec(l) ? drawVectorHandles : drawHandles)(l);
  }
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
function cropCursor(edges) {
  const k = edges.join('');
  if (k === 'nw' || k === 'se') return 'nwse-resize';
  if (k === 'ne' || k === 'sw') return 'nesw-resize';
  if (k === 'n' || k === 's') return 'ns-resize';
  return 'ew-resize';
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
  // Pen mode: build / extend a path by clicking; drag to pull out curve handles.
  if (penMode) {
    let l = pen.layer;
    // clicking the first anchor of the in-progress path closes it
    if (l && l.pts.length >= 2) {
      const [fx, fy] = vectorPointCanvas(l, l.pts[0]);
      if (near(px, py, fx, fy, 11)) {
        l.closed = true;
        if (!l.fill) l.fill = '#6d8bff';
        recomputeVectorBounds(l); finishPen(); syncControls(); draw();
        return;
      }
    }
    if (!l) {
      // start a fresh path centred on the first click
      l = {
        id: uid(), type: 'vector', subtype: 'path', name: 'path',
        stroke: '#ffd23b', strokeW: 6, fill: '', cap: 'round', join: 'round', dashed: false,
        cx: px, cy: py, scale: 1, rotation: 0, flipH: false, opacity: 1, closed: false,
        pts: [[0, 0]],
      };
      recomputeVectorBounds(l);
      state.layers.push(l);
      selectLayer(l.id);
      pen.layer = l;
      drag = { mode: 'penDrag', layer: l, index: 0 };
    } else {
      l.pts.push(canvasToVectorLocal(l, px, py));
      recomputeVectorBounds(l);
      drag = { mode: 'penDrag', layer: l, index: l.pts.length - 1 };
    }
    pen.cursor = [px, py];
    canvas.setPointerCapture(e.pointerId);
    draw();
    return;
  }
  const l = selected();
  // Crop mode: grab a crop handle on the selected image (else fall through to move).
  if (cropMode && l && l.type === 'image') {
    for (const h of cropHandles(l)) {
      if (near(px, py, h.p[0], h.p[1], 11)) {
        drag = { mode: 'crop', layer: l, edges: h.e, G: fullCenterWorld(l) };
        canvas.setPointerCapture(e.pointerId); return;
      }
    }
  }
  // Line / path: grab a bezier handle knob, an anchor, or Alt-drag to add curves.
  if (isPointVec(l)) {
    // 1) bezier control-handle knobs take priority (they sit off the anchors)
    for (let i = 0; i < l.pts.length; i++) {
      for (const which of [2, 3]) {
        const hp = vectorHandleCanvas(l, i, which);
        if (hp && near(px, py, hp[0], hp[1], 10)) {
          drag = { mode: 'vhandle', layer: l, index: i, which, alt: e.altKey };
          canvas.setPointerCapture(e.pointerId); return;
        }
      }
    }
    // 2) anchors: plain drag moves; Alt-drag pulls out (or strips) curve handles
    for (let i = 0; i < l.pts.length; i++) {
      const [hx, hy] = vectorPointCanvas(l, l.pts[i]);
      if (near(px, py, hx, hy, 11)) {
        if (e.altKey) drag = { mode: 'vconvert', layer: l, index: i, sx: px, sy: py, had: !!(l.pts[i][2] || l.pts[i][3]), moved: false };
        else drag = { mode: 'vpoint', layer: l, index: i };
        canvas.setPointerCapture(e.pointerId); return;
      }
    }
  }
  // handle grabs take priority on the already-selected layer (not point-vec shapes)
  if (l && !isPointVec(l) && !cropMode) {
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
  const edge = cropMode ? null : canvasEdgeAt(px, py);
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
    if (layerHit(state.layers[i], px, py)) { pick = state.layers[i]; break; }
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
  // Pen mode: track the cursor for the rubber-band, and pull handles while dragging.
  if (penMode) {
    const [px, py] = canvasPoint(e);
    pen.cursor = [px, py];
    if (drag && drag.mode === 'penDrag') {
      const l = drag.layer, a = l.pts[drag.index];
      const [cx, cy] = canvasToVectorLocal(l, px, py);
      const off = [cx - a[0], cy - a[1]];
      a[3] = off; a[2] = [-off[0], -off[1]];
    }
    if (pen.layer) draw();
    return;
  }
  if (!drag) {
    // cursor affordance
    const [px, py] = canvasPoint(e);
    const l = selected();
    if (cropMode && l && l.type === 'image') {
      const h = cropHandles(l).find(hh => near(px, py, hh.p[0], hh.p[1], 11));
      canvas.style.cursor = h ? cropCursor(h.e) : 'move';
      if (state.edgeHover) { state.edgeHover = null; draw(); }
      return;
    }
    let cur = 'default';
    if (isPointVec(l)) {
      if (l.pts.some(pt => { const [hx, hy] = vectorPointCanvas(l, pt); return near(px, py, hx, hy, 11); })) cur = 'pointer';
    } else if (l) {
      const rp = rotateHandlePos(l);
      if (near(px, py, rp[0], rp[1], 11)) cur = 'grab';
      else if (corners(l).some(c => near(px, py, c[0], c[1], 11))) cur = 'nwse-resize';
    }
    let edge = null;
    if (cur === 'default') {
      edge = canvasEdgeAt(px, py);
      if (edge) cur = edgeCursor(edge);
      else if (l && layerHit(l, px, py)) cur = 'move';
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
  if (drag.mode === 'vpoint') {
    const [px, py] = canvasPoint(e);
    const [nx, ny] = canvasToVectorLocal(drag.layer, px, py);
    const pt = drag.layer.pts[drag.index];
    pt[0] = nx; pt[1] = ny;   // move anchor, keeping its handles (indices 2,3)
    recomputeVectorBounds(drag.layer);
    draw();
    return;
  }
  if (drag.mode === 'vhandle') {
    const [px, py] = canvasPoint(e);
    const l = drag.layer, w = drag.which, a = l.pts[drag.index];
    const [cx, cy] = canvasToVectorLocal(l, px, py);
    const off = [cx - a[0], cy - a[1]];
    a[w] = off;
    if (!drag.alt) {                     // smooth: keep the opposite handle collinear
      const other = w === 2 ? 3 : 2;
      if (a[other]) {
        const olen = Math.hypot(a[other][0], a[other][1]);
        const mag = Math.hypot(off[0], off[1]) || 1;
        a[other] = [-off[0] / mag * olen, -off[1] / mag * olen];
      }
    }
    draw();
    return;
  }
  if (drag.mode === 'vconvert') {        // Alt-drag an anchor: pull out fresh symmetric handles
    const [px, py] = canvasPoint(e);
    const l = drag.layer, a = l.pts[drag.index];
    const [cx, cy] = canvasToVectorLocal(l, px, py);
    const off = [cx - a[0], cy - a[1]];
    a[3] = off; a[2] = [-off[0], -off[1]];
    drag.moved = true;
    draw();
    return;
  }
  if (drag.mode === 'crop') {
    const l = drag.layer, cr = l.crop, f = fullSize(l);
    const [px, py] = canvasPoint(e);
    let [lx, ly] = rot(px - drag.G[0], py - drag.G[1], -l.rotation);
    if (l.flipH) lx = -lx;
    const sx = Math.round(lx / l.scale + f.w / 2), sy = Math.round(ly / l.scale + f.h / 2);
    let edges = drag.edges;
    if (l.flipH) edges = edges.map(x => x === 'e' ? 'w' : x === 'w' ? 'e' : x);  // mirror maps E↔W
    if (edges.includes('e')) { const r = Math.max(cr.x + 1, Math.min(f.w, sx)); cr.w = r - cr.x; }
    if (edges.includes('w')) { const lft = Math.max(0, Math.min(cr.x + cr.w - 1, sx)); cr.w = (cr.x + cr.w) - lft; cr.x = lft; }
    if (edges.includes('s')) { const b = Math.max(cr.y + 1, Math.min(f.h, sy)); cr.h = b - cr.y; }
    if (edges.includes('n')) { const t = Math.max(0, Math.min(cr.y + cr.h - 1, sy)); cr.h = (cr.y + cr.h) - t; cr.y = t; }
    l.w = cr.w; l.h = cr.h;
    centerFromGhost(l, drag.G);
    draw();
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
  if (drag) {
    // Alt-click (no drag) on a smooth anchor converts it back to a corner.
    if (drag.mode === 'vconvert' && !drag.moved && drag.had) {
      drag.layer.pts[drag.index].length = 2;
      draw();
    }
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
    drag = null;
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => {
  if (brush.active) { brush.cursor = null; draw(); }
  if (state.edgeHover) { state.edgeHover = null; draw(); }
});

// Clamped projection parameter of (px,py) onto segment a→b.
function segParam(a, b, px, py) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  return Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
}
// Double-click a Path: on a vertex removes it, on a segment inserts a new point.
canvas.addEventListener('dblclick', (e) => {
  const l = selected();
  if (!l || l.type !== 'vector' || l.subtype !== 'path') return;
  const [px, py] = canvasPoint(e);
  for (let i = 0; i < l.pts.length; i++) {
    const [hx, hy] = vectorPointCanvas(l, l.pts[i]);
    if (near(px, py, hx, hy, 11)) {
      if (l.pts.length > 2) { l.pts.splice(i, 1); recomputeVectorBounds(l); draw(); }
      return;
    }
  }
  const [lx, ly] = canvasToVectorLocal(l, px, py);
  const segs = l.closed ? l.pts.length : l.pts.length - 1;
  let best = -1, bestD = Infinity, bestPt = null;
  for (let i = 0; i < segs; i++) {
    const a = l.pts[i], b = l.pts[(i + 1) % l.pts.length];
    const t = segParam(a, b, lx, ly);
    const proj = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const d = Math.hypot(proj[0] - lx, proj[1] - ly);
    if (d < bestD) { bestD = d; best = i; bestPt = proj; }
  }
  if (best >= 0 && bestD * l.scale < 16) {
    l.pts.splice(best + 1, 0, bestPt);
    recomputeVectorBounds(l); draw();
  }
});

document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (e.key === 'b' || e.key === 'B') { toggleBrush(); return; }
  if (brush.active && e.key === '[') { setBrushSize(brush.size - 4); return; }
  if (brush.active && e.key === ']') { setBrushSize(brush.size + 4); return; }
  if (e.key === 'p' || e.key === 'P') { togglePen(); return; }
  if (penMode && (e.key === 'Escape' || e.key === 'Enter')) {
    if (pen.layer) finishPen(); else togglePen(false);
    draw(); return;
  }
  if (penMode && pen.layer && (e.key === 'Backspace' || e.key === 'Delete')) {
    e.preventDefault();
    if (pen.layer.pts.length > 1) { pen.layer.pts.pop(); recomputeVectorBounds(pen.layer); }
    else { deleteLayer(pen.layer.id); finishPen(); }
    draw(); return;
  }
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
    hlOn: false, hlColor: '#ffe14d', hlStyle: 'block', hlPad: 8, hlRadius: 6, hlBorderW: 0, hlBorderColor: '#000000',
    w: 10, h: 10, cx: state.w / 2, cy: state.h / 2,
    scale: 1, rotation: 0, flipH: false, opacity: 1,
  };
  if (defaultTextStyle && defaultTextStyle.style) applyTextStyle(l, defaultTextStyle.style);
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
  if (id !== state.selectedId) cropMode = false;   // leave crop mode when selection changes
  state.selectedId = id;
  syncControls();
  renderLayerList();
  draw();
}
function updateCropButton() {
  const b = document.getElementById('btn-crop-image');
  b.textContent = cropMode ? '✓ Done cropping' : '⛶ Crop image';
  b.classList.toggle('active-mode', cropMode);
}

function syncControls() {
  const l = selected();
  document.getElementById('no-selection').classList.toggle('hidden', !!l);
  document.getElementById('layer-controls').classList.toggle('hidden', !l);
  if (!l) return;
  document.getElementById('btn-remove-bg').classList.toggle('hidden', l.type !== 'image');
  document.getElementById('btn-crop-image').classList.toggle('hidden', l.type !== 'image');
  if (l.type === 'image') updateCropButton();
  document.getElementById('text-editor').classList.toggle('hidden', l.type !== 'text');
  document.getElementById('table-editor').classList.toggle('hidden', l.type !== 'table');
  document.getElementById('vector-editor').classList.toggle('hidden', l.type !== 'vector');
  document.getElementById('layer-opacity').value = Math.round(l.opacity * 100);
  if (l.type === 'vector') syncVectorPanel(l);
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
    document.getElementById('hl-on').checked = !!l.hlOn;
    document.getElementById('hl-opts').classList.toggle('hidden', !l.hlOn);
    if (l.hlColor) document.getElementById('hl-color').value = l.hlColor;
    document.getElementById('hl-pad').value = l.hlPad ?? 8;
    document.getElementById('hl-radius').value = l.hlRadius ?? 6;
    document.getElementById('hl-border-color').value = l.hlBorderColor || '#000000';
    document.getElementById('hl-border-w').value = l.hlBorderW ?? 0;
    ['block', 'marker'].forEach(s =>
      document.getElementById('hl-style-' + s).classList.toggle('active-mode', (l.hlStyle || 'block') === s));
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

function syncVectorPanel(l) {
  l = l || selected();
  if (!l || l.type !== 'vector') return;
  document.getElementById('vec-stroke').value = l.stroke || '#ffffff';
  document.getElementById('vec-stroke-w').value = l.strokeW;
  if (l.fill) document.getElementById('vec-fill').value = l.fill;
  document.getElementById('vec-dashed').checked = !!l.dashed;
  // "closed path" toggle only applies to paths (enables fill)
  const closedRow = document.getElementById('vec-closed-row');
  closedRow.classList.toggle('hidden', l.subtype !== 'path');
  document.getElementById('vec-closed').checked = !!l.closed;
  ['butt', 'round', 'square'].forEach(c =>
    document.getElementById('vec-cap-' + c).classList.toggle('active-mode', l.cap === c));
  // caps only matter for open strokes; fill only for closed shapes
  const openStroke = l.subtype === 'line' || l.subtype === 'path' || l.subtype === 'squiggle';
  document.getElementById('vec-cap-row').classList.toggle('hidden', !openStroke);
  document.getElementById('vec-fill').parentElement.classList.toggle('hidden', !isClosedVec(l));
  document.getElementById('vec-fill-none').classList.toggle('hidden', !isClosedVec(l));
  // per-subtype option groups
  const sizeOpts = l.subtype === 'rect' || l.subtype === 'ellipse' || l.subtype === 'path' || l.subtype === 'line';
  document.getElementById('vec-size-opts').classList.toggle('hidden', !sizeOpts);
  if (sizeOpts) { document.getElementById('vec-w').value = Math.round(l.w); document.getElementById('vec-h').value = Math.round(l.h); }
  document.getElementById('vec-star-opts').classList.toggle('hidden', l.subtype !== 'star');
  if (l.subtype === 'star') {
    document.getElementById('vec-spikes').value = l.points;
    document.getElementById('vec-spikes-val').textContent = l.points;
    document.getElementById('vec-inner').value = Math.round(l.inner * 100);
    document.getElementById('vec-inner-val').textContent = Math.round(l.inner * 100);
  }
  document.getElementById('vec-squiggle-opts').classList.toggle('hidden', l.subtype !== 'squiggle');
  if (l.subtype === 'squiggle') {
    document.getElementById('vec-waves').value = l.waves;
    document.getElementById('vec-waves-val').textContent = l.waves;
    document.getElementById('vec-amp').value = Math.round(l.amp);
    document.getElementById('vec-amp-val').textContent = Math.round(l.amp);
  }
}

function renderLayerList() {
  const ul = document.getElementById('layer-list');
  ul.innerHTML = '';
  // show top layer first
  [...state.layers].reverse().forEach(l => {
    const li = document.createElement('li');
    li.className = l.id === state.selectedId ? 'active' : '';
    const label = l.type === 'text' ? (l.upper ? l.text.toUpperCase() : l.text) : l.name;
    const vecIco = { line: '╱', path: '✒', rect: '▭', ellipse: '◯', star: '★', squiggle: '〜' };
    const ico = l.type === 'text' ? '🅣' : l.type === 'table' ? '▦'
      : l.type === 'vector' ? (vecIco[l.subtype] || '✒')
      : (l.subtype === 'paint' ? '🖌' : '🖼');
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
    l.crop = null;              // crop coords no longer valid against the new bitmap
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

document.getElementById('btn-crop-image').addEventListener('click', () => {
  const l = selected();
  if (!l || l.type !== 'image') { flashToast('Select an image layer'); return; }
  cropMode = !cropMode;
  if (cropMode) {
    if (brush.active) toggleBrush(false);
    if (penMode) togglePen(false);
    if (!l.crop) l.crop = { x: 0, y: 0, w: l.work.width, h: l.work.height };
  } else if (l.crop && l.crop.x === 0 && l.crop.y === 0 && l.crop.w === l.work.width && l.crop.h === l.work.height) {
    l.crop = null;  // full-frame crop is the same as no crop — keep state clean
  }
  updateCropButton();
  draw();
});

// ---------- Vector bindings ----------
[['btn-add-line', 'line'], ['btn-add-rect', 'rect'], ['btn-add-ellipse', 'ellipse'],
 ['btn-add-star', 'star'], ['btn-add-squiggle', 'squiggle'], ['btn-add-path', 'path']]
  .forEach(([id, sub]) => document.getElementById(id).addEventListener('click', () => addVectorLayer(sub)));

function bindVec(id, ev, fn) {
  document.getElementById(id).addEventListener(ev, (e) => {
    const l = selected(); if (!l || l.type !== 'vector') return;
    fn(l, e.target); recomputeVectorBounds(l); draw();
  });
}
bindVec('vec-stroke', 'input', (l, t) => l.stroke = t.value);
bindVec('vec-stroke-w', 'input', (l, t) => l.strokeW = clampInt(t.value, 0, 200));
bindVec('vec-fill', 'input', (l, t) => l.fill = t.value);
bindVec('vec-dashed', 'change', (l, t) => l.dashed = t.checked);
bindVec('vec-closed', 'change', (l, t) => {
  if (l.subtype !== 'path') return;
  l.closed = t.checked;
  if (l.closed && !l.fill) l.fill = '#6d8bff';   // give the fill something to show
  syncVectorPanel(l);
});
bindVec('vec-w', 'input', (l, t) => setVectorDim(l, 'x', clampInt(t.value, 1, 8000)));
bindVec('vec-h', 'input', (l, t) => setVectorDim(l, 'y', clampInt(t.value, 1, 8000)));
bindVec('vec-spikes', 'input', (l, t) => { l.points = clampInt(t.value, 3, 24); document.getElementById('vec-spikes-val').textContent = l.points; });
bindVec('vec-inner', 'input', (l, t) => { l.inner = clampInt(t.value, 5, 95) / 100; document.getElementById('vec-inner-val').textContent = Math.round(l.inner * 100); });
bindVec('vec-waves', 'input', (l, t) => { l.waves = clampInt(t.value, 1, 30); document.getElementById('vec-waves-val').textContent = l.waves; });
bindVec('vec-amp', 'input', (l, t) => { l.amp = clampInt(t.value, 2, 300); document.getElementById('vec-amp-val').textContent = l.amp; });
['butt', 'round', 'square'].forEach(cap =>
  document.getElementById('vec-cap-' + cap).addEventListener('click', () => {
    const l = selected(); if (!l || l.type !== 'vector') return;
    l.cap = cap; syncVectorPanel(l); draw();
  }));
document.getElementById('vec-fill-none').addEventListener('click', () => {
  const l = selected(); if (!l || l.type !== 'vector') return;
  l.fill = ''; draw();
});

// ---------- Brush tool ----------
function toggleBrush(on) {
  brush.active = on === undefined ? !brush.active : on;
  if (brush.active && penMode) togglePen(false);        // brush, pen and crop are mutually exclusive
  if (brush.active && cropMode) { cropMode = false; updateCropButton(); }
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
document.getElementById('btn-pen-toggle').addEventListener('click', () => togglePen());
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

// ---------- Text highlight ----------
bindText('hl-on', (l, t) => { l.hlOn = t.checked; document.getElementById('hl-opts').classList.toggle('hidden', !l.hlOn); });
bindText('hl-color', (l, t) => l.hlColor = t.value);
bindText('hl-pad', (l, t) => l.hlPad = clampInt(t.value, 0, 80));
bindText('hl-radius', (l, t) => l.hlRadius = clampInt(t.value, 0, 80));
bindText('hl-border-color', (l, t) => l.hlBorderColor = t.value);
bindText('hl-border-w', (l, t) => l.hlBorderW = clampInt(t.value, 0, 40));
['block', 'marker'].forEach(s =>
  document.getElementById('hl-style-' + s).addEventListener('click', () => {
    const l = selected(); if (!l || l.type !== 'text') return;
    l.hlStyle = s;
    ['block', 'marker'].forEach(x => document.getElementById('hl-style-' + x).classList.toggle('active-mode', x === s));
    draw();
  }));

// ---------- Swatches + text-style presets (persisted in localStorage) ----------
const LS = { sw: 'bgstudio_swatches', st: 'bgstudio_textStyles', def: 'bgstudio_textDefault' };
function lsGet(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }
let swatches = lsGet(LS.sw, ['#ffffff', '#000000', '#ff3b3b', '#ffe14d', '#3dd68c', '#6d8bff']);
let textStyles = lsGet(LS.st, []);        // [{ name, style }]
let defaultTextStyle = lsGet(LS.def, null);

// ---------- Keep background-remover model warm ----------
// The model (~40MB WASM/ONNX) is module-cached by @imgly/background-removal once
// loaded, but the first ✂ Remove background otherwise pays the download+init cost.
// When "Keep bg-remover loaded" is on we preload it up front and hold the promise so
// the session stays warm for the whole page life.
LS.keepModel = 'bgstudio_keepModel';
let modelWarmup = null;   // the in-flight/settled preload() promise, or null
function warmModel() {
  const el = document.getElementById('keep-model-state');
  if (!modelWarmup) {
    if (el) el.textContent = '⏳';
    modelWarmup = preload({ output: { format: 'image/png' } })
      .then(() => { if (el) el.textContent = '✓'; })
      .catch((err) => {
        console.error('model preload failed', err);
        if (el) el.textContent = '⚠';
        modelWarmup = null;   // allow a retry on next toggle/reload
      });
  }
  return modelWarmup;
}
(() => {
  const cb = document.getElementById('keep-model');
  if (!cb) return;
  cb.checked = lsGet(LS.keepModel, false);
  cb.addEventListener('change', () => {
    lsSet(LS.keepModel, cb.checked);
    if (cb.checked) warmModel();
    else document.getElementById('keep-model-state').textContent = '';
  });
  if (cb.checked) warmModel();   // resume warm on load if the user left it on
})();

const STYLE_KEYS = ['fontSize', 'color', 'stroke', 'strokeW', 'font', 'upper', 'align',
  'hlOn', 'hlColor', 'hlStyle', 'hlPad', 'hlRadius', 'hlBorderW', 'hlBorderColor'];
function extractTextStyle(l) { const s = {}; for (const k of STYLE_KEYS) s[k] = l[k]; return s; }
function applyTextStyle(l, s) { for (const k of STYLE_KEYS) if (k in s) l[k] = s[k]; }

// Which colour input the swatches apply to (updated as the user touches one).
let activeColor = { input: 'text-color', prop: 'color' };
const COLOR_TARGETS = { 'text-color': 'color', 'text-stroke': 'stroke', 'hl-color': 'hlColor' };
Object.keys(COLOR_TARGETS).forEach(id => {
  const el = document.getElementById(id);
  const set = () => { activeColor = { input: id, prop: COLOR_TARGETS[id] }; };
  el.addEventListener('focus', set); el.addEventListener('input', set);
});

function renderSwatches() {
  const row = document.getElementById('swatch-row'); row.innerHTML = '';
  swatches.forEach((col, i) => {
    const b = document.createElement('button');
    b.className = 'sw'; b.style.background = col; b.title = col + ' — shift-click to remove';
    b.addEventListener('click', (e) => {
      if (e.shiftKey) { swatches.splice(i, 1); lsSet(LS.sw, swatches); renderSwatches(); return; }
      const l = selected(); if (!l || l.type !== 'text') { flashToast('Select a text layer'); return; }
      l[activeColor.prop] = col;
      const inp = document.getElementById(activeColor.input); if (inp) inp.value = col;
      measureText(l); draw();
    });
    row.appendChild(b);
  });
}
document.getElementById('swatch-add').addEventListener('click', () => {
  const l = selected(); if (!l || l.type !== 'text') { flashToast('Select a text layer'); return; }
  const col = l[activeColor.prop] || '#ffffff';
  if (!swatches.includes(col)) { swatches.push(col); lsSet(LS.sw, swatches); renderSwatches(); flashToast('Saved swatch ' + col); }
});

function renderStyleSelect() {
  const sel = document.getElementById('text-style-select');
  sel.innerHTML = '<option value="">— saved styles —</option>';
  textStyles.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = (defaultTextStyle && defaultTextStyle.name === s.name ? '★ ' : '') + s.name;
    sel.appendChild(o);
  });
}
document.getElementById('text-style-select').addEventListener('change', (e) => {
  if (e.target.value === '') return;
  const l = selected(); if (!l || l.type !== 'text') { flashToast('Select a text layer first'); return; }
  applyTextStyle(l, textStyles[+e.target.value].style);
  measureText(l); syncControls(); draw(); renderLayerList();
});
document.getElementById('text-style-save').addEventListener('click', () => {
  const l = selected(); if (!l || l.type !== 'text') { flashToast('Select a text layer to save its style'); return; }
  const name = prompt('Name this text style:', 'Style ' + (textStyles.length + 1));
  if (!name) return;
  const entry = { name, style: extractTextStyle(l) };
  const at = textStyles.findIndex(s => s.name === name);
  if (at >= 0) textStyles[at] = entry; else textStyles.push(entry);
  lsSet(LS.st, textStyles); renderStyleSelect(); flashToast('Saved style “' + name + '”');
});
document.getElementById('text-style-default').addEventListener('click', () => {
  const sel = document.getElementById('text-style-select');
  let entry;
  if (sel.value !== '') entry = textStyles[+sel.value];
  else {
    const l = selected(); if (!l || l.type !== 'text') { flashToast('Pick a saved style, or select a text layer'); return; }
    entry = { name: '(current)', style: extractTextStyle(l) };
  }
  defaultTextStyle = entry; lsSet(LS.def, defaultTextStyle); renderStyleSelect();
  flashToast('New text will start from “' + entry.name + '”');
});
document.getElementById('text-style-del').addEventListener('click', () => {
  const sel = document.getElementById('text-style-select'); if (sel.value === '') return;
  const removed = textStyles.splice(+sel.value, 1)[0];
  if (defaultTextStyle && defaultTextStyle.name === removed.name) { defaultTextStyle = null; lsSet(LS.def, null); }
  lsSet(LS.st, textStyles); renderStyleSelect();
});

// ---------- Meme library ----------
// Bundled templates come from memes/manifest.json (same-origin → export-safe).
// "My library" (user uploads + imgflip imports) lives in IndexedDB. imgflip images
// load through serve.py's /proxy so they don't taint the canvas.
let _idb = null;
function idb() {
  if (_idb) return _idb;
  _idb = new Promise((res, rej) => {
    const r = indexedDB.open('bgstudio', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('memes', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return _idb;
}
function idbOp(mode, fn) {
  return idb().then(db => new Promise((res, rej) => {
    const tx = db.transaction('memes', mode), store = tx.objectStore('memes');
    const req = fn(store);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
}
const idbAll = () => idbOp('readonly', s => s.getAll());
const idbAdd = (rec) => idbOp('readwrite', s => s.add(rec));
const idbDel = (id) => idbOp('readwrite', s => s.delete(id));

const memeLib = { bundled: null, mine: [], tab: 'all', q: '' };

async function loadBundled() {
  if (memeLib.bundled) return;
  try { memeLib.bundled = await fetch('memes/manifest.json').then(r => r.json()); }
  catch { memeLib.bundled = []; }
}
async function loadMine() { memeLib.mine = await idbAll().catch(() => []); }

function proxied(url) { return '/proxy?url=' + encodeURIComponent(url); }
function memeSrc(it) {
  if (it.kind === 'bundled') return 'memes/img/' + it.file;
  if (it.blob) return URL.createObjectURL(it.blob);
  return proxied(it.url);
}
function memeItems() {
  const b = (memeLib.bundled || []).map(m => ({ kind: 'bundled', name: m.name, file: m.file }));
  const mine = memeLib.mine.map(r => ({ kind: 'mine', id: r.id, name: r.name, blob: r.blob, url: r.url }));
  let items = memeLib.tab === 'bundled' ? b : memeLib.tab === 'mine' ? mine : b.concat(mine);
  if (memeLib.q) { const q = memeLib.q.toLowerCase(); items = items.filter(i => i.name.toLowerCase().includes(q)); }
  return items;
}
function renderMemeGrid() {
  const grid = document.getElementById('meme-grid');
  grid.innerHTML = '';
  const items = memeItems();
  document.getElementById('meme-empty').classList.toggle('hidden', items.length > 0);
  document.getElementById('meme-count').textContent = items.length + ' memes';
  for (const it of items) {
    const cell = document.createElement('div');
    cell.className = 'meme-cell'; cell.title = it.name;
    const img = document.createElement('img');
    // lazy works for the http(s) bundled/imgflip thumbs; blob: uploads must load eagerly
    img.loading = it.blob ? 'eager' : 'lazy';
    img.src = memeSrc(it); img.alt = it.name;
    const cap = document.createElement('div'); cap.className = 'meme-name'; cap.textContent = it.name;
    cell.appendChild(img); cell.appendChild(cap);
    cell.addEventListener('click', () => addMemeToCanvas(it));
    if (it.kind === 'mine') {
      const del = document.createElement('button');
      del.className = 'meme-del'; del.textContent = '✕'; del.title = 'Remove from my library';
      del.addEventListener('click', async (e) => { e.stopPropagation(); await idbDel(it.id); await loadMine(); renderMemeGrid(); });
      cell.appendChild(del);
    }
    grid.appendChild(cell);
  }
}
async function addMemeToCanvas(it) {
  try {
    const blob = it.blob || await fetch(memeSrc(it)).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); });
    await blobToLayer(blob, it.name);
    closeMemeModal();
  } catch (err) { console.error(err); flashToast('Could not load “' + it.name + '”'); }
}
function setMemeTab(tab) {
  memeLib.tab = tab;
  ['all', 'bundled', 'mine'].forEach(t => document.getElementById('meme-tab-' + t).classList.toggle('active-mode', t === tab));
  renderMemeGrid();
}
async function openMemeModal() {
  document.getElementById('meme-modal').classList.remove('hidden');
  await loadBundled(); await loadMine();
  renderMemeGrid();
  document.getElementById('meme-search').focus();
}
function closeMemeModal() { document.getElementById('meme-modal').classList.add('hidden'); }

document.getElementById('btn-meme-library').addEventListener('click', openMemeModal);
document.getElementById('meme-close').addEventListener('click', closeMemeModal);
document.getElementById('meme-modal').addEventListener('click', (e) => { if (e.target.id === 'meme-modal') closeMemeModal(); });
document.getElementById('meme-search').addEventListener('input', (e) => { memeLib.q = e.target.value; renderMemeGrid(); });
['all', 'bundled', 'mine'].forEach(t => document.getElementById('meme-tab-' + t).addEventListener('click', () => setMemeTab(t)));
document.getElementById('meme-upload').addEventListener('change', async (e) => {
  for (const f of e.target.files) await idbAdd({ name: f.name.replace(/\.[^.]+$/, ''), blob: f });
  e.target.value = '';
  await loadMine(); setMemeTab('mine');
  flashToast('Added to your library');
});
document.getElementById('meme-import-imgflip').addEventListener('click', async () => {
  flashToast('Importing imgflip templates…');
  let list;
  try { list = await fetch(proxied('https://api.imgflip.com/get_memes')).then(r => r.json()).then(d => d.data.memes); }
  catch { flashToast('imgflip import needs the local server (serve.py) running'); return; }
  await loadMine();
  const have = new Set(memeLib.mine.map(m => m.name.toLowerCase()));
  let n = 0;
  for (const m of list) { if (have.has(m.name.toLowerCase())) continue; await idbAdd({ name: m.name, url: m.url }); n++; }
  await loadMine(); setMemeTab('mine');
  flashToast('Imported ' + n + ' imgflip templates');
});

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
const BUILD = 'build 2026-07-01 · r15 · meme-library';
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
renderSwatches();
renderStyleSelect();
