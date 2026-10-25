// BG Studio — GIF editor.
//
// The document is a *frame spine* (an ordered list of frames, each with its own
// delay) plus z-ordered layers. A layer is one of two kinds:
//
//   'cel'    its content changes per frame — a map of frame id -> canvas.
//            An imported GIF is a cel layer (one cel per source frame); so is a
//            hand-drawn animation, and so is a dropped image sequence.
//   'timed'  one piece of content (text/vector/image) that exists between
//            timeIn and timeOut and can animate over that span.
//
// That split is what lets one editor do all four jobs: caption a GIF (a cel
// layer + timed text over it), assemble frames from images, draw cel animation,
// or animate a still scene with no cel layer at all.
//
// Cels are keyed by frame *id*, never index, so inserting/reordering/deleting
// frames can't scramble which drawing belongs to which frame.
import { corners, canvasToImagePx } from './engine/geom.js';
import { measureText } from './engine/text.js';
import { recomputeVectorBounds, layerHit } from './engine/vector.js';
import { drawLayer, NO_ANIM } from './engine/render.js';
import { computeAnim, ANIM_TYPES, EASINGS } from './engine/anim.js';
import { loadImage, makeWork } from './engine/image.js';
import { serializeLayer } from './engine/serialize.js';

// ---------- State ----------
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const tl = document.getElementById('timeline');
const tlx = tl.getContext('2d');

const doc = {
  w: 480, h: 480,
  fill: '#ffffff',
  transparent: false,
  frames: [],        // [{ id, dur }] — dur in ms, the GIF-native unit
  layers: [],        // draw order: last = top
  nextId: 1,
  selectedId: null,
};

// curTime (ms into the animation) is the single source of truth for "where we
// are"; the current frame index is derived from it. Keeping a separate cur
// index in sync with a playhead time is exactly the kind of duplicated state
// that drifts.
let curTime = 0;
let playing = false, playStart = 0, playFrom = 0, rafId = 0;
let onion = { on: false, range: 1 };
let colW = 26;                       // timeline px per frame (zoom)
const brush = { mode: 'paint', size: 12, color: '#111111' };
let drag = null;                     // stage drag
let tlDrag = null;                   // timeline drag

const uid = () => doc.nextId++;
const selected = () => doc.layers.find(l => l.id === doc.selectedId) || null;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- Undo / redo ----------
// Snapshot-based, but a cel is a canvas and a document can hold hundreds of
// them, so a snapshot can't deep-copy pixels (that's megabytes per stroke) and
// can't re-encode via serializeLayer (its per-image toDataURL is far heavier
// still). Instead a snapshot copies all the *structure* by value and holds every
// canvas by *reference*, copy-on-write: mutating a cel clones it first (dirtyCel)
// so older snapshots keep pointing at the pixels they captured. Whole-canvas
// bitmaps are therefore shared until the moment they diverge.
const undoStack = [], redoStack = [];
const UNDO_LIMIT = 60;

function snapshot() {
  return {
    w: doc.w, h: doc.h, fill: doc.fill, transparent: doc.transparent,
    nextId: doc.nextId, selectedId: doc.selectedId, curTime,
    frames: doc.frames.map(f => ({ ...f })),
    layers: doc.layers.map(cloneLayerShallow),
  };
}
// Copy a layer's fields by value, but keep canvas refs shared. Nested arrays/
// objects that get mutated in place (charStyles, pts, cels map) are shallow-
// copied one level so editing them doesn't reach back into a snapshot.
function cloneLayerShallow(l) {
  const o = {};
  for (const k in l) {
    const v = l[k];
    if (v instanceof HTMLCanvasElement || v instanceof HTMLImageElement) o[k] = v;
    else if (k === 'cels') { o.cels = { ...v }; }               // id -> canvas, refs shared
    else if (Array.isArray(v)) o[k] = v.map(x => Array.isArray(x) ? x.slice() : x);
    else if (v && typeof v === 'object') o[k] = { ...v };
    else o[k] = v;
  }
  return o;
}
function restore(s) {
  doc.w = s.w; doc.h = s.h; doc.fill = s.fill; doc.transparent = s.transparent;
  doc.nextId = s.nextId; doc.selectedId = s.selectedId; curTime = s.curTime;
  doc.frames = s.frames.map(f => ({ ...f }));
  doc.layers = s.layers.map(cloneLayerShallow);
  canvas.width = doc.w; canvas.height = doc.h;
  document.getElementById('doc-w').value = doc.w;
  document.getElementById('doc-h').value = doc.h;
  syncControls(); draw(); drawTimeline(); syncFrameUI();
}
// Call *before* a mutation. Coalesces rapid same-tag edits (dragging a slider,
// one brush stroke) into a single undo entry, so undo steps read like actions.
let _lastTag = null, _lastT = 0;
function pushUndo(tag) {
  const now = performance.now();
  if (tag && tag === _lastTag && now - _lastT < 600) { _lastT = now; return; }
  _lastTag = tag; _lastT = now;
  undoStack.push(snapshot());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}
// A cel is about to be drawn into: clone it so snapshots holding the old pixels
// stay valid, and swap the clone into the live doc. This is the copy in
// copy-on-write, and the only place cel pixels are ever duplicated.
function dirtyCel(l, frameId) {
  const cur = l.cels[frameId];
  const c = document.createElement('canvas');
  c.width = l.w; c.height = l.h;
  if (cur) c.getContext('2d').drawImage(cur, 0, 0);
  l.cels[frameId] = c;
  return c;
}
function undo() {
  if (!undoStack.length) { flash('Nothing to undo'); return; }
  _lastTag = null;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) { flash('Nothing to redo'); return; }
  _lastTag = null;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Frame spine ----------
// Cumulative start time (ms) of each frame; [n] is the total duration.
function frameStarts() {
  const s = [0];
  for (const f of doc.frames) s.push(s[s.length - 1] + f.dur);
  return s;
}
function totalDur() { const s = frameStarts(); return s[s.length - 1]; }
function frameStart(i) { return frameStarts()[clamp(i, 0, doc.frames.length)]; }
// Which frame is on screen at time t. The last frame holds through the end, so
// t === total lands on the last frame rather than off the end.
function frameAt(t) {
  const s = frameStarts();
  for (let i = doc.frames.length - 1; i >= 0; i--) if (t >= s[i]) return i;
  return 0;
}
function curFrame() { return frameAt(curTime); }
function gotoFrame(i) {
  curTime = frameStart(clamp(i, 0, doc.frames.length - 1));
  draw(); drawTimeline(); syncFrameUI();
}
function newFrame(dur = 100) { return { id: uid(), dur }; }

// ---------- Cels ----------
// A frame with no cel of its own shows the nearest previous one ("hold"), which
// is how a 2s pose costs one drawing rather than sixty.
function celAt(l, fi) {
  const f = doc.frames[fi];
  if (!f) return null;
  if (l.cels[f.id]) return l.cels[f.id];
  if (l.hold === false) return null;
  for (let i = fi - 1; i >= 0; i--) {
    const c = l.cels[doc.frames[i].id];
    if (c) return c;
  }
  return null;
}
// The cel to paint into for this frame, created on demand. If the frame is
// currently showing a held cel, painting starts from a copy of it — continuing
// a drawing rather than starting from blank is nearly always what's meant.
function ensureCel(l, fi) {
  const f = doc.frames[fi];
  if (l.cels[f.id]) return l.cels[f.id];
  const c = document.createElement('canvas');
  c.width = l.w; c.height = l.h;
  const held = celAt(l, fi);
  if (held) c.getContext('2d').drawImage(held, 0, 0);
  l.cels[f.id] = c;
  return c;
}
function celCount(l) { return Object.keys(l.cels).length; }

// ---------- Rendering ----------
// Composite one frame to any context. No selection handles, no onion skin, no
// chrome of any kind — this is exactly what gets exported, and the editor's
// draw() layers its overlays on top of it rather than into it.
export function renderFrame(c, fi) {
  c.clearRect(0, 0, doc.w, doc.h);
  if (!doc.transparent) { c.fillStyle = doc.fill; c.fillRect(0, 0, doc.w, doc.h); }
  const t = frameStart(fi);
  for (const l of doc.layers) {
    if (l.hidden) continue;
    if (l.kind === 'cel') {
      const cel = celAt(l, fi);
      if (!cel) continue;
      l.img = cel;                  // the cel *is* this layer's image for this frame
      drawLayer(c, l, NO_ANIM, doc);
    } else {
      if (t < l.timeIn || t >= l.timeOut) continue;
      drawLayer(c, l, computeAnim(l, t, doc.w, doc.h), doc);
    }
  }
}

function renderToCanvas(fi) {
  const off = document.createElement('canvas');
  off.width = doc.w; off.height = doc.h;
  renderFrame(off.getContext('2d'), fi);
  return off;
}

// Editor view: the frame, plus onion skin under it and handles over it.
function draw() {
  const fi = curFrame();
  ctx.clearRect(0, 0, doc.w, doc.h);
  if (!doc.transparent) { ctx.fillStyle = doc.fill; ctx.fillRect(0, 0, doc.w, doc.h); }
  if (onion.on && !playing) drawOnion(fi);
  // Re-render the frame *over* the onion skin. Cheaper and simpler than
  // interleaving: renderFrame already knows how to paint everything.
  const f = renderToCanvas(fi);
  ctx.drawImage(f, 0, 0);
  if (!playing) {
    const l = selected();
    if (l) drawHandles(l);
  }
}

// Ghosts of neighbouring frames' cel layers — red behind, green ahead, fading
// with distance. Only cel layers: a timed layer is continuous, so onion-skinning
// it would just smear it.
function drawOnion(fi) {
  const celLayers = doc.layers.filter(l => l.kind === 'cel' && !l.hidden);
  if (!celLayers.length) return;
  for (let d = onion.range; d >= 1; d--) {
    for (const dir of [-1, 1]) {
      const j = fi + d * dir;
      if (j < 0 || j >= doc.frames.length) continue;
      ctx.save();
      ctx.globalAlpha = 0.32 / d;
      for (const l of celLayers) {
        const cel = celAt(l, j);
        if (!cel) continue;
        const tint = document.createElement('canvas');
        tint.width = cel.width; tint.height = cel.height;
        const tc = tint.getContext('2d');
        tc.drawImage(cel, 0, 0);
        tc.globalCompositeOperation = 'source-in';
        tc.fillStyle = dir < 0 ? '#ff4d4d' : '#3dd68c';
        tc.fillRect(0, 0, tint.width, tint.height);
        const prev = l.img; l.img = tint;
        drawLayer(ctx, l, NO_ANIM, doc);
        l.img = prev;
      }
      ctx.restore();
    }
  }
}

const ACCENT = '#6d8bff';
function drawHandles(l) {
  const pts = corners(l);
  ctx.save();
  ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath(); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#0f1115';
  for (const [x, y] of pts) {
    ctx.beginPath(); ctx.rect(x - 5, y - 5, 10, 10); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

// ---------- Timeline ----------
// Canvas, not DOM: a row per layer with a marker per frame is hundreds of
// elements that all move when you drag one bar.
//
// Frames are equal-width columns regardless of their delay — that's how frames
// read as *frames*, and it's what makes a 500ms hold as clickable as a 20ms one.
// Timed layers keep millisecond extents, mapped through the cumulative frame
// times, so the two coordinate systems meet in msToX/xToMs and nowhere else.
const GUTTER = 130, RULER_H = 22, ROW_H = 26, PAD_R = 40;

function tlWidth() { return GUTTER + doc.frames.length * colW + PAD_R; }
function tlHeight() { return RULER_H + Math.max(doc.layers.length, 1) * ROW_H + 8; }

function msToX(ms) {
  const s = frameStarts();
  const total = s[s.length - 1];
  if (ms >= total) return GUTTER + doc.frames.length * colW;
  const i = frameAt(ms);
  const frac = doc.frames[i].dur ? (ms - s[i]) / doc.frames[i].dur : 0;
  return GUTTER + (i + frac) * colW;
}
function xToMs(x) {
  const col = (x - GUTTER) / colW;
  const i = clamp(Math.floor(col), 0, doc.frames.length - 1);
  const s = frameStarts();
  return clamp(s[i] + (col - i) * doc.frames[i].dur, 0, totalDur());
}
// Snap a time to the nearest frame boundary — trimming a layer to land mid-frame
// is never meaningful, since a frame is the smallest thing a GIF can show.
function snapMs(ms) {
  const s = frameStarts();
  let best = s[0];
  for (const v of s) if (Math.abs(v - ms) < Math.abs(best - ms)) best = v;
  return best;
}

function drawTimeline() {
  tl.width = tlWidth(); tl.height = tlHeight();
  const W = tl.width, H = tl.height;
  tlx.fillStyle = '#1a1d24'; tlx.fillRect(0, 0, W, H);

  // Frame columns + ruler
  const s = frameStarts();
  for (let i = 0; i < doc.frames.length; i++) {
    const x = GUTTER + i * colW;
    const cur = i === curFrame();
    tlx.fillStyle = cur ? '#232c44' : (i % 2 ? '#1e222b' : '#1a1d24');
    tlx.fillRect(x, 0, colW, H);
    tlx.strokeStyle = '#2c313d'; tlx.lineWidth = 1;
    tlx.beginPath(); tlx.moveTo(x + .5, 0); tlx.lineTo(x + .5, H); tlx.stroke();
    // Number every frame when there's room, else every 5th.
    const showNum = colW >= 22 || i % 5 === 0;
    if (showNum) {
      tlx.fillStyle = cur ? '#cdd7ff' : '#8b93a4';
      tlx.font = '10px ui-monospace, Consolas, monospace';
      tlx.textAlign = 'center'; tlx.textBaseline = 'middle';
      tlx.fillText(String(i + 1), x + colW / 2, RULER_H / 2);
    }
  }
  tlx.strokeStyle = '#2c313d';
  tlx.beginPath(); tlx.moveTo(0, RULER_H + .5); tlx.lineTo(W, RULER_H + .5); tlx.stroke();

  // Rows
  doc.layers.forEach((l, idx) => {
    const y = RULER_H + idx * ROW_H;
    const isSel = l.id === doc.selectedId;
    if (isSel) { tlx.fillStyle = 'rgba(109,139,255,.10)'; tlx.fillRect(GUTTER, y, W - GUTTER, ROW_H); }
    if (l.kind === 'cel') drawCelRow(l, y);
    else drawTimedRow(l, y, isSel);
  });

  // Gutter (drawn last so bars can't bleed into it)
  tlx.fillStyle = '#161922'; tlx.fillRect(0, 0, GUTTER, H);
  tlx.strokeStyle = '#2c313d';
  tlx.beginPath(); tlx.moveTo(GUTTER + .5, 0); tlx.lineTo(GUTTER + .5, H); tlx.stroke();
  doc.layers.forEach((l, idx) => {
    const y = RULER_H + idx * ROW_H;
    const isSel = l.id === doc.selectedId;
    if (isSel) { tlx.fillStyle = '#232c44'; tlx.fillRect(0, y, GUTTER, ROW_H); }
    tlx.fillStyle = l.hidden ? '#4a505e' : (isSel ? '#cdd7ff' : '#e6e9ef');
    tlx.font = '11px system-ui, sans-serif';
    tlx.textAlign = 'left'; tlx.textBaseline = 'middle';
    const icon = l.hidden ? '🚫' : (l.kind === 'cel' ? '🎞' : l.type === 'text' ? 'T' : l.type === 'vector' ? '◇' : '🖼');
    tlx.fillText(icon + '  ' + trunc(l.name || l.type, 13), 8, y + ROW_H / 2);
    tlx.strokeStyle = '#2c313d';
    tlx.beginPath(); tlx.moveTo(0, y + ROW_H + .5); tlx.lineTo(W, y + ROW_H + .5); tlx.stroke();
  });

  // Playhead
  const px = msToX(curTime);
  tlx.strokeStyle = '#ff7a1a'; tlx.lineWidth = 2;
  tlx.beginPath(); tlx.moveTo(px, 0); tlx.lineTo(px, H); tlx.stroke();
  tlx.fillStyle = '#ff7a1a';
  tlx.beginPath();
  tlx.moveTo(px - 5, 0); tlx.lineTo(px + 5, 0); tlx.lineTo(px, 7); tlx.closePath(); tlx.fill();
}

function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// A cel row shows where the drawings actually are: a solid block on frames with
// their own cel, a faint one where a cel is being held.
function drawCelRow(l, y) {
  for (let i = 0; i < doc.frames.length; i++) {
    const x = GUTTER + i * colW;
    const own = !!l.cels[doc.frames[i].id];
    const held = !own && !!celAt(l, i);
    if (!own && !held) continue;
    tlx.fillStyle = own ? '#4f6cf0' : 'rgba(109,139,255,.22)';
    tlx.fillRect(x + 2, y + 5, colW - 4, ROW_H - 11);
    if (own) {
      tlx.fillStyle = '#cdd7ff';
      tlx.beginPath(); tlx.arc(x + colW / 2, y + ROW_H / 2, 2, 0, Math.PI * 2); tlx.fill();
    }
  }
}

function drawTimedRow(l, y, isSel) {
  const x0 = msToX(l.timeIn), x1 = msToX(l.timeOut);
  const w = Math.max(3, x1 - x0);
  tlx.save();
  tlx.fillStyle = isSel ? '#4f6cf0' : '#39507f';
  roundRect(tlx, x0, y + 5, w, ROW_H - 11, 4); tlx.fill();
  // Entry/exit ramps, so you can see the animation without opening a panel.
  tlx.fillStyle = 'rgba(255,255,255,.22)';
  if (l.entryType && l.entryType !== 'none' && l.entryDuration > 0) {
    const ew = Math.min(w, msToX(l.timeIn + l.entryDuration) - x0);
    tlx.beginPath(); tlx.moveTo(x0, y + ROW_H - 6); tlx.lineTo(x0 + ew, y + ROW_H - 6); tlx.lineTo(x0 + ew, y + 5); tlx.closePath(); tlx.fill();
  }
  if (l.exitType && l.exitType !== 'none' && l.exitDuration > 0) {
    const xw = Math.min(w, x1 - msToX(l.timeOut - l.exitDuration));
    tlx.beginPath(); tlx.moveTo(x1, y + ROW_H - 6); tlx.lineTo(x1 - xw, y + ROW_H - 6); tlx.lineTo(x1 - xw, y + 5); tlx.closePath(); tlx.fill();
  }
  // Trim handles
  tlx.fillStyle = isSel ? '#cdd7ff' : '#8b93a4';
  tlx.fillRect(x0 + 1, y + 8, 2, ROW_H - 17);
  tlx.fillRect(x1 - 3, y + 8, 2, ROW_H - 17);
  tlx.restore();
}

function roundRect(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

// ---------- Timeline interaction ----------
const EDGE = 5;   // px of a bar's end that grabs the trim handle
function tlPos(e) {
  const r = tl.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
function rowAt(y) {
  if (y < RULER_H) return -1;
  const i = Math.floor((y - RULER_H) / ROW_H);
  return i >= 0 && i < doc.layers.length ? i : -1;
}

tl.addEventListener('pointerdown', e => {
  const [x, y] = tlPos(e);
  const row = rowAt(y);
  // Gutter click = select the layer, or toggle its visibility via the icon.
  if (x < GUTTER) {
    if (row < 0) return;
    const l = doc.layers[row];
    if (x < 26) { pushUndo(null); l.hidden = !l.hidden; draw(); drawTimeline(); return; }
    selectLayer(l.id);
    return;
  }
  if (row >= 0) {
    const l = doc.layers[row];
    if (l.kind === 'timed') {
      const x0 = msToX(l.timeIn), x1 = msToX(l.timeOut);
      if (x >= x0 - EDGE && x <= x1 + EDGE) {
        selectLayer(l.id);
        pushUndo(null);   // one drag = one undo step
        const mode = x <= x0 + EDGE ? 'trimL' : x >= x1 - EDGE ? 'trimR' : 'move';
        tlDrag = { id: l.id, mode, x, timeIn: l.timeIn, timeOut: l.timeOut };
        tl.setPointerCapture(e.pointerId);
        return;
      }
    } else {
      selectLayer(l.id);
    }
  }
  // Anywhere else: scrub.
  tlDrag = { mode: 'seek' };
  tl.setPointerCapture(e.pointerId);
  seekTo(x);
});

tl.addEventListener('pointermove', e => {
  const [x, y] = tlPos(e);
  if (!tlDrag) {
    // Hover cursor: trim vs move vs scrub.
    const row = rowAt(y);
    let cur = 'default';
    if (x < GUTTER) cur = row >= 0 ? 'pointer' : 'default';
    else if (row >= 0 && doc.layers[row].kind === 'timed') {
      const l = doc.layers[row];
      const x0 = msToX(l.timeIn), x1 = msToX(l.timeOut);
      if (x >= x0 - EDGE && x <= x1 + EDGE) cur = (x <= x0 + EDGE || x >= x1 - EDGE) ? 'ew-resize' : 'grab';
    }
    tl.style.cursor = cur;
    return;
  }
  if (tlDrag.mode === 'seek') { seekTo(x); return; }
  const l = doc.layers.find(v => v.id === tlDrag.id);
  if (!l) return;
  const dms = xToMs(x) - xToMs(tlDrag.x);
  const total = totalDur();
  if (tlDrag.mode === 'move') {
    const span = tlDrag.timeOut - tlDrag.timeIn;
    let inMs = snapMs(clamp(tlDrag.timeIn + dms, 0, total - span));
    l.timeIn = inMs; l.timeOut = inMs + span;
  } else if (tlDrag.mode === 'trimL') {
    l.timeIn = clamp(snapMs(tlDrag.timeIn + dms), 0, l.timeOut - 1);
  } else {
    l.timeOut = clamp(snapMs(tlDrag.timeOut + dms), l.timeIn + 1, total);
  }
  drawTimeline(); draw(); syncTimingUI();
});

const endTlDrag = () => { tlDrag = null; };
tl.addEventListener('pointerup', endTlDrag);
tl.addEventListener('pointercancel', endTlDrag);

function seekTo(x) {
  stop();
  curTime = xToMs(x);
  draw(); drawTimeline(); syncFrameUI();
}

// ---------- Stage interaction ----------
function stagePos(e) {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * (doc.w / r.width), (e.clientY - r.top) * (doc.h / r.height)];
}
function cornerAt(l, px, py) {
  const pts = corners(l);
  for (let i = 0; i < 4; i++) {
    if (Math.hypot(pts[i][0] - px, pts[i][1] - py) <= 9) return i;
  }
  return -1;
}
// Is this layer visible at the current frame? Clicking through an invisible
// layer is what you want; grabbing one you can't see is not.
function activeNow(l) {
  if (l.hidden) return false;
  if (l.kind === 'cel') return !!celAt(l, curFrame());
  const t = frameStart(curFrame());
  return t >= l.timeIn && t < l.timeOut;
}
function pick(px, py) {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (!activeNow(l)) continue;
    if (layerHit(l, px, py)) return l;
  }
  return null;
}

canvas.addEventListener('pointerdown', e => {
  const [px, py] = stagePos(e);
  const l = selected();
  // A drawing layer swallows the pointer: you're painting, not arranging.
  if (l && l.kind === 'cel' && l.draw && activeNow(l)) {
    canvas.setPointerCapture(e.pointerId);
    pushUndo(null);   // a stroke is one undo step; force a fresh snapshot
    drag = { mode: 'paint', id: l.id, last: [px, py] };
    paintAt(l, px, py, px, py, true);
    return;
  }
  if (l && activeNow(l)) {
    const ci = cornerAt(l, px, py);
    if (ci >= 0) {
      canvas.setPointerCapture(e.pointerId);
      pushUndo(null);
      drag = { mode: 'scale', id: l.id, scale0: l.scale, d0: Math.hypot(px - l.cx, py - l.cy) || 1 };
      return;
    }
  }
  const hit = pick(px, py);
  selectLayer(hit ? hit.id : null);
  if (hit) {
    canvas.setPointerCapture(e.pointerId);
    pushUndo(null);
    drag = { mode: 'move', id: hit.id, dx: px - hit.cx, dy: py - hit.cy };
  }
});

canvas.addEventListener('pointermove', e => {
  const [px, py] = stagePos(e);
  if (!drag) {
    const l = selected();
    canvas.style.cursor = (l && l.kind === 'cel' && l.draw && activeNow(l)) ? 'crosshair'
      : (l && activeNow(l) && cornerAt(l, px, py) >= 0) ? 'nwse-resize'
      : pick(px, py) ? 'move' : 'default';
    return;
  }
  const l = doc.layers.find(v => v.id === drag.id);
  if (!l) return;
  if (drag.mode === 'move') { l.cx = px - drag.dx; l.cy = py - drag.dy; }
  else if (drag.mode === 'scale') {
    const d = Math.hypot(px - l.cx, py - l.cy);
    l.scale = clamp(drag.scale0 * (d / drag.d0), 0.02, 40);
    if (l.type === 'text') measureText(l);
  } else if (drag.mode === 'paint') {
    paintAt(l, drag.last[0], drag.last[1], px, py, false);
    drag.last = [px, py];
  }
  draw();
});
const endDrag = () => { if (drag) { drag = null; drawTimeline(); } };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// Paint a segment into the current frame's cel, in the cel's own pixel space.
// The very first segment of a stroke marks the cel copy-on-write, so undo can
// restore the pre-stroke pixels; the rest of the stroke draws into that copy.
function paintAt(l, x0, y0, x1, y1, first) {
  ensureCel(l, curFrame());
  const fid = doc.frames[curFrame()].id;
  const cel = first ? dirtyCel(l, fid) : l.cels[fid];
  const c = cel.getContext('2d');
  const [ix0, iy0] = canvasToImagePx(l, x0, y0);
  const [ix1, iy1] = canvasToImagePx(l, x1, y1);
  c.save();
  c.globalCompositeOperation = brush.mode === 'erase' ? 'destination-out' : 'source-over';
  c.strokeStyle = brush.color;
  c.fillStyle = brush.color;
  c.lineWidth = brush.size / l.scale;
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.beginPath(); c.moveTo(ix0, iy0); c.lineTo(ix1, iy1); c.stroke();
  c.restore();
}

// ---------- Playback ----------
function play() {
  if (playing || doc.frames.length < 2) return;
  playing = true;
  playFrom = curTime >= totalDur() ? 0 : curTime;
  playStart = performance.now();
  document.getElementById('btn-play').textContent = '⏸ Pause';
  loop();
}
function stop() {
  if (!playing) return;
  playing = false;
  cancelAnimationFrame(rafId);
  document.getElementById('btn-play').textContent = '▶ Play';
  draw();
}
function loop() {
  if (!playing) return;
  const total = totalDur();
  let t = playFrom + (performance.now() - playStart);
  if (t >= total) {
    if (document.getElementById('loop-on').checked) {
      playFrom = 0; playStart = performance.now(); t = 0;
    } else { curTime = total; stop(); drawTimeline(); syncFrameUI(); return; }
  }
  curTime = t;
  draw(); drawTimeline(); syncFrameUI();
  rafId = requestAnimationFrame(loop);
}

// ---------- Layers ----------
// Timing defaults for a new timed layer: span everything that currently exists.
function timedDefaults() {
  return {
    kind: 'timed',
    timeIn: 0, timeOut: Math.max(totalDur(), 100),
    entryType: 'none', entryDuration: 400, entryEasing: 'easeOut', entryFadeDir: '',
    exitType: 'none', exitDuration: 300, exitEasing: 'easeIn', exitFadeDir: '',
    scaleAnimOn: false, scaleFrom: 1, scaleTo: 1, scaleEasing: 'easeInOut',
    revealKeyframes: [],
  };
}
function addLayer(l) {
  pushUndo(null);
  doc.layers.push(l);
  selectLayer(l.id);
  draw(); drawTimeline();
  return l;
}
function addText() {
  const l = {
    id: uid(), type: 'text', name: 'text', ...timedDefaults(),
    text: 'YOUR TEXT', fontSize: 48, color: '#ffffff', stroke: '#000000', strokeW: 6,
    font: "Impact, 'Arial Black', sans-serif",
    upper: true, align: 'center', bold: true, italic: false, underline: false,
    charStyles: [], autoFit: true, maxLines: 3,
    hlOn: false, hlColor: '#ffe14d', hlStyle: 'block', hlPad: 8, hlRadius: 6, hlBorderW: 0, hlBorderColor: '#000000',
    w: Math.round(doc.w * 0.86), h: Math.round(doc.h * 0.22),
    cx: doc.w / 2, cy: doc.h * 0.84,
    scale: 1, rotation: 0, flipH: false, opacity: 1,
  };
  measureText(l);
  return addLayer(l);
}
function addVector(subtype) {
  const d = Math.min(doc.w, doc.h);
  const l = {
    id: uid(), type: 'vector', subtype, name: subtype, ...timedDefaults(),
    stroke: '#ffd23b', strokeW: 6, fill: '#6d8bff',
    cap: 'round', join: 'round', dashed: false,
    cx: doc.w / 2, cy: doc.h / 2,
    scale: 1, rotation: 0, flipH: false, opacity: 1,
  };
  if (subtype === 'rect') { l.w = d * 0.4; l.h = d * 0.28; }
  else if (subtype === 'ellipse') { l.w = d * 0.34; l.h = d * 0.34; }
  else if (subtype === 'star') { l.points = 5; l.inner = 0.5; l.radius = d * 0.22; l.fill = '#ffd23b'; l.stroke = '#f0a500'; }
  recomputeVectorBounds(l);
  return addLayer(l);
}
function addImageLayer(img, name) {
  const work = makeWork(img);
  const s = Math.min(doc.w / work.width, doc.h / work.height, 1);
  const l = {
    id: uid(), type: 'image', name: name || 'image', ...timedDefaults(),
    baseImg: img, work, img: work,
    w: work.width, h: work.height,
    cx: doc.w / 2, cy: doc.h / 2,
    scale: s, rotation: 0, flipH: false, opacity: 1,
  };
  return addLayer(l);
}
// A cel layer. `draw:true` marks it as a hand-drawing target (the pointer paints
// into it instead of moving it).
function makeCelLayer(name, w, h, isDraw) {
  return {
    id: uid(), kind: 'cel', type: 'image', name,
    cels: {}, hold: true, draw: !!isDraw,
    img: null, w, h,
    cx: doc.w / 2, cy: doc.h / 2,
    scale: 1, rotation: 0, flipH: false, opacity: 1,
  };
}
function addDrawLayer() {
  const l = makeCelLayer('drawing', doc.w, doc.h, true);
  ensureCel(l, curFrame());
  return addLayer(l);
}

function selectLayer(id) {
  doc.selectedId = id;
  syncControls();
  draw(); drawTimeline();
}
function deleteLayer() {
  const l = selected(); if (!l) return;
  pushUndo(null);
  doc.layers = doc.layers.filter(v => v.id !== l.id);
  selectLayer(null);
}
function moveLayer(dir) {
  const i = doc.layers.findIndex(l => l.id === doc.selectedId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= doc.layers.length) return;
  pushUndo(null);
  [doc.layers[i], doc.layers[j]] = [doc.layers[j], doc.layers[i]];
  draw(); drawTimeline();
}

// ---------- Frame ops ----------
// Layers that spanned the whole animation should still span it after the frame
// count changes — otherwise every added frame silently truncates your caption.
function withSpanPreserved(fn) {
  const before = totalDur();
  const spanners = doc.layers.filter(l => l.kind === 'timed' && l.timeOut >= before);
  fn();
  const after = totalDur();
  for (const l of spanners) l.timeOut = after;
  for (const l of doc.layers) if (l.kind === 'timed') { l.timeIn = clamp(l.timeIn, 0, after); l.timeOut = clamp(l.timeOut, l.timeIn, after); }
}
function addFrame(dup) {
  pushUndo(null);
  const fi = curFrame();
  const src = doc.frames[fi];
  const f = newFrame(src ? src.dur : 100);
  withSpanPreserved(() => doc.frames.splice(fi + 1, 0, f));
  if (dup) {
    for (const l of doc.layers) {
      if (l.kind !== 'cel') continue;
      const cel = l.cels[src.id];
      if (!cel) continue;
      const c = document.createElement('canvas');
      c.width = cel.width; c.height = cel.height;
      c.getContext('2d').drawImage(cel, 0, 0);
      l.cels[f.id] = c;
    }
  }
  gotoFrame(fi + 1);
}
function delFrame() {
  if (doc.frames.length <= 1) { flash('A GIF needs at least one frame'); return; }
  pushUndo(null);
  const fi = curFrame();
  const [f] = doc.frames.splice(fi, 1);
  for (const l of doc.layers) if (l.kind === 'cel') delete l.cels[f.id];
  withSpanPreserved(() => {});
  gotoFrame(Math.min(fi, doc.frames.length - 1));
}

// ---------- UI ----------
function flash(msg, ms = 1700) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.style.opacity = '1'; t.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(-50%) translateY(12px)'; }, ms);
}

function syncFrameUI() {
  const fi = curFrame(), n = doc.frames.length;
  const total = totalDur();
  document.getElementById('transport-pos').textContent =
    `frame ${fi + 1}/${n} · ${(curTime / 1000).toFixed(2)}s / ${(total / 1000).toFixed(2)}s`;
  const f = doc.frames[fi];
  if (f) {
    document.getElementById('frame-dur').value = f.dur;
    document.getElementById('frame-dur-val').textContent = f.dur + 'ms';
  }
  const fps = f && f.dur ? (1000 / f.dur) : 0;
  document.getElementById('frame-info').textContent =
    `${n} frame${n === 1 ? '' : 's'} · ${(total / 1000).toFixed(2)}s total · this frame ≈ ${fps.toFixed(1)} fps`;
}

function syncTimingUI() {
  const l = selected();
  if (!l || l.kind !== 'timed') return;
  const s = frameStarts();
  const near = ms => { let bi = 0; for (let i = 0; i < s.length; i++) if (Math.abs(s[i] - ms) < Math.abs(s[bi] - ms)) bi = i; return bi; };
  document.getElementById('t-in').value = near(l.timeIn);
  document.getElementById('t-out').value = near(l.timeOut);
  document.getElementById('entry-type').value = l.entryType;
  document.getElementById('entry-ease').value = l.entryEasing;
  document.getElementById('entry-dur').value = l.entryDuration;
  document.getElementById('entry-dur-val').textContent = l.entryDuration + 'ms';
  document.getElementById('exit-type').value = l.exitType;
  document.getElementById('exit-ease').value = l.exitEasing;
  document.getElementById('exit-dur').value = l.exitDuration;
  document.getElementById('exit-dur-val').textContent = l.exitDuration + 'ms';
  document.getElementById('entry-fade-dir').value = l.entryFadeDir || '';
  document.getElementById('exit-fade-dir').value = l.exitFadeDir || '';
  syncFadeDirVis(l);
}
// The direction picker only means something while the motion is a fade.
function syncFadeDirVis(l) {
  document.getElementById('entry-fade-wrap').classList.toggle('hidden', l.entryType !== 'fade');
  document.getElementById('exit-fade-wrap').classList.toggle('hidden', l.exitType !== 'fade');
}

function syncControls() {
  const l = selected();
  document.getElementById('no-selection').classList.toggle('hidden', !!l);
  document.getElementById('layer-controls').classList.toggle('hidden', !l);
  if (!l) return;
  document.getElementById('text-editor').classList.toggle('hidden', l.type !== 'text');
  document.getElementById('timing-editor').classList.toggle('hidden', l.kind !== 'timed');
  document.getElementById('cel-editor').classList.toggle('hidden', !(l.kind === 'cel' && l.draw));
  if (l.type === 'text') {
    document.getElementById('text-value').value = l.text;
    document.getElementById('text-color').value = l.color;
    document.getElementById('text-stroke').value = l.stroke;
    document.getElementById('text-stroke-w').value = l.strokeW;
    document.getElementById('text-font').value = l.font;
    document.getElementById('text-upper').checked = !!l.upper;
  }
  if (l.kind === 'timed') syncTimingUI();
  document.getElementById('layer-opacity').value = Math.round(l.opacity * 100);
  document.getElementById('op-val').textContent = Math.round(l.opacity * 100) + '%';
}

// A small font set for now; the full font browser still lives in app.js and
// wants extracting into engine/fonts.js before both editors can share it.
const FONTS = [
  ["Impact, 'Arial Black', sans-serif", 'Impact (meme)'],
  ['Anton, Impact, sans-serif', 'Anton'],
  ['"Comic Sans MS", cursive', 'Comic Sans'],
  ['Arial, Helvetica, sans-serif', 'Arial'],
  ['Georgia, serif', 'Georgia'],
  ["'Courier New', monospace", 'Courier'],
  ['system-ui, sans-serif', 'System'],
];
function fillSelect(id, pairs, val) {
  const s = document.getElementById(id);
  s.innerHTML = '';
  for (const [v, label] of pairs) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    s.appendChild(o);
  }
  if (val != null) s.value = val;
}

// Re-layout the stage and everything measured against it.
function resizeDoc(w, h) {
  doc.w = clamp(w, 16, 2000); doc.h = clamp(h, 16, 2000);
  canvas.width = doc.w; canvas.height = doc.h;
  draw(); drawTimeline();
}

// ---------- Bindings ----------
const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);
// Every layer-property edit is undoable; the id is the coalescing tag, so a
// slider dragged through 30 values collapses to one undo step but changing the
// colour and then the font are two.
const bindLayer = (id, ev, fn) => on(id, ev, e => {
  const l = selected(); if (!l) return;
  pushUndo('edit:' + id);
  fn(l, e.target);
  draw(); drawTimeline();
});

on('btn-undo', 'click', undo);
on('btn-redo', 'click', redo);
on('btn-play', 'click', () => playing ? stop() : play());
on('btn-prev', 'click', () => { stop(); gotoFrame(curFrame() - 1); });
on('btn-next', 'click', () => { stop(); gotoFrame(curFrame() + 1); });
on('tl-zoom', 'input', e => { colW = +e.target.value; drawTimeline(); });

on('btn-frame-add', 'click', () => { stop(); addFrame(false); });
on('btn-frame-dup', 'click', () => { stop(); addFrame(true); });
on('btn-frame-del', 'click', () => { stop(); delFrame(); });
on('frame-dur', 'input', e => {
  const f = doc.frames[curFrame()]; if (!f) return;
  pushUndo('frame-dur');
  withSpanPreserved(() => { f.dur = +e.target.value; });
  document.getElementById('frame-dur-val').textContent = f.dur + 'ms';
  drawTimeline(); syncFrameUI();
});
on('btn-dur-all', 'click', () => {
  const d = doc.frames[curFrame()].dur;
  withSpanPreserved(() => { for (const f of doc.frames) f.dur = d; });
  drawTimeline(); syncFrameUI();
  flash(`Every frame set to ${d}ms`);
});
on('onion-on', 'input', e => {
  onion.on = e.target.checked;
  document.getElementById('onion-opts').classList.toggle('hidden', !onion.on);
  draw();
});
on('onion-range', 'input', e => {
  onion.range = +e.target.value;
  document.getElementById('onion-range-val').textContent = onion.range;
  draw();
});

on('btn-add-text', 'click', () => addText());
on('btn-add-draw', 'click', () => addDrawLayer());
on('btn-add-rect', 'click', () => addVector('rect'));
on('btn-add-ellipse', 'click', () => addVector('ellipse'));
on('btn-add-star', 'click', () => addVector('star'));
on('btn-layer-del', 'click', deleteLayer);
on('btn-layer-up', 'click', () => moveLayer(1));
on('btn-layer-down', 'click', () => moveLayer(-1));

bindLayer('text-value', 'input', (l, t) => { l.text = t.value; measureText(l); });
bindLayer('text-color', 'input', (l, t) => l.color = t.value);
bindLayer('text-stroke', 'input', (l, t) => l.stroke = t.value);
bindLayer('text-stroke-w', 'input', (l, t) => { l.strokeW = clamp(+t.value, 0, 40); measureText(l); });
bindLayer('text-font', 'input', (l, t) => { l.font = t.value; measureText(l); });
bindLayer('text-upper', 'input', (l, t) => { l.upper = t.checked; measureText(l); });
bindLayer('layer-opacity', 'input', (l, t) => {
  l.opacity = +t.value / 100;
  document.getElementById('op-val').textContent = t.value + '%';
});

bindLayer('t-in', 'input', (l, t) => { l.timeIn = clamp(frameStart(+t.value), 0, l.timeOut - 1); });
bindLayer('t-out', 'input', (l, t) => {
  const i = clamp(+t.value, 1, doc.frames.length);
  l.timeOut = clamp(i >= doc.frames.length ? totalDur() : frameStart(i), l.timeIn + 1, totalDur());
});
on('btn-span-all', 'click', () => {
  const l = selected(); if (!l || l.kind !== 'timed') return;
  l.timeIn = 0; l.timeOut = totalDur();
  draw(); drawTimeline(); syncTimingUI();
});
bindLayer('entry-type', 'input', (l, t) => { l.entryType = t.value; syncFadeDirVis(l); });
bindLayer('entry-fade-dir', 'input', (l, t) => l.entryFadeDir = t.value);
bindLayer('exit-fade-dir', 'input', (l, t) => l.exitFadeDir = t.value);
bindLayer('entry-ease', 'input', (l, t) => l.entryEasing = t.value);
bindLayer('entry-dur', 'input', (l, t) => {
  l.entryDuration = +t.value;
  document.getElementById('entry-dur-val').textContent = t.value + 'ms';
});
bindLayer('exit-type', 'input', (l, t) => { l.exitType = t.value; syncFadeDirVis(l); });
bindLayer('exit-ease', 'input', (l, t) => l.exitEasing = t.value);
bindLayer('exit-dur', 'input', (l, t) => {
  l.exitDuration = +t.value;
  document.getElementById('exit-dur-val').textContent = t.value + 'ms';
});

on('cel-paint', 'click', () => setBrushMode('paint'));
on('cel-erase', 'click', () => setBrushMode('erase'));
function setBrushMode(m) {
  brush.mode = m;
  document.getElementById('cel-paint').classList.toggle('active-mode', m === 'paint');
  document.getElementById('cel-erase').classList.toggle('active-mode', m === 'erase');
}
on('cel-size', 'input', e => {
  brush.size = +e.target.value;
  document.getElementById('cel-size-val').textContent = brush.size;
});
on('cel-color', 'input', e => brush.color = e.target.value);
on('btn-cel-clear', 'click', () => {
  const l = selected(); if (!l || l.kind !== 'cel') return;
  pushUndo(null);
  const f = doc.frames[curFrame()];
  delete l.cels[f.id];
  draw(); drawTimeline();
});

on('doc-w', 'input', e => resizeDoc(+e.target.value, doc.h));
on('doc-h', 'input', e => resizeDoc(doc.w, +e.target.value));
on('doc-fill', 'input', e => { pushUndo('doc-fill'); doc.fill = e.target.value; doc.transparent = false; draw(); });
on('btn-doc-transparent', 'click', () => {
  pushUndo(null);
  doc.transparent = !doc.transparent;
  document.getElementById('btn-doc-transparent').classList.toggle('active-mode', doc.transparent);
  draw();
});
on('btn-new-doc', 'click', () => { if (confirm('Clear everything and start over?')) reset(); });

on('file-add', 'change', async e => {
  const f = e.target.files[0]; if (!f) return;
  const img = await loadImage(URL.createObjectURL(f));
  addImageLayer(img, f.name.replace(/\.[^.]+$/, ''));
  e.target.value = '';
});

// ---------- Import ----------
// Caps. A cel layer holds one canvas per frame, so an unbounded import is an
// unbounded pile of bitmaps: 300 frames at 640x640 is already ~300MB. Source
// pixels beyond the canvas size are wasted anyway, since the cel is drawn
// through the layer transform.
const MAX_IMPORT_DIM = 640;
const MAX_IMPORT_FRAMES = 300;

function fitDims(w, h) {
  const s = Math.min(1, MAX_IMPORT_DIM / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}
// "Fresh" = nothing to lose. Importing an animation then owns the frame spine,
// because the spine *is* the animation. Into a doc that already has work in it,
// we only ever extend.
const isFresh = () => doc.layers.length === 0 && doc.frames.length <= 1;

function bitmapToCanvas(src, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  return c;
}

// Decode an animated GIF to [{canvas, dur}]. ImageDecoder is built into the
// browser (no library, no wasm) and — critically — composites frame disposal and
// differencing for us, so each decoded frame is the whole picture rather than
// the changed rectangle.
async function decodeGifFrames(file, onProgress) {
  const data = await file.arrayBuffer();
  const dec = new ImageDecoder({ data, type: 'image/gif' });
  await dec.tracks.ready;
  await dec.completed;                       // frameCount isn't final until fully parsed
  const track = dec.tracks.selectedTrack;
  const n = Math.min(track.frameCount, MAX_IMPORT_FRAMES);
  const out = [];
  let dims = null;
  for (let i = 0; i < n; i++) {
    const { image } = await dec.decode({ frameIndex: i });
    if (!dims) dims = fitDims(image.displayWidth, image.displayHeight);
    out.push({
      canvas: bitmapToCanvas(image, dims[0], dims[1]),
      // duration is microseconds; a GIF with no delay set means "as fast as
      // possible", which every viewer renders as ~100ms.
      dur: image.duration ? Math.max(20, Math.round(image.duration / 1000)) : 100,
    });
    image.close();
    if (onProgress) onProgress(i + 1, n);
    await new Promise(r => setTimeout(r, 0));
  }
  dec.close();
  return { frames: out, truncated: track.frameCount > n, sourceCount: track.frameCount };
}

// Sample a video at a fixed rate by seeking. No demuxer needed, and it works for
// any format the browser can play — the cost is that every frame is a seek, so
// it's slow and worth a progress bar.
async function decodeVideoFrames(file, fps, onProgress) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true;
  v.src = URL.createObjectURL(file);
  await new Promise((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error('cannot read this video')); });
  const dims = fitDims(v.videoWidth, v.videoHeight);
  const want = Math.ceil(v.duration * fps);
  const n = Math.min(want, MAX_IMPORT_FRAMES);
  const step = 1 / fps;
  const out = [];
  for (let i = 0; i < n; i++) {
    v.currentTime = Math.min(i * step, Math.max(0, v.duration - 1e-3));
    await new Promise(r => { v.onseeked = () => r(); });
    out.push({ canvas: bitmapToCanvas(v, dims[0], dims[1]), dur: Math.round(step * 1000) });
    if (onProgress) onProgress(i + 1, n);
  }
  URL.revokeObjectURL(v.src);
  return { frames: out, truncated: want > n, sourceCount: want };
}

// Turn decoded frames into a cel layer, taking over (or extending) the spine.
function installCelLayer(name, decoded) {
  pushUndo(null);
  const fresh = isFresh();
  const [cw, ch] = [decoded[0].canvas.width, decoded[0].canvas.height];
  if (fresh) {
    resizeDoc(cw, ch);
    document.getElementById('doc-w').value = doc.w;
    document.getElementById('doc-h').value = doc.h;
    doc.frames = decoded.map(d => newFrame(d.dur));
  } else {
    // Keep what's there; add frames only if the import is longer. Existing
    // delays are the user's, so don't overwrite them.
    withSpanPreserved(() => {
      while (doc.frames.length < decoded.length) doc.frames.push(newFrame(decoded[decoded.length - 1].dur));
    });
  }
  const l = makeCelLayer(name, cw, ch, false);
  l.scale = Math.min(doc.w / cw, doc.h / ch);
  l.cx = doc.w / 2; l.cy = doc.h / 2;
  decoded.forEach((d, i) => { if (doc.frames[i]) l.cels[doc.frames[i].id] = d.canvas; });
  // Imports go to the bottom: you caption a GIF, you don't caption over nothing.
  doc.layers.unshift(l);
  selectLayer(l.id);
  curTime = 0;
  draw(); drawTimeline(); syncFrameUI();
  return l;
}

async function importAnimated(file) {
  const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
  showProgress(0, 1);
  document.getElementById('progress-title').textContent = isGif ? 'Decoding GIF…' : 'Sampling video…';
  try {
    const prog = (d, t) => showProgress(d, t);
    const r = isGif
      ? await decodeGifFrames(file, prog)
      : await decodeVideoFrames(file, 12, prog);
    if (!r.frames.length) { flash('No frames found in that file'); return; }
    installCelLayer(file.name.replace(/\.[^.]+$/, ''), r.frames);
    flash(r.truncated
      ? `Imported the first ${r.frames.length} of ${r.sourceCount} frames (cap)`
      : `Imported ${r.frames.length} frames`);
  } catch (err) {
    console.error(err);
    flash(isGif && !('ImageDecoder' in window)
      ? 'This browser has no built-in GIF decoder (needs WebCodecs)'
      : 'Could not import: ' + err.message);
  } finally {
    hideProgress();
    document.getElementById('progress-title').textContent = 'Encoding GIF…';
  }
}

// A pile of stills becomes a cel layer with one cel each — the simplest
// possible way to build a GIF.
async function importSequence(files) {
  const list = Array.from(files).slice(0, MAX_IMPORT_FRAMES);
  if (!list.length) return;
  // Numeric-aware sort so frame2 precedes frame10.
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  showProgress(0, list.length);
  document.getElementById('progress-title').textContent = 'Loading images…';
  try {
    const imgs = [];
    for (let i = 0; i < list.length; i++) {
      const img = await loadImage(URL.createObjectURL(list[i]));
      imgs.push(img);
      showProgress(i + 1, list.length);
    }
    // All cels in a layer share its w/h, so size to the largest and letterbox
    // the rest rather than stretching mismatched images.
    const mw = Math.max(...imgs.map(i => i.naturalWidth || i.width));
    const mh = Math.max(...imgs.map(i => i.naturalHeight || i.height));
    const [cw, ch] = fitDims(mw, mh);
    const decoded = imgs.map(img => {
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const s = Math.min(cw / (img.naturalWidth || img.width), ch / (img.naturalHeight || img.height));
      const w = (img.naturalWidth || img.width) * s, h = (img.naturalHeight || img.height) * s;
      c.getContext('2d').drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
      return { canvas: c, dur: 100 };
    });
    installCelLayer(`${list.length} images`, decoded);
    flash(`Imported ${decoded.length} images as frames`);
  } catch (err) {
    console.error(err);
    flash('Could not load those images');
  } finally {
    hideProgress();
    document.getElementById('progress-title').textContent = 'Encoding GIF…';
  }
}

on('file-import', 'change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) await importAnimated(f);
});
on('file-seq', 'change', async e => {
  const fs = e.target.files;
  if (fs && fs.length) await importSequence(fs);
  e.target.value = '';
});

// Drag-and-drop anywhere on the stage.
const stageWrap = document.querySelector('.stage-wrap');
stageWrap.addEventListener('dragover', e => { e.preventDefault(); });
stageWrap.addEventListener('drop', async e => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer.files || []);
  if (!files.length) return;
  const anim = files.find(f => /^video\//.test(f.type) || f.type === 'image/gif');
  if (anim) await importAnimated(anim);
  else if (files.length > 1) await importSequence(files);
  else if (/^image\//.test(files[0].type)) {
    const img = await loadImage(URL.createObjectURL(files[0]));
    addImageLayer(img, files[0].name.replace(/\.[^.]+$/, ''));
  }
});

// ---------- GIF export ----------
// Render -> transfer -> encode, one frame at a time. The main thread only ever
// holds the frame it is currently rendering; the worker only ever holds the
// compressed bytes. Nothing accumulates.
let encoding = null;
async function exportGif() {
  if (encoding) return;
  if (!doc.frames.length) return;
  stop();
  const worker = new Worker('./engine/gif-worker.js', { type: 'module' });
  encoding = { worker, cancelled: false };
  showProgress(0, doc.frames.length);

  const bytes = await new Promise((res, rej) => {
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') showProgress(m.done, m.total);
      else if (m.type === 'done') res(new Uint8Array(m.buf));
      else if (m.type === 'error') rej(new Error(m.message));
    };
    worker.onerror = e => rej(new Error(e.message || 'worker failed'));

    worker.postMessage({
      type: 'begin', w: doc.w, h: doc.h, total: doc.frames.length, loop: 0,
      alphaThreshold: doc.transparent ? 128 : null,
    });

    // Yield between frames so the progress bar actually paints and Cancel can
    // be clicked — an await-free loop here would block the main thread just as
    // hard as encoding on it.
    (async () => {
      const off = document.createElement('canvas');
      off.width = doc.w; off.height = doc.h;
      const oc = off.getContext('2d', { willReadFrequently: true });
      for (let i = 0; i < doc.frames.length; i++) {
        if (encoding.cancelled) { rej(new Error('cancelled')); return; }
        renderFrame(oc, i);
        const img = oc.getImageData(0, 0, doc.w, doc.h);
        worker.postMessage({ type: 'frame', buf: img.data.buffer, delay: doc.frames[i].dur }, [img.data.buffer]);
        await new Promise(r => setTimeout(r, 0));
      }
      worker.postMessage({ type: 'finish' });
    })();
  }).catch(err => { console.error(err); return null; });

  worker.terminate();
  hideProgress();
  const cancelled = encoding.cancelled;
  encoding = null;
  if (!bytes) { flash(cancelled ? 'Export cancelled' : 'Export failed — see console'); return; }

  const blob = new Blob([bytes], { type: 'image/gif' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bg-studio.gif';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  flash(`Exported ${doc.frames.length} frames · ${(blob.size / 1024).toFixed(0)} KB`);
}
function showProgress(done, total) {
  document.getElementById('progress-modal').classList.remove('hidden');
  const pct = total ? done / total * 100 : 0;
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-text').textContent = `Frame ${done} of ${total}`;
}
function hideProgress() { document.getElementById('progress-modal').classList.add('hidden'); }
on('progress-cancel', 'click', () => { if (encoding) encoding.cancelled = true; });
on('btn-export-gif', 'click', exportGif);

on('btn-export-frame', 'click', () => {
  renderToCanvas(curFrame()).toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `frame-${curFrame() + 1}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
});

// ---------- Inspector ----------
on('btn-inspect', 'click', () => {
  const l = selected(); if (!l) return;
  document.getElementById('inspect-sub').textContent = `${l.name} · ${l.kind} · id ${l.id}`;
  const o = {};
  for (const k in l) {
    if (k === 'img' || k === 'work' || k === 'baseImg' || k === 'cels' || k[0] === '_') continue;
    o[k] = l[k];
  }
  if (l.kind === 'cel') o.cels = `«${celCount(l)} cel(s) across ${doc.frames.length} frames»`;
  document.getElementById('inspect-body').innerHTML = `<pre>${esc(JSON.stringify(o, null, 1))}</pre>`;
  document.getElementById('inspect-modal').classList.remove('hidden');
});
on('inspect-close', 'click', () => document.getElementById('inspect-modal').classList.add('hidden'));
on('inspect-modal', 'click', e => { if (e.target.id === 'inspect-modal') document.getElementById('inspect-modal').classList.add('hidden'); });

// ---------- Keys ----------
window.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  // Undo/redo work even while typing in a field — but there, let the browser's
  // own text undo handle it rather than reverting the whole document.
  if (mod && (e.key === 'z' || e.key === 'Z')) {
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && (e.key === 'y' || e.key === 'Y')) {
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    e.preventDefault(); redo(); return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (typing) return;
  if (e.key === ' ') { e.preventDefault(); playing ? stop() : play(); }
  else if (e.key === 'ArrowLeft') { stop(); gotoFrame(curFrame() - 1); }
  else if (e.key === 'ArrowRight') { stop(); gotoFrame(curFrame() + 1); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { if (selected()) { e.preventDefault(); deleteLayer(); } }
});

// ---------- Init ----------
function reset() {
  stop();
  doc.frames = [newFrame(100)];
  doc.layers = [];
  doc.selectedId = null;
  curTime = 0;
  undoStack.length = 0; redoStack.length = 0; _lastTag = null;
  resizeDoc(doc.w, doc.h);
  syncControls(); syncFrameUI();
}

fillSelect('text-font', FONTS, "Impact, 'Arial Black', sans-serif");
fillSelect('entry-type', ANIM_TYPES.map(t => [t, t]), 'none');
fillSelect('exit-type', ANIM_TYPES.map(t => [t, t]), 'none');
fillSelect('entry-ease', Object.keys(EASINGS).map(k => [k, k]), 'easeOut');
fillSelect('exit-ease', Object.keys(EASINGS).map(k => [k, k]), 'easeIn');
reset();

const BUILD = 'gif editor · build 2026-07-18 · r3 · import GIF/video/images';
(function stamp() {
  const el = document.createElement('div');
  el.id = 'build-stamp';
  el.textContent = BUILD;
  document.body.appendChild(el);
})();

// Exposed for the verification harness — module scope is otherwise unreachable
// from the page, which makes the editor impossible to drive in a browser test.
window.__gif = { doc, renderFrame, frameStarts, totalDur, curFrame: () => curFrame(), celAt, addText, addFrame };
