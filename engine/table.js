// ---------- Tables ----------
// A table layer is a grid of cells with optional row/column spans. Geometry is
// in base pixels (cols * cellW by rows * cellH) and rides the standard layer
// transform. Merged cells are modelled by giving the anchor cell a cspan/rspan
// and hiding whatever it covers.
import { rot } from './geom.js';

export function newCell() { return { text: '', bg: '#ffffff', fg: '', align: 'center', cspan: 1, rspan: 1 }; }

export function tableResize(l) { l.w = l.cols * l.cellW; l.h = l.rows * l.cellH; }

// Which cells are hidden because a neighbour spans over them.
export function computeCovered(l) {
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
export function anchorOf(l, r, c) {
  for (let ar = 0; ar <= r; ar++) {
    for (let ac = 0; ac <= c; ac++) {
      const cell = l.cells[ar][ac];
      const cs = Math.min(cell.cspan || 1, l.cols - ac), rs = Math.min(cell.rspan || 1, l.rows - ar);
      if (r >= ar && r < ar + rs && c >= ac && c < ac + cs) return [ar, ac];
    }
  }
  return [r, c];
}

export function drawTable(c, l) {
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
export function tableBaseToCanvas(l, bx, by) {
  let lx = (bx - l.w / 2) * l.scale, ly = (by - l.h / 2) * l.scale;
  if (l.flipH) lx = -lx;
  const [dx, dy] = rot(lx, ly, l.rotation);
  return [l.cx + dx, l.cy + dy];
}

export function selBounds(l) {
  const A = l.sel.start, B = l.sel.end;
  const ca = l.cells[A[0]][A[1]], cb = l.cells[B[0]][B[1]];
  const r0 = Math.min(A[0], B[0]), c0 = Math.min(A[1], B[1]);
  const r1 = Math.max(A[0] + (ca.rspan || 1) - 1, B[0] + (cb.rspan || 1) - 1);
  const c1 = Math.max(A[1] + (ca.cspan || 1) - 1, B[1] + (cb.cspan || 1) - 1);
  return [r0, c0, Math.min(r1, l.rows - 1), Math.min(c1, l.cols - 1)];
}
export function forEachSelCell(l, fn) {
  const [r0, c0, r1, c1] = selBounds(l);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(l.cells[r][c]);
}
export function selCell(l) { const [r, c] = l.sel.start; return l.cells[r][c]; }
