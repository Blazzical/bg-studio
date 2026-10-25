// ---------- Text measuring ----------
// Rich text: l.charStyles[i] is a per-character override object aligned to the
// code points of l.text. Any of these keys may be present; absent keys inherit
// the whole-layer value:
//   b, i, u   — bold / italic / underline (booleans)
//   font      — CSS font-family string
//   sizeMul   — size relative to the layer base (1 = same; 1.5 = 50% bigger).
//               Relative (not absolute px) so auto-fit reflow still works.
//   color, stroke, strokeW — fill, outline colour, outline width
// A whole-layer B/I/U flag (l.bold/italic/underline) OR-s into every character.
// Legacy entries that are plain bitmask numbers (an earlier build) are read
// transparently, and a missing charStyles means "one uniform block".
//
// An override always beats the layer value (see styledChars) — so any code that
// changes a layer-level value has to clear that key's overrides too, or the
// change is invisible. See applyProp/clearOverrideKey in app.js.
import { scratchCtx } from './scratch.js';

const EMPTY_OV = {};
export function bitmaskToObj(m) { const o = {}; if (m & 1) o.b = true; if (m & 2) o.i = true; if (m & 4) o.u = true; return o; }
export function overrideAt(l, i) {
  const v = l.charStyles && l.charStyles[i];
  if (typeof v === 'number') return bitmaskToObj(v);
  return (v && typeof v === 'object') ? v : null;
}
// Visible characters as resolved per-char descriptors. UPPERCASE is applied per
// code point so the character↔style alignment is preserved.
export function styledChars(l) {
  const cps = Array.from(String(l.text ?? ''));
  return cps.map((ch, i) => {
    const ov = overrideAt(l, i) || EMPTY_OV;
    return {
      ch: l.upper ? ch.toUpperCase() : ch,
      font: ov.font || l.font,
      sizeMul: ov.sizeMul || 1,
      // A per-char override forces the value; only when it's absent do we inherit
      // the layer flag. (OR-ing would make it impossible to un-bold when the
      // layer default is bold.)
      b: ov.b !== undefined ? ov.b : !!l.bold,
      i: ov.i !== undefined ? ov.i : !!l.italic,
      u: ov.u !== undefined ? ov.u : !!l.underline,
      color: ov.color || l.color,
      stroke: ov.stroke || l.stroke,
      strokeW: ov.strokeW != null ? ov.strokeW : l.strokeW,
    };
  });
}
// A neutral space descriptor used to join wrapped words, at the layer base style.
function spaceDesc(l) {
  return { ch: ' ', font: l.font, sizeMul: 1, b: !!l.bold, i: !!l.italic, u: false, color: l.color, stroke: l.stroke, strokeW: l.strokeW };
}
// Canvas font shorthand for a char descriptor at layer base `size`.
export function charFont(c, size) {
  const it = c.i ? 'italic ' : '', wt = c.b ? '700 ' : '';
  return `${it}${wt}${Math.max(1, size * c.sizeMul)}px ${c.font}`;
}
// Same width metrics (measurable together) ↔ same face + size.
function sameMetrics(a, b) { return a.font === b.font && a.sizeMul === b.sizeMul && a.b === b.b && a.i === b.i; }
// Same everything that affects painting (paintable in one call).
export function sameDraw(a, b) { return sameMetrics(a, b) && a.color === b.color && a.stroke === b.stroke && a.strokeW === b.strokeW && a.u === b.u; }
export function fontString(l) { return charFont({ font: l.font, sizeMul: 1, b: !!l.bold, i: !!l.italic }, l.fontSize); }

// Width of chars[from..to) at layer base `size`, measured run-by-run so each
// maximal same-metrics span uses its own face/size.
export function measureChars(size, chars, from, to) {
  const mc = scratchCtx();
  let w = 0, i = from;
  while (i < to) {
    const c = chars[i]; let j = i, s = '';
    while (j < to && sameMetrics(chars[j], c)) { s += chars[j].ch; j++; }
    mc.font = charFont(c, size); w += mc.measureText(s).width;
    i = j;
  }
  return w;
}
// Largest size-multiplier on a line — drives its line height. Empty line → 1.
function lineMul(ln) { let m = 0; for (const c of ln) m = Math.max(m, c.sizeMul); return ln.length ? Math.max(m, 1e-3) : 1; }
// Height of a line at layer base `size` (tallest character wins).
export function lineHeight(ln, size) { return size * lineMul(ln) * 1.15; }
// Total stacked height of all lines.
function linesHeight(lines, size) { let h = 0; for (const ln of lines) h += lineHeight(ln, size); return h; }

// Word-wrap styled `chars` at `maxW`. Explicit \n are hard breaks; runs of
// whitespace collapse to a single (unstyled) space; a word wider than maxW is
// emitted alone rather than dropped. Returns lines, each an array of descriptors.
function wrapLines(l, chars, size, maxW) {
  const lines = [];
  const hs = []; let hard = [];
  for (const c of chars) { if (c.ch === '\n') { hs.push(hard); hard = []; } else hard.push(c); }
  hs.push(hard);
  for (const h of hs) {
    if (!h.length) { lines.push([]); continue; }
    const words = []; let w = [];
    for (const c of h) { if (/\s/.test(c.ch)) { if (w.length) { words.push(w); w = []; } } else w.push(c); }
    if (w.length) words.push(w);
    if (!words.length) { lines.push([]); continue; }
    let cur = [];
    for (const word of words) {
      const trial = cur.length ? cur.concat([spaceDesc(l)], word) : word.slice();
      if (measureChars(size, trial, 0, trial.length) <= maxW) cur = trial;
      else if (cur.length) { lines.push(cur); cur = word.slice(); }
      else { lines.push(word.slice()); cur = []; }
    }
    if (cur.length) lines.push(cur);
  }
  return lines;
}

// Widest rendered line width for a set of styled lines at a given base size.
function widestLine(lines, size) {
  let m = 1;
  for (const ln of lines) m = Math.max(m, measureChars(size, ln, 0, ln.length));
  return m;
}
// Binary-search the largest integer base size whose word-wrapped lines fit in
// (maxW, maxH) — including single over-long words and per-character size bumps —
// and number no more than maxLines. Never returns < 8.
function fitFontSize(l, chars, maxW, maxH, maxLines) {
  if (maxW < 4 || maxH < 4) return 8;
  const cap = maxLines || Infinity;
  let lo = 8, hi = Math.max(12, Math.min(Math.floor(maxH), 400));
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const lines = wrapLines(l, chars, mid, maxW);
    const fits = linesHeight(lines, mid) <= maxH && lines.length <= cap && widestLine(lines, mid) <= maxW;
    if (fits) lo = mid; else hi = mid;
  }
  return Math.max(8, lo);
}

// Layout a text layer. Two modes:
//   autoFit=true  — l.w, l.h are the user-controlled box. Word-wrap to fit
//                   width, binary-search the largest font that fits height.
//   autoFit=false — Legacy: l.fontSize is user-set, lines split only on \n,
//                   l.w / l.h are derived from the measured text.
export function measureText(l) {
  const chars = styledChars(l);
  const hlPad = l.hlOn ? (l.hlPad || 0) : 0;
  const padX = l.strokeW + 4 + hlPad;   // matches legacy: strokeW*2 + 8 total
  const padY = l.strokeW + 2 + hlPad;   // matches legacy: strokeW*2 + 4 total
  if (l.autoFit) {
    const boxW = Math.max(20, l.w - padX * 2);
    const boxH = Math.max(12, l.h - padY * 2);
    l.fontSize = fitFontSize(l, chars, boxW, boxH, l.maxLines);
    l._lines = wrapLines(l, chars, l.fontSize, boxW);
    l._maxW = widestLine(l._lines, l.fontSize);
    l._lineHs = l._lines.map(ln => lineHeight(ln, l.fontSize));
    l._lineH = l.fontSize * 1.15;
    // l.w, l.h stay as the user's box.
    return;
  }
  // Legacy sizing: split on hard \n only, derive w/h from the measured text.
  const lines = []; let cur = [];
  for (const c of chars) { if (c.ch === '\n') { lines.push(cur); cur = []; } else cur.push(c); }
  lines.push(cur);
  const maxW = widestLine(lines, l.fontSize);
  l._maxW = maxW;
  l._lineHs = lines.map(ln => lineHeight(ln, l.fontSize));
  l.w = maxW + l.strokeW * 2 + 8 + hlPad * 2;
  l.h = linesHeight(lines, l.fontSize) + l.strokeW * 2 + 4 + hlPad * 2;
  l._lines = lines;
  l._lineH = l.fontSize * 1.15;
}

// Draw the highlight background (and optional border) behind a text layer, in the
// same scaled/aligned space as the glyphs. 'block' = one box behind the whole
// paragraph; 'marker' = a tight box per line (highlighter-pen look).
export function drawTextHighlight(c, l, lines, lineHs, align) {
  const pad = l.hlPad || 0, rad = l.hlRadius || 0, maxW = l._maxW || 1;
  const totalH = lineHs.reduce((a, b) => a + b, 0);
  c.save();
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
    let y = -totalH / 2;
    lines.forEach((ln, i) => {
      const lh = lineHs[i];
      const tw = ln.length ? measureChars(l.fontSize, ln, 0, ln.length) : 0;
      const left = (align === 'left' ? -maxW / 2 : align === 'right' ? maxW / 2 - tw : -tw / 2) - pad;
      const boxH = (lh / 1.15) * 1.05 + pad * 0.8;
      const cy = y + lh / 2;
      box(left, cy - boxH / 2, tw + 2 * pad, boxH);
      y += lh;
    });
  } else {
    box(-maxW / 2 - pad, -totalH / 2 - pad, maxW + 2 * pad, totalH + 2 * pad);
  }
  c.restore();
}
