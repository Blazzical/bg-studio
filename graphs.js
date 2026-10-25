// BG Studio Graphs — Venn diagrams, bar, line and pie charts, exported as PNG.
//
// State:
//   S.type          'venn' | 'bar' | 'line' | 'pie'
//   S.w, S.h        output size in px (the canvas IS the export)
//   S.bg            background colour; S.transparent skips it
//   S.font, S.fontSize, S.textColor   shared text style (all text wears textColor)
//   S.title         optional title over any graph
//   S.venn          { n, overlap, names[3], text{region}, fills{region}, noFill, opacity, outline, outlineW }
//                   regions are keyed by the sets they're in: 'A', 'B', 'AB', 'ABC', …
//   S.chart         { csv, colors[], legend, xLabel, yLabel, yMin, yMax,
//                     grid, values, stacked, horizontal, markers, smooth, lineW, bar }
//                   shared by bar, line and pie, so switching type keeps the data
//   S.chart.bar     bar look: { fill, block, gap, stripe, angle, color2Auto, color2, radius,
//                     track, trackBorder, trackBorderW, trackFillOn, trackFill, inset }
//                   fill is a paintFill style (engine/fills.js); track draws the full
//                   axis range behind each bar so it reads like a loading bar
//   S.chart.pie     { series, hole, gap, rotate, labels, labelPos, sort, decimals, colors[] }
//                   decimals: 'auto' or a fixed count for percent / value labels
//                   slices are the categories of one value column; colors are per
//                   slice (by category row), separate from the series colours

import { paintFill, FILL_STYLES } from './engine/fills.js';
import { initMobileShell } from './engine/mobile-shell.js';
import { addImageHistory } from './engine/history.js';

// Categorical palette, fixed order (validated for colour-blind separation).
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

const REGIONS = {
  2: [['A', 'A only'], ['B', 'B only'], ['AB', 'A ∩ B']],
  3: [['A', 'A only'], ['B', 'B only'], ['C', 'C only'],
      ['AB', 'A ∩ B'], ['AC', 'A ∩ C'], ['BC', 'B ∩ C'], ['ABC', 'All three']],
};

const S = {
  type: 'venn',
  w: 1200, h: 800,
  bg: '#ffffff', transparent: false,
  font: 'Arial', fontSize: 30, textColor: '#111111',
  title: '',
  venn: {
    n: 2,
    overlap: 45,
    names: ['Things I say', 'Things I do', 'Things I regret'],
    text: { A: 'big plans', B: 'nap', C: 'texting my ex', AB: 'eat\nsnacks', AC: 'karaoke', BC: 'buy crypto', ABC: 'me' },
    fills: {},
    noFill: false,
    opacity: 70,
    outline: '#222222',
    outlineW: 4,
  },
  chart: {
    csv: 'Month, Memes made, Memes understood\nJan, 12, 3\nFeb, 19, 4\nMar, 27, 5\nApr, 35, 4\nMay, 48, 6',
    colors: PALETTE.slice(),
    legend: 'auto',
    xLabel: '', yLabel: 'Memes',
    yMin: null, yMax: null,
    grid: true, values: false,
    stacked: false, horizontal: false,
    markers: true, smooth: false, lineW: 4,
    bar: {
      fill: 'solid', block: 8, gap: 2, stripe: 10, angle: 45,
      color2Auto: true, color2: '#ffffff', radius: 6,
      track: false, trackBorder: '#222222', trackBorderW: 2,
      trackFillOn: true, trackFill: '#eeeeee', inset: 0,
    },
    pie: {
      series: 0, hole: 0, gap: 3, rotate: 0,
      labels: 'percent', labelPos: 'auto', sort: false, decimals: 'auto',
      colors: PALETTE.slice(),
    },
  },
};

const canvas = document.getElementById('preview');
const ctx = canvas.getContext('2d');

// ---------- Colour helpers ----------

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}
// Overlap colour: average the parents in linear light, then darken a touch so
// an overlap reads as "both" rather than a washed-out in-between.
// Mix a colour toward white by t (0..1) — the auto second colour for barber poles.
function tint(hex, t) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
}
function blend(hexes) {
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const gam = v => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255;
  const acc = [0, 0, 0];
  for (const h of hexes) hexToRgb(h).forEach((v, i) => { acc[i] += lin(v); });
  const dark = 1 - 0.12 * (hexes.length - 1);
  return rgbToHex(...acc.map(v => gam(v / hexes.length * dark)));
}
// Random harmonious set: evenly spaced hues from a random start, jittered a bit.
function randomHues(n) {
  const start = Math.random() * 360;
  const sat = 60 + Math.random() * 20, lit = 50 + Math.random() * 10;
  return Array.from({ length: n }, (_, i) =>
    hslToHex((start + i * 360 / n + (Math.random() - 0.5) * 20 + 360) % 360, sat, lit));
}

// Fill every region from the base colours of A, B, C.
function vennFillFrom(bases) {
  const f = {};
  for (const [key] of REGIONS[3]) f[key] = key.length === 1
    ? bases['ABC'.indexOf(key)]
    : blend([...key].map(k => bases['ABC'.indexOf(k)]));
  S.venn.fills = f;
}

// ---------- Text helpers ----------

function font(px, bold) { return `${bold ? 'bold ' : ''}${Math.round(px)}px "${S.font}", sans-serif`; }

function drawLines(c, lines, x, y, px, lineH) {
  const top = y - (lines.length - 1) * lineH / 2;
  lines.forEach((ln, i) => c.fillText(ln, x, top + i * lineH));
}

// ---------- Venn ----------

// Circle centres + radius in px, laid out to fill the canvas under the title.
function vennGeometry(titleH) {
  const V = S.venn, n = V.n;
  // Overlap 0% → circles just touching (sep 2r); 100% → heavy overlap (sep 0.5r).
  const sep = 2 - 1.5 * (V.overlap / 100);
  const unit = n === 2
    ? [[-sep / 2, 0], [sep / 2, 0]]
    : [[-sep / 2, -sep * Math.sqrt(3) / 6], [sep / 2, -sep * Math.sqrt(3) / 6], [0, sep * Math.sqrt(3) / 3]];
  const xs = unit.map(p => p[0]), ys = unit.map(p => p[1]);
  const bw = Math.max(...xs) - Math.min(...xs) + 2, bh = Math.max(...ys) - Math.min(...ys) + 2;
  const nameH = V.names.slice(0, n).some(s => s.trim()) ? S.fontSize * 1.6 : 0;
  const pad = S.fontSize * 0.8 + V.outlineW;
  const availW = S.w - pad * 2, availH = S.h - pad * 2 - titleH - nameH * (n === 3 ? 2 : 1);
  const r = Math.max(10, Math.min(availW / bw, availH / bh));
  const cx = S.w / 2 - (Math.max(...xs) + Math.min(...xs)) / 2 * r;
  const top = pad + titleH + nameH;
  const cy = top + (availH - bh * r) / 2 + (1 - Math.min(...ys)) * r;
  return { r, nameH, circles: unit.map(([x, y]) => ({ x: cx + x * r, y: cy + y * r })) };
}

function inRegion(g, key, x, y) {
  return g.circles.every((c, i) => (Math.hypot(x - c.x, y - c.y) < g.r) === key.includes('ABC'[i]));
}
// Distance from (x,y) to the nearest circle edge — how much room a label has.
function edgeDist(g, x, y) {
  return Math.min(...g.circles.map(c => Math.abs(g.r - Math.hypot(x - c.x, y - c.y))));
}
// Label anchor: the point of the region furthest from any edge (grid search).
function regionAnchor(g, key) {
  const step = g.r / 30;
  let best = null, bestD = -1;
  for (let y = Math.min(...g.circles.map(c => c.y)) - g.r; y <= Math.max(...g.circles.map(c => c.y)) + g.r; y += step) {
    for (let x = Math.min(...g.circles.map(c => c.x)) - g.r; x <= Math.max(...g.circles.map(c => c.x)) + g.r; x += step) {
      if (!inRegion(g, key, x, y)) continue;
      const d = edgeDist(g, x, y);
      if (d > bestD) { bestD = d; best = { x, y }; }
    }
  }
  return best;
}

// Clip to exactly one region: inside its own circles, outside the others
// (evenodd against a canvas-sized rect carves each other circle out).
function clipRegion(c, g, key) {
  g.circles.forEach((ci, i) => {
    c.beginPath();
    if (key.includes('ABC'[i])) {
      c.arc(ci.x, ci.y, g.r, 0, Math.PI * 2);
      c.clip();
    } else {
      c.rect(0, 0, S.w, S.h);
      c.arc(ci.x, ci.y, g.r, 0, Math.PI * 2);
      c.clip('evenodd');
    }
  });
}

function drawVenn(c, titleH) {
  const V = S.venn, g = vennGeometry(titleH);
  const regions = REGIONS[V.n];

  if (!V.noFill) {
    c.globalAlpha = V.opacity / 100;
    for (const [key] of regions) {
      c.save();
      clipRegion(c, g, key);
      c.fillStyle = V.fills[key] || '#cccccc';
      c.fillRect(0, 0, S.w, S.h);
      c.restore();
    }
    c.globalAlpha = 1;
  }
  if (V.outlineW > 0) {
    c.strokeStyle = V.outline; c.lineWidth = V.outlineW;
    for (const ci of g.circles) { c.beginPath(); c.arc(ci.x, ci.y, g.r, 0, Math.PI * 2); c.stroke(); }
  }

  // Region text, shrunk until its box fits inside the region.
  c.fillStyle = S.textColor;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  for (const [key] of regions) {
    const txt = (V.text[key] || '').trim();
    if (!txt) continue;
    const at = regionAnchor(g, key);
    if (!at) continue;
    const lines = txt.split('\n');
    let px = S.fontSize;
    for (; px > 10; px *= 0.92) {
      c.font = font(px);
      const w = Math.max(...lines.map(l => c.measureText(l).width)) / 2;
      const h = lines.length * px * 1.15 / 2;
      const pts = [[-w, -h], [0, -h], [w, -h], [-w, 0], [w, 0], [-w, h], [0, h], [w, h]];
      if (pts.every(([dx, dy]) => inRegion(g, key, at.x + dx, at.y + dy))) break;
    }
    c.font = font(px);
    drawLines(c, lines, at.x, at.y, px, px * 1.15);
  }

  // Circle names: above A and B, below C.
  c.font = font(S.fontSize * 1.1, true);
  g.circles.forEach((ci, i) => {
    const name = (V.names[i] || '').trim();
    if (!name) return;
    const below = V.n === 3 && i === 2;
    c.textBaseline = below ? 'top' : 'bottom';
    const y = below ? ci.y + g.r + V.outlineW + S.fontSize * 0.3 : ci.y - g.r - V.outlineW - S.fontSize * 0.3;
    c.fillText(name, ci.x, y);
  });
}

// ---------- Chart data ----------

// Parse the data textarea → { cats[], series[{name, values[]}] }. Tabs win over
// commas (spreadsheet paste); semicolons work too. Blank / non-numeric cells are null.
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { error: 'Need a header row and at least one data row.' };
  const delim = lines[0].includes('\t') ? '\t' : lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  const rows = lines.map(l => l.split(delim).map(s => s.trim()));
  const names = rows[0].slice(1);
  if (!names.length) return { error: 'Need at least one series column after the category column.' };
  const series = names.map((name, i) => ({
    name: name || `Series ${i + 1}`,
    values: rows.slice(1).map(r => {
      const v = parseFloat((r[i + 1] || '').replace(/[$%\s]/g, ''));
      return Number.isFinite(v) ? v : null;
    }),
  }));
  return { cats: rows.slice(1).map(r => r[0]), series, delim };
}

// Rename a series = rewrite its header cell, so the textarea stays the source of truth.
function renameSeries(i, name) {
  const lines = S.chart.csv.split(/\r?\n/);
  const parsed = parseCSV(S.chart.csv);
  if (parsed.error) return;
  const cells = lines[0].split(parsed.delim);
  cells[i + 1] = (parsed.delim === '\t' ? '' : ' ') + name.replace(new RegExp(parsed.delim === '\t' ? '\t' : parsed.delim, 'g'), '');
  lines[0] = cells.join(parsed.delim);
  S.chart.csv = lines.join('\n');
  document.getElementById('csv').value = S.chart.csv;
}

// Rename a pie slice = rewrite the first cell of its data row.
function renameCategory(j, name) {
  const parsed = parseCSV(S.chart.csv);
  if (parsed.error) return;
  const lines = S.chart.csv.split(/\r?\n/);
  let row = -1;   // non-blank line counter; row 0 is the header
  for (let k = 0; k < lines.length; k++) {
    if (!lines[k].trim()) continue;
    if (row++ !== j) continue;
    const cells = lines[k].split(parsed.delim);
    cells[0] = name.replace(new RegExp(parsed.delim === '\t' ? '\t' : parsed.delim, 'g'), '');
    lines[k] = cells.join(parsed.delim);
    break;
  }
  S.chart.csv = lines.join('\n');
  document.getElementById('csv').value = S.chart.csv;
}

// Round axis ticks: ~5 steps of 1/2/5 × 10^k covering [lo, hi].
function niceTicks(lo, hi, target = 5) {
  if (lo === hi) { hi = lo + 1; }
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const start = Math.floor(lo / step + 1e-9) * step, end = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}
function fmt(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return +(v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return +(v / 1e3).toFixed(1) + 'k';
  return String(+v.toFixed(2));
}

function legendPos(n) {
  const L = S.chart.legend;
  if (L === 'auto') {
    // Pie: a side legend unless the slice labels already carry the names.
    if (S.type === 'pie') return n >= 2 && !S.chart.pie.labels.startsWith('name') ? 'right' : 'none';
    return n >= 2 ? 'top' : 'none';
  }
  return L;
}

// Path for a rect with per-corner radii [tl, tr, br, bl].
function roundRectPath(c, x, y, w, h, r) {
  if (w < 0) { x += w; w = -w; r = [r[1], r[0], r[3], r[2]]; }
  if (h < 0) { y += h; h = -h; r = [r[3], r[2], r[1], r[0]]; }
  const m = Math.min(w / 2, h / 2);
  const [tl, tr, br, bl] = r.map(v => Math.min(v, m));
  c.beginPath();
  c.moveTo(x + tl, y);
  c.lineTo(x + w - tr, y); c.arcTo(x + w, y, x + w, y + tr, tr);
  c.lineTo(x + w, y + h - br); c.arcTo(x + w, y + h, x + w - br, y + h, br);
  c.lineTo(x + bl, y + h); c.arcTo(x, y + h, x, y + h - bl, bl);
  c.lineTo(x, y + tl); c.arcTo(x, y, x + tl, y, tl);
  c.closePath();
}

// ---------- Legend ----------

// Measure + draw the legend. Returns the space it takes; draws only if `draw`.
function legend(c, series, pos, box, draw, colorOf = i => S.chart.colors[i] || PALETTE[i % PALETTE.length]) {
  const px = S.fontSize * 0.8, sw = px * 0.9, gap = px * 0.5, itemGap = px * 1.4;
  c.font = font(px);
  const items = series.map((s, i) => ({ s, i: s.i ?? i, w: sw + gap + c.measureText(s.name).width }));
  const lineH = px * 1.6;
  const swatch = (x, y, i) => {
    c.fillStyle = colorOf(i);
    if (S.type === 'line') {
      c.strokeStyle = c.fillStyle; c.lineWidth = Math.max(2, S.chart.lineW * 0.75); c.lineCap = 'round';
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + sw, y); c.stroke();
      if (S.chart.markers) { c.beginPath(); c.arc(x + sw / 2, y, Math.max(3, S.chart.lineW), 0, Math.PI * 2); c.fill(); }
    } else {
      roundRectPath(c, x, y - sw / 2, sw, sw, [3, 3, 3, 3]); c.fill();
    }
  };
  if (pos === 'right') {
    const w = Math.max(...items.map(t => t.w));
    if (draw) {
      let y = box.y + box.h / 2 - (items.length - 1) * lineH / 2;
      for (const t of items) {
        swatch(box.x + box.w - w, y, t.i);
        c.fillStyle = S.textColor; c.textAlign = 'left'; c.textBaseline = 'middle';
        c.fillText(t.s.name, box.x + box.w - w + sw + gap, y);
        y += lineH;
      }
    }
    return { w: w + px * 1.5, h: 0 };
  }
  // top / bottom: wrap items into centred rows
  const rows = [[]];
  let rw = 0;
  for (const t of items) {
    if (rows[rows.length - 1].length && rw + itemGap + t.w > box.w) { rows.push([]); rw = 0; }
    rw += (rows[rows.length - 1].length ? itemGap : 0) + t.w;
    rows[rows.length - 1].push(t);
  }
  const h = rows.length * lineH + px * 0.6;
  if (draw) {
    let y = (pos === 'top' ? box.y : box.y + box.h - h + px * 0.6) + lineH / 2;
    for (const row of rows) {
      const total = row.reduce((a, t) => a + t.w, 0) + itemGap * (row.length - 1);
      let x = box.x + (box.w - total) / 2;
      for (const t of row) {
        swatch(x, y, t.i);
        c.fillStyle = S.textColor; c.textAlign = 'left'; c.textBaseline = 'middle';
        c.fillText(t.s.name, x + sw + gap, y);
        x += t.w + itemGap;
      }
      y += lineH;
    }
  }
  return { w: 0, h };
}

// ---------- Bar / line ----------

function drawChart(c, titleH) {
  const C = S.chart;
  const data = parseCSV(C.csv);
  const err = document.getElementById('parse-err');
  err.classList.toggle('hidden', !data.error);
  if (data.error) { err.textContent = data.error; return; }
  if (S.type === 'pie') return drawPie(c, titleH, data);
  const { cats, series } = data;
  const isBar = S.type === 'bar';
  const horiz = isBar && C.horizontal;
  const stacked = isBar && C.stacked;

  const pad = S.fontSize * 0.8;
  const tickPx = S.fontSize * 0.7, labelPx = S.fontSize * 0.85;
  let box = { x: pad, y: pad + titleH, w: S.w - pad * 2, h: S.h - pad * 2 - titleH };

  // Legend takes its slice first.
  const lp = legendPos(series.length);
  if (lp !== 'none') {
    const m = legend(c, series, lp, box, false);
    legend(c, series, lp, box, true);
    if (lp === 'top') { box.y += m.h; box.h -= m.h; }
    if (lp === 'bottom') box.h -= m.h;
    if (lp === 'right') box.w -= m.w;
  }

  // Value range (stacked: per-category positive and negative sums).
  let lo = Infinity, hi = -Infinity;
  if (stacked) {
    cats.forEach((_, j) => {
      let pos = 0, neg = 0;
      for (const s of series) { const v = s.values[j]; if (v > 0) pos += v; else if (v < 0) neg += v; }
      hi = Math.max(hi, pos); lo = Math.min(lo, neg);
    });
  } else {
    for (const s of series) for (const v of s.values) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
  if (isBar) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }   // bars always include zero
  if (C.yMin != null) lo = C.yMin;
  if (C.yMax != null) hi = C.yMax;
  let ticks = niceTicks(lo, hi);
  if (C.yMin != null || C.yMax != null) {
    ticks = ticks.filter(t => t >= lo - 1e-9 && t <= hi + 1e-9);
  } else { lo = ticks[0]; hi = ticks[ticks.length - 1]; }
  if (hi <= lo) hi = lo + 1;

  // Axis-title and tick-label space.
  c.font = font(tickPx);
  const valueTickW = Math.max(...ticks.map(t => c.measureText(fmt(t)).width));
  const catTickW = Math.max(0, ...cats.map(s => c.measureText(s).width));
  // X label names the categories, Y the values — so horizontal bars swap sides.
  const bottomLabel = (horiz ? C.yLabel : C.xLabel).trim();
  const leftLabel = (horiz ? C.xLabel : C.yLabel).trim();
  const yTitle = leftLabel ? labelPx * 1.5 : 0;
  const xTitle = bottomLabel ? labelPx * 1.5 : 0;
  const leftW = (horiz ? catTickW : valueTickW) + tickPx * 0.7;
  const plot = { x: box.x + yTitle + leftW, y: box.y + tickPx * 0.6, w: 0, h: 0 };
  plot.w = box.x + box.w - plot.x - tickPx * 0.5;
  // Category labels at the bottom rotate when they'd collide.
  const band0 = plot.w / Math.max(1, cats.length);
  const rotate = !horiz && catTickW > band0 * 0.9;
  const bottomH = (rotate ? Math.min(catTickW, S.h * 0.25) * 0.72 + tickPx : tickPx * 1.8);
  plot.h = box.y + box.h - xTitle - bottomH - plot.y;

  const n = cats.length;
  const band = (horiz ? plot.h : plot.w) / Math.max(1, n);
  // value → px along the value axis
  const vpos = v => horiz
    ? plot.x + (v - lo) / (hi - lo) * plot.w
    : plot.y + plot.h - (v - lo) / (hi - lo) * plot.h;
  // category index → px centre along the category axis
  const cpos = j => horiz ? plot.y + band * (j + 0.5) : plot.x + band * (j + 0.5);

  // Gridlines + value ticks (recessive: text colour at low alpha).
  c.save();
  c.font = font(tickPx); c.fillStyle = S.textColor;
  for (const t of ticks) {
    const p = vpos(t);
    if (C.grid) {
      c.strokeStyle = S.textColor; c.globalAlpha = t === 0 ? 0.5 : 0.12; c.lineWidth = t === 0 ? 2 : 1;
      c.beginPath();
      if (horiz) { c.moveTo(p, plot.y); c.lineTo(p, plot.y + plot.h); }
      else { c.moveTo(plot.x, p); c.lineTo(plot.x + plot.w, p); }
      c.stroke();
    }
    c.globalAlpha = 0.75;
    if (horiz) { c.textAlign = 'center'; c.textBaseline = 'top'; c.fillText(fmt(t), p, plot.y + plot.h + tickPx * 0.5); }
    else { c.textAlign = 'right'; c.textBaseline = 'middle'; c.fillText(fmt(t), plot.x - tickPx * 0.5, p); }
  }
  // Baseline axis.
  c.globalAlpha = 0.6; c.strokeStyle = S.textColor; c.lineWidth = 2;
  c.beginPath();
  if (horiz) { c.moveTo(plot.x, plot.y); c.lineTo(plot.x, plot.y + plot.h); }
  else { c.moveTo(plot.x, plot.y + plot.h); c.lineTo(plot.x + plot.w, plot.y + plot.h); }
  c.stroke();
  // Category labels.
  c.globalAlpha = 0.85;
  cats.forEach((cat, j) => {
    const p = cpos(j);
    if (horiz) { c.textAlign = 'right'; c.textBaseline = 'middle'; c.fillText(cat, plot.x - tickPx * 0.5, p); }
    else if (rotate) {
      c.save(); c.translate(p, plot.y + plot.h + tickPx * 0.5); c.rotate(-Math.PI / 4);
      c.textAlign = 'right'; c.textBaseline = 'middle'; c.fillText(cat, 0, 0); c.restore();
    } else { c.textAlign = 'center'; c.textBaseline = 'top'; c.fillText(cat, p, plot.y + plot.h + tickPx * 0.5); }
  });
  c.restore();

  // Axis titles.
  c.fillStyle = S.textColor; c.font = font(labelPx, true);
  if (bottomLabel) {
    c.textAlign = 'center'; c.textBaseline = 'bottom';
    c.fillText(bottomLabel, plot.x + plot.w / 2, box.y + box.h);
  }
  if (leftLabel) {
    c.save(); c.translate(box.x, plot.y + plot.h / 2); c.rotate(-Math.PI / 2);
    c.textAlign = 'center'; c.textBaseline = 'top'; c.fillText(leftLabel, 0, 0); c.restore();
  }

  const color = i => C.colors[i] || PALETTE[i % PALETTE.length];
  const valPx = S.fontSize * 0.65;
  const labels = [];   // value labels, drawn last so marks never cover them

  if (isBar) {
    const B = C.bar;
    const groupW = band * 0.78;
    const per = stacked ? 1 : series.length;
    const gap = Math.min(4, groupW / per * 0.1);   // small surface gap between adjacent bars
    const barW = (groupW - gap * (per - 1)) / per;
    const rad = Math.min(B.radius, barW / 2);
    const slot = (j, i) => cpos(j) - groupW / 2 + (stacked ? 0 : i * (barW + gap));

    // Full-range track: the whole lo..hi span behind each bar (one per stack).
    // With an inset, bars live inside it, so their value axis is squeezed in.
    const inset = B.track ? Math.max(0, Math.min(B.inset, barW / 2 - 1)) : 0;
    const t0 = vpos(lo), t1 = vpos(hi);
    if (B.track) {
      c.save();
      cats.forEach((_, j) => {
        for (let i = 0; i < per; i++) {
          const st = slot(j, i);
          if (horiz) roundRectPath(c, t0, st, t1 - t0, barW, [rad, rad, rad, rad]);
          else roundRectPath(c, st, t1, barW, t0 - t1, [rad, rad, rad, rad]);
          if (B.trackFillOn) { c.fillStyle = B.trackFill; c.fill(); }
          if (B.trackBorderW > 0) { c.strokeStyle = B.trackBorder; c.lineWidth = B.trackBorderW; c.stroke(); }
        }
      });
      // The track hides the gridlines; put the zero line back when it's inside.
      if (lo < 0 && hi > 0) {
        const z = vpos(0);
        c.strokeStyle = S.textColor; c.globalAlpha = 0.5; c.lineWidth = 2;
        c.beginPath();
        if (horiz) { c.moveTo(z, plot.y); c.lineTo(z, plot.y + plot.h); }
        else { c.moveTo(plot.x, z); c.lineTo(plot.x + plot.w, z); }
        c.stroke();
      }
      c.restore();
    }
    // value → px for bar ends: the plain axis, or the inset span inside the track.
    const bpos = inset ? (v => {
      const f = (v - lo) / (hi - lo);
      return horiz ? t0 + inset + f * (t1 - t0 - inset * 2) : t0 - inset - f * (t0 - t1 - inset * 2);
    }) : vpos;

    cats.forEach((_, j) => {
      let pos = 0, neg = 0;
      series.forEach((s, i) => {
        const v = s.values[j];
        if (v == null || v === 0) return;
        let a, b;
        if (stacked) { if (v > 0) { a = pos; pos += v; b = pos; } else { a = neg; neg += v; b = neg; } }
        else { a = 0; b = v; }
        const start = slot(j, i) + inset, bw = barW - inset * 2;
        const p0 = bpos(Math.max(lo, Math.min(hi, a))), p1 = bpos(Math.max(lo, Math.min(hi, b)));
        // Round only the data end (away from the baseline); the top of a stack.
        // Inside a track the bar is a loading-bar fill, so its base end rounds too.
        const sameSign = t => v > 0 ? t.values[j] > 0 : t.values[j] < 0;
        const isEnd = !stacked || !series.slice(i + 1).some(sameSign);
        const isStart = !stacked || !series.slice(0, i).some(sameSign);
        const r = isEnd ? Math.max(0, rad - inset) : 0;
        const r0 = B.track && isStart ? Math.max(0, rad - inset) : 0;
        const sgap = stacked ? 1 : 0;   // 2px seam between stacked segments
        let x, y, w, h, rr;
        if (horiz) {
          const x0 = Math.min(p0, p1);
          x = v > 0 ? x0 : x0 + sgap; y = start; w = Math.abs(p1 - p0) - sgap; h = bw;
          rr = v > 0 ? [r0, r, r, r0] : [r, r0, r0, r];
        } else {
          const y0 = Math.min(p0, p1);
          x = start; y = v > 0 ? y0 : y0 + sgap; w = bw; h = Math.abs(p1 - p0) - sgap;
          rr = v > 0 ? [r, r, r0, r0] : [r0, r0, r, r];
        }
        if (w <= 0 || h <= 0) return;
        c.save();
        roundRectPath(c, x, y, w, h, rr);
        c.clip();
        // Blocks step from the baseline outwards, whichever way the bar grows.
        const dir = horiz ? (v > 0 ? 'ltr' : 'rtl') : (v > 0 ? 'btt' : 'ttb');
        paintFill(c, x, y, w, h, {
          style: B.fill, color: color(i), dir,
          color2: B.color2Auto ? tint(color(i), 0.55) : B.color2,
          block: B.block, gap: B.gap, stripe: B.stripe, angle: B.angle,
        });
        c.restore();
        if (C.values) {
          const mid = start + bw / 2, t = fmt(v);
          const sgn = v > 0 ? 1 : -1, padL = valPx * 0.4;
          // A label past the bar end would leave the plot (into the category
          // labels or the legend) when the bar reaches the axis edge — tuck it
          // inside the bar's end instead.
          c.font = font(valPx, true);
          const tw = c.measureText(t).width;
          if (stacked) labels.push({ t, x: horiz ? (p0 + p1) / 2 : mid, y: horiz ? mid : (p0 + p1) / 2, inside: true });
          else if (horiz) {
            const out = p1 + sgn * (padL + tw);
            if (out < plot.x || out > plot.x + plot.w) labels.push({ t, x: p1 - sgn * padL, y: mid, align: v > 0 ? 'right' : 'left', inside: true });
            else labels.push({ t, x: p1 + sgn * padL, y: mid, align: v > 0 ? 'left' : 'right' });
          } else {
            const out = p1 - sgn * valPx * 1.3;
            if (out < plot.y - tickPx * 0.6 || out > plot.y + plot.h) labels.push({ t, x: mid, y: p1 + sgn * valPx * 0.75, inside: true });
            else labels.push({ t, x: mid, y: p1 - sgn * valPx * 0.3, base: v > 0 ? 'bottom' : 'top' });
          }
        }
      });
    });
  } else {
    c.save();
    c.beginPath(); c.rect(plot.x - 20, plot.y - 20, plot.w + 40, plot.h + 40); c.clip();
    series.forEach((s, i) => {
      // Split into runs at missing values so a gap shows as a gap.
      const runs = [[]];
      s.values.forEach((v, j) => {
        if (v == null) { if (runs[runs.length - 1].length) runs.push([]); return; }
        runs[runs.length - 1].push({ x: cpos(j), y: vpos(v), v });
      });
      c.strokeStyle = color(i); c.lineWidth = C.lineW; c.lineJoin = 'round'; c.lineCap = 'round';
      for (const pts of runs) {
        if (!pts.length) continue;
        c.beginPath(); c.moveTo(pts[0].x, pts[0].y);
        for (let k = 1; k < pts.length; k++) {
          if (C.smooth) {
            // Catmull-Rom → cubic Bézier through the points.
            const p0 = pts[k - 2] || pts[k - 1], p1 = pts[k - 1], p2 = pts[k], p3 = pts[k + 1] || p2;
            c.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
                            p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
          } else c.lineTo(pts[k].x, pts[k].y);
        }
        c.stroke();
        for (const p of pts) {
          if (C.markers) {
            // Marker with a surface ring so it separates from crossing lines.
            const mr = Math.max(4, C.lineW * 1.3);
            c.beginPath(); c.arc(p.x, p.y, mr, 0, Math.PI * 2);
            c.fillStyle = color(i); c.fill();
            c.lineWidth = Math.max(2, C.lineW * 0.5);
            c.strokeStyle = S.transparent ? 'rgba(255,255,255,0.9)' : S.bg; c.stroke();
            c.strokeStyle = color(i); c.lineWidth = C.lineW;
          }
          if (C.values) labels.push({ t: fmt(p.v), x: p.x, y: p.y - Math.max(6, C.lineW * 2), base: 'bottom' });
        }
      }
    });
    c.restore();
  }

  c.font = font(valPx, true);
  // Inside labels sit on the bar's fill; over blocks or stripes a plain white
  // label gets lost, so give it a dark outline there.
  const busy = isBar && C.bar.fill !== 'solid';
  c.lineJoin = 'round';
  for (const l of labels) {
    c.textAlign = l.align || 'center';
    c.textBaseline = l.inside ? 'middle' : (l.base || 'middle');
    if (l.inside && busy) {
      c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = Math.max(3, valPx * 0.18);
      c.strokeText(l.t, l.x, l.y);
    }
    c.fillStyle = l.inside ? '#ffffff' : S.textColor;
    c.fillText(l.t, l.x, l.y);
  }
}

// ---------- Pie ----------

// Auto: whole percents, one decimal under 10%; values use the axis format.
function pctText(p, d) {
  if (d !== 'auto') return p.toFixed(d) + '%';
  return (p >= 10 || p === 0 ? Math.round(p) : +p.toFixed(1)) + '%';
}
function valText(v, d) { return d === 'auto' ? fmt(v) : v.toFixed(d); }

function drawPie(c, titleH, data) {
  const C = S.chart, P = C.pie;
  const si = Math.min(P.series, data.series.length - 1);
  const vals = data.series[si].values;
  const slices = data.cats.map((name, j) => ({ name: name || `Slice ${j + 1}`, i: j, v: vals[j] }))
    .filter(s => s.v > 0);
  if (!slices.length) {
    const err = document.getElementById('parse-err');
    err.classList.remove('hidden');
    err.textContent = `No positive values in "${data.series[si].name}" to plot.`;
    return;
  }
  if (P.sort) slices.sort((a, b) => b.v - a.v);
  const total = slices.reduce((a, s) => a + s.v, 0);
  const color = j => P.colors[j] || PALETTE[j % PALETTE.length];

  const pad = S.fontSize * 0.8;
  const box = { x: pad, y: pad + titleH, w: S.w - pad * 2, h: S.h - pad * 2 - titleH };
  const lp = legendPos(slices.length);
  if (lp !== 'none') {
    const m = legend(c, slices, lp, box, false, color);
    legend(c, slices, lp, box, true, color);
    if (lp === 'top') { box.y += m.h; box.h -= m.h; }
    if (lp === 'bottom') box.h -= m.h;
    if (lp === 'right') box.w -= m.w;
  }

  // Slice angles, clockwise from 12 o'clock (+ rotate), and their label text.
  let a = -Math.PI / 2 + P.rotate * Math.PI / 180;
  for (const s of slices) {
    s.a0 = a; a += s.v / total * Math.PI * 2; s.a1 = a; s.mid = (s.a0 + s.a1) / 2;
    const p = pctText(s.v / total * 100, P.decimals), v = valText(s.v, P.decimals);
    s.text = { percent: p, value: v, name: s.name,
      'name-percent': s.name + '\n' + p, 'name-value': s.name + '\n' + v, none: '' }[P.labels];
    s.lines = s.text ? s.text.split('\n') : [];
  }

  const px = S.fontSize * 0.75, lineH = px * 1.15, lead = px * 1.2;
  c.font = font(px, true);
  for (const s of slices) {
    s.tw = s.lines.length ? Math.max(...s.lines.map(l => c.measureText(l).width)) : 0;
    s.th = s.lines.length * lineH;
  }

  // Radius, leaving room around the pie for whichever labels sit outside.
  const geom = outside => {
    const ow = outside.length ? Math.max(...outside.map(s => s.tw)) + lead + px * 0.4 : 0;
    const oh = outside.length ? lead + Math.max(...outside.map(s => s.th)) / 2 + px * 0.3 : 0;
    const r = Math.max(10, Math.min(box.w / 2 - ow, box.h / 2 - oh));
    return { r, rIn: r * P.hole / 100, cx: box.x + box.w / 2, cy: box.y + box.h / 2 };
  };
  const inSlice = (g, s, x, y) => {
    const d = Math.hypot(x - g.cx, y - g.cy);
    if (d >= g.r - P.gap || d <= g.rIn + P.gap) return false;
    let t = Math.atan2(y - g.cy, x - g.cx);
    while (t < s.a0) t += Math.PI * 2;
    return t < s.a1;
  };
  // Inside anchor: middle of the ring, or 62% out on a full pie (centre if it's the only slice).
  const insideAt = (g, s) => {
    if (slices.length === 1 && !g.rIn) return { x: g.cx, y: g.cy };
    const rl = g.rIn ? (g.rIn + g.r) / 2 : g.r * 0.62;
    return { x: g.cx + Math.cos(s.mid) * rl, y: g.cy + Math.sin(s.mid) * rl };
  };
  const fits = (g, s) => {
    if (slices.length === 1 && !g.rIn) return s.tw < g.r * 1.6;
    const { x, y } = insideAt(g, s), w = s.tw / 2 + px * 0.2, h = s.th / 2;
    return [[-w, -h], [w, -h], [-w, h], [w, h], [0, -h], [0, h]].every(([dx, dy]) => inSlice(g, s, x + dx, y + dy));
  };
  const labelled = slices.filter(s => s.lines.length);
  let g = geom(P.labelPos === 'outside' ? labelled : []);
  if (P.labelPos === 'outside') labelled.forEach(s => { s.out = true; });
  else if (P.labelPos === 'auto') {
    // Shrinking the pie to make room can push more labels out; re-test once.
    let out = labelled.filter(s => !fits(g, s));
    if (out.length) { g = geom(out); out = labelled.filter(s => !fits(g, s)); }
    out.forEach(s => { s.out = true; });
  }

  for (const s of slices) {
    c.beginPath();
    if (g.rIn) { c.arc(g.cx, g.cy, g.r, s.a0, s.a1); c.arc(g.cx, g.cy, g.rIn, s.a1, s.a0, true); }
    else { c.moveTo(g.cx, g.cy); c.arc(g.cx, g.cy, g.r, s.a0, s.a1); }
    c.closePath();
    c.fillStyle = color(s.i); c.fill();
  }
  // Gaps: radial seams in the background colour (cut out when transparent).
  if (P.gap > 0 && slices.length > 1) {
    c.save();
    if (S.transparent) { c.globalCompositeOperation = 'destination-out'; c.strokeStyle = '#000'; }
    else c.strokeStyle = S.bg;
    c.lineWidth = P.gap; c.lineCap = 'butt';
    c.beginPath();
    for (const s of slices) {
      const ox = Math.cos(s.a0), oy = Math.sin(s.a0);
      c.moveTo(g.cx + ox * g.rIn, g.cy + oy * g.rIn);
      c.lineTo(g.cx + ox * (g.r + 1), g.cy + oy * (g.r + 1));
    }
    c.stroke();
    c.restore();
  }

  // Inside labels: white with a soft dark edge so they read on any slice colour.
  c.font = font(px, true); c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
  for (const s of labelled) {
    if (s.out) continue;
    const at = insideAt(g, s);
    const top = at.y - (s.lines.length - 1) * lineH / 2;
    s.lines.forEach((ln, k) => {
      c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = Math.max(3, px * 0.16);
      c.strokeText(ln, at.x, top + k * lineH);
      c.fillStyle = '#ffffff'; c.fillText(ln, at.x, top + k * lineH);
    });
  }

  // Outside labels sit in a column either side of the pie, pushed apart vertically so
  // neighbours don't collide. Each leader runs from the slice edge out to an elbow on a
  // ring just outside the pie (at the label's height, so it never crosses the pie),
  // then across to the column.
  const outs = labelled.filter(s => s.out);
  const ring = g.r + lead * 0.6;
  for (const right of [true, false]) {
    const side = outs.filter(s => (Math.cos(s.mid) >= 0) === right)
      .map(s => ({ s, y: g.cy + Math.sin(s.mid) * ring }))
      .sort((p, q) => p.y - q.y);
    if (!side.length) continue;
    side[0].y = Math.max(side[0].y, box.y + side[0].s.th / 2);
    for (let k = 1; k < side.length; k++) {
      const minY = side[k - 1].y + (side[k - 1].s.th + side[k].s.th) / 2 + px * 0.15;
      if (side[k].y < minY) side[k].y = minY;
    }
    // A stack that ran off the bottom slides back up.
    const last = side[side.length - 1];
    const over = last.y + last.s.th / 2 - (box.y + box.h);
    if (over > 0) side.forEach(p => { p.y -= over; });
    const sgn = right ? 1 : -1;
    const colX = g.cx + sgn * (g.r + lead);
    for (const { s, y } of side) {
      const ex = g.cx + Math.cos(s.mid) * g.r, ey = g.cy + Math.sin(s.mid) * g.r;
      const dy = y - g.cy;
      const kx = g.cx + sgn * Math.sqrt(Math.max(0, ring * ring - dy * dy));
      c.strokeStyle = S.textColor; c.globalAlpha = 0.6; c.lineWidth = Math.max(1.5, px * 0.07);
      c.beginPath(); c.moveTo(ex, ey); c.lineTo(kx, y); c.lineTo(colX, y); c.stroke();
      c.globalAlpha = 1;
      c.fillStyle = S.textColor; c.textAlign = right ? 'left' : 'right';
      const top = y - (s.lines.length - 1) * lineH / 2;
      s.lines.forEach((ln, k) => c.fillText(ln, colX + sgn * px * 0.3, top + k * lineH));
    }
  }
}

// ---------- Render ----------

function layoutAndDraw() {
  canvas.width = S.w; canvas.height = S.h;
  ctx.clearRect(0, 0, S.w, S.h);
  if (!S.transparent) { ctx.fillStyle = S.bg; ctx.fillRect(0, 0, S.w, S.h); }

  let titleH = 0;
  if (S.title.trim()) {
    const px = S.fontSize * 1.35;
    ctx.font = font(px, true);
    ctx.fillStyle = S.textColor; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(S.title, S.w / 2, S.fontSize * 0.6);
    titleH = px * 1.5;
  }
  if (S.type === 'venn') drawVenn(ctx, titleH);
  else drawChart(ctx, titleH);

  document.getElementById('dims-out').textContent = `${S.w} × ${S.h} px · ${S.type}`;
}

// ---------- Venn controls ----------

function renderVennControls() {
  const V = S.venn;
  ['2', '3'].forEach(k => document.getElementById('venn-' + k).classList.toggle('active-mode', V.n === +k));
  document.getElementById('overlap-val').textContent = V.overlap + '%';
  document.getElementById('opacity-val').textContent = V.opacity + '%';

  const names = document.getElementById('venn-names');
  names.innerHTML = '';
  for (let i = 0; i < V.n; i++) {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = V.names[i]; inp.placeholder = `Circle ${'ABC'[i]}`;
    inp.style.width = '100%'; inp.style.marginBottom = '6px';
    inp.addEventListener('input', () => { V.names[i] = inp.value; renderRegionHeads(); layoutAndDraw(); });
    names.appendChild(inp);
  }

  const list = document.getElementById('venn-regions');
  list.innerHTML = '';
  for (const [key] of REGIONS[V.n]) {
    const row = document.createElement('div');
    row.className = 'g-row';
    const head = document.createElement('div');
    head.className = 'g-head';
    const name = document.createElement('span');
    name.className = 'g-name'; name.dataset.region = key;
    const col = document.createElement('input');
    col.type = 'color'; col.value = V.fills[key] || '#cccccc'; col.title = 'Fill for this segment';
    col.addEventListener('input', () => { V.fills[key] = col.value; layoutAndDraw(); });
    head.appendChild(name); head.appendChild(col);
    const ta = document.createElement('textarea');
    ta.rows = 2; ta.value = V.text[key] || ''; ta.placeholder = 'text in this segment';
    ta.addEventListener('input', () => { V.text[key] = ta.value; layoutAndDraw(); });
    row.appendChild(head); row.appendChild(ta);
    list.appendChild(row);
  }
  renderRegionHeads();
}
// Region titles use the circle names ("Cats ∩ Dogs"), so they follow renames.
function renderRegionHeads() {
  const V = S.venn;
  const nm = k => (V.names['ABC'.indexOf(k)] || '').trim() || k;
  document.querySelectorAll('#venn-regions .g-name').forEach(el => {
    const key = el.dataset.region;
    el.textContent = key.length === 1 ? nm(key) + ' only'
      : key.length === V.n && V.n === 3 ? 'All three' : [...key].map(nm).join(' ∩ ');
  });
}

document.getElementById('venn-2').addEventListener('click', () => { S.venn.n = 2; renderVennControls(); layoutAndDraw(); });
document.getElementById('venn-3').addEventListener('click', () => { S.venn.n = 3; renderVennControls(); layoutAndDraw(); });
document.getElementById('overlap').addEventListener('input', (e) => {
  S.venn.overlap = +e.target.value; renderVennControls(); layoutAndDraw();
});
document.getElementById('venn-auto').addEventListener('click', () => {
  S.venn.noFill = false; document.getElementById('venn-nofill').checked = false;
  vennFillFrom(PALETTE.slice(0, 3)); renderVennControls(); layoutAndDraw();
});
document.getElementById('venn-random').addEventListener('click', () => {
  S.venn.noFill = false; document.getElementById('venn-nofill').checked = false;
  vennFillFrom(randomHues(3)); renderVennControls(); layoutAndDraw();
});
document.getElementById('venn-nofill').addEventListener('change', (e) => { S.venn.noFill = e.target.checked; layoutAndDraw(); });
document.getElementById('venn-opacity').addEventListener('input', (e) => {
  S.venn.opacity = +e.target.value;
  document.getElementById('opacity-val').textContent = S.venn.opacity + '%';
  layoutAndDraw();
});
document.getElementById('venn-outline-w').addEventListener('input', (e) => {
  S.venn.outlineW = Math.max(0, Math.min(30, parseInt(e.target.value, 10) || 0)); layoutAndDraw();
});
document.getElementById('venn-outline').addEventListener('input', (e) => { S.venn.outline = e.target.value; layoutAndDraw(); });

// ---------- Chart controls ----------

function renderSeriesList() {
  const data = parseCSV(S.chart.csv);
  const list = document.getElementById('series-list');
  // Don't rebuild while the user is typing a name in this list — it'd steal focus.
  if (list.contains(document.activeElement)) return;
  list.innerHTML = '';
  if (data.error) return;
  if (S.type === 'pie') return renderSliceList(data, list);
  data.series.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'series-row';
    const col = document.createElement('input');
    col.type = 'color'; col.value = S.chart.colors[i] || PALETTE[i % PALETTE.length];
    col.addEventListener('input', () => { S.chart.colors[i] = col.value; layoutAndDraw(); });
    const name = document.createElement('input');
    name.type = 'text'; name.value = s.name; name.title = 'Legend label (also renames the column in the data)';
    name.addEventListener('input', () => { renameSeries(i, name.value); layoutAndDraw(); });
    row.appendChild(col); row.appendChild(name);
    list.appendChild(row);
  });
}

// Pie: one row per slice (category) — colour + name; renaming rewrites the row's first cell.
function renderSliceList(data, list) {
  const P = S.chart.pie;
  data.cats.forEach((cat, j) => {
    const row = document.createElement('div');
    row.className = 'series-row';
    const col = document.createElement('input');
    col.type = 'color'; col.value = P.colors[j] || PALETTE[j % PALETTE.length];
    col.addEventListener('input', () => { P.colors[j] = col.value; layoutAndDraw(); });
    const name = document.createElement('input');
    name.type = 'text'; name.value = cat; name.title = 'Slice label (also renames the row in the data)';
    name.addEventListener('input', () => { renameCategory(j, name.value); layoutAndDraw(); });
    row.appendChild(col); row.appendChild(name);
    list.appendChild(row);
  });
  // Value-column picker only matters with 2+ series.
  const sel = document.getElementById('pie-series');
  sel.innerHTML = '';
  data.series.forEach((s, i) => {
    const o = document.createElement('option'); o.value = i; o.textContent = s.name; sel.appendChild(o);
  });
  P.series = Math.min(P.series, data.series.length - 1);
  sel.value = P.series;
  document.getElementById('pie-series-wrap').classList.toggle('hidden', data.series.length < 2);
}

function setType(t) {
  S.type = t;
  ['venn', 'bar', 'line', 'pie'].forEach(x => document.getElementById('type-' + x).classList.toggle('active-mode', x === t));
  document.getElementById('venn-controls').classList.toggle('hidden', t !== 'venn');
  document.getElementById('chart-controls').classList.toggle('hidden', t === 'venn');
  document.querySelectorAll('.bar-only').forEach(el => el.classList.toggle('hidden', t !== 'bar'));
  document.querySelectorAll('.line-only').forEach(el => el.classList.toggle('hidden', t !== 'line'));
  document.querySelectorAll('.pie-only').forEach(el => el.classList.toggle('hidden', t !== 'pie'));
  document.querySelectorAll('.not-pie').forEach(el => el.classList.toggle('hidden', t === 'pie'));
  document.getElementById('series-head').textContent = t === 'pie' ? 'Slices & legend' : 'Series & legend';
  document.getElementById('legend-auto').textContent = t === 'pie'
    ? 'Auto (right, unless labels show names)' : 'Auto (top, when 2+ series)';
  renderSeriesList();
  layoutAndDraw();
}
['venn', 'bar', 'line', 'pie'].forEach(t => document.getElementById('type-' + t).addEventListener('click', () => setType(t)));

document.getElementById('csv').addEventListener('input', (e) => {
  S.chart.csv = e.target.value; renderSeriesList(); layoutAndDraw();
});
document.getElementById('series-auto').addEventListener('click', () => {
  if (S.type === 'pie') S.chart.pie.colors = PALETTE.slice();
  else S.chart.colors = PALETTE.slice();
  renderSeriesList(); layoutAndDraw();
});
document.getElementById('series-random').addEventListener('click', () => {
  const d = parseCSV(S.chart.csv);
  if (S.type === 'pie') S.chart.pie.colors = randomHues(d.error ? 5 : d.cats.length);
  else S.chart.colors = randomHues(d.error ? 3 : d.series.length);
  renderSeriesList(); layoutAndDraw();
});
document.getElementById('legend').addEventListener('change', (e) => { S.chart.legend = e.target.value; layoutAndDraw(); });
document.getElementById('x-label').addEventListener('input', (e) => { S.chart.xLabel = e.target.value; layoutAndDraw(); });
document.getElementById('y-label').addEventListener('input', (e) => { S.chart.yLabel = e.target.value; layoutAndDraw(); });
['y-min', 'y-max'].forEach(id => document.getElementById(id).addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  S.chart[id === 'y-min' ? 'yMin' : 'yMax'] = Number.isFinite(v) ? v : null;
  layoutAndDraw();
}));
[['grid', 'grid'], ['values', 'values'], ['stacked', 'stacked'], ['horizontal', 'horizontal'],
 ['markers', 'markers'], ['smooth', 'smooth']].forEach(([id, key]) =>
  document.getElementById(id).addEventListener('change', (e) => { S.chart[key] = e.target.checked; layoutAndDraw(); }));
document.getElementById('line-w').addEventListener('input', (e) => {
  S.chart.lineW = +e.target.value;
  document.getElementById('line-w-val').textContent = S.chart.lineW + 'px';
  layoutAndDraw();
});

// ---------- Bar style controls ----------

(() => {
  const B = S.chart.bar;
  const $ = id => document.getElementById(id);
  const sel = $('bar-fill');
  for (const [v, label] of FILL_STYLES) {
    const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o);
  }
  sel.value = B.fill;
  const syncVis = () => {
    $('bar-blocks-opts').classList.toggle('hidden', B.fill !== 'blocks');
    $('bar-stripes-opts').classList.toggle('hidden', B.fill !== 'stripes');
    $('bar-color2').disabled = B.color2Auto;
    $('bar-track-opts').classList.toggle('hidden', !B.track);
    $('bar-track-fill').disabled = !B.trackFillOn;
  };
  sel.addEventListener('change', () => { B.fill = sel.value; syncVis(); layoutAndDraw(); });
  // number/range inputs → B[key], clamped; ranges also update their readout
  [['bar-block', 'block', 1, 200], ['bar-gap', 'gap', 0, 100], ['bar-stripe', 'stripe', 1, 200],
   ['bar-angle', 'angle', -90, 90], ['bar-radius', 'radius', 0, 60],
   ['bar-track-bw', 'trackBorderW', 0, 20], ['bar-inset', 'inset', 0, 40]].forEach(([id, key, min, max]) => {
    const el = $(id), out = $(id + '-val');
    const show = () => { if (out) out.textContent = B[key] + (key === 'angle' ? '°' : 'px'); };
    el.value = B[key]; show();
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      B[key] = Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
      show(); layoutAndDraw();
    });
  });
  [['bar-color2', 'color2'], ['bar-track-border', 'trackBorder'], ['bar-track-fill', 'trackFill']].forEach(([id, key]) => {
    $(id).value = B[key];
    $(id).addEventListener('input', (e) => { B[key] = e.target.value; layoutAndDraw(); });
  });
  [['bar-color2-auto', 'color2Auto'], ['bar-track', 'track'], ['bar-track-fill-on', 'trackFillOn']].forEach(([id, key]) => {
    $(id).checked = B[key];
    $(id).addEventListener('change', (e) => { B[key] = e.target.checked; syncVis(); layoutAndDraw(); });
  });
  syncVis();
})();

// ---------- Pie controls ----------

(() => {
  const P = S.chart.pie;
  const $ = id => document.getElementById(id);
  $('pie-series').addEventListener('change', (e) => { P.series = +e.target.value; layoutAndDraw(); });
  [['pie-hole', 'hole', '%'], ['pie-gap', 'gap', 'px'], ['pie-rotate', 'rotate', '°']].forEach(([id, key, unit]) => {
    const el = $(id), out = $(id + '-val');
    const show = () => { out.textContent = P[key] + unit; };
    el.value = P[key]; show();
    el.addEventListener('input', () => { P[key] = +el.value; show(); layoutAndDraw(); });
  });
  [['pie-labels', 'labels'], ['pie-label-pos', 'labelPos']].forEach(([id, key]) => {
    $(id).value = P[key];
    $(id).addEventListener('change', (e) => { P[key] = e.target.value; layoutAndDraw(); });
  });
  $('pie-decimals').value = P.decimals;
  $('pie-decimals').addEventListener('change', (e) => {
    P.decimals = e.target.value === 'auto' ? 'auto' : +e.target.value; layoutAndDraw();
  });
  $('pie-sort').checked = P.sort;
  $('pie-sort').addEventListener('change', (e) => { P.sort = e.target.checked; layoutAndDraw(); });
})();

// ---------- Shared controls ----------

document.getElementById('title').addEventListener('input', (e) => { S.title = e.target.value; layoutAndDraw(); });
document.getElementById('font').addEventListener('change', (e) => { S.font = e.target.value; layoutAndDraw(); });
document.getElementById('font-size').addEventListener('input', (e) => {
  S.fontSize = Math.max(8, Math.min(120, parseInt(e.target.value, 10) || 8)); layoutAndDraw();
});
document.getElementById('text-color').addEventListener('input', (e) => { S.textColor = e.target.value; layoutAndDraw(); });
document.getElementById('cw').addEventListener('input', (e) => {
  S.w = Math.max(100, Math.min(4000, parseInt(e.target.value, 10) || 100)); layoutAndDraw();
});
document.getElementById('ch').addEventListener('input', (e) => {
  S.h = Math.max(100, Math.min(4000, parseInt(e.target.value, 10) || 100)); layoutAndDraw();
});
document.getElementById('transparent').addEventListener('change', (e) => { S.transparent = e.target.checked; layoutAndDraw(); });
document.getElementById('bg').addEventListener('input', (e) => { S.bg = e.target.value; layoutAndDraw(); });

// ---------- Export / copy ----------

function toBlob() {
  return new Promise(res => canvas.toBlob(res, 'image/png'));
}

document.getElementById('btn-export').addEventListener('click', async () => {
  const blob = await toBlob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${S.type}-${Date.now()}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

document.getElementById('btn-copy').addEventListener('click', async () => {
  const b = document.getElementById('btn-copy');
  const old = b.textContent;
  try {
    const blob = await toBlob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    b.textContent = '✓ Copied';
    setTimeout(() => { b.textContent = old; }, 1200);
  } catch (err) {
    console.error(err);
    b.textContent = 'Copy failed';
    setTimeout(() => { b.textContent = old; }, 1400);
  }
  // Into the editor's meme history too, even if the clipboard write was refused.
  const name = S.title.trim() || { venn: 'Venn diagram', bar: 'Bar chart', line: 'Line chart', pie: 'Pie chart' }[S.type];
  try { await addImageHistory(canvas, name); } catch (err) { console.error(err); }
});

// Initial render.
document.getElementById('csv').value = S.chart.csv;
document.getElementById('y-label').value = S.chart.yLabel;
document.getElementById('line-w-val').textContent = S.chart.lineW + 'px';
vennFillFrom(PALETTE.slice(0, 3));
renderVennControls();
renderSeriesList();
setType('venn');
// Web fonts (Impact etc. are local, but a slow first paint can miss them) — redraw once ready.
if (document.fonts && document.fonts.ready) document.fonts.ready.then(layoutAndDraw);

initMobileShell();
