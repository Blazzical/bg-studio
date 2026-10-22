// ---------- Vector shapes ----------
// A vector layer stores its geometry in local coordinates centred on the origin,
// then rides the same cx/cy + scale + rotation transform as every other layer.
// pts-based subtypes (line, path) keep an array of local points; the others are
// parameterised (rect/ellipse by w,h · star by radius/points/inner · squiggle by
// w/amp/waves · bar by w,h + value, see drawBar in render.js). isClosed decides
// whether a fill is meaningful.
import { rot, hitLayer } from './geom.js';
import { scratchCtx } from './scratch.js';

export function isPointVec(l) { return l && l.type === 'vector' && (l.subtype === 'line' || l.subtype === 'path'); }
export function isClosedVec(l) {
  if (l.subtype === 'rect' || l.subtype === 'ellipse' || l.subtype === 'star' || l.subtype === 'bar') return true;
  if (l.subtype === 'path') return !!l.closed;
  return false;
}

// Build the shape as a Path2D in local (unscaled, unrotated) coordinates.
export function vectorPath(l) {
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
  } else if (l.subtype === 'bar') {
    // The outer track; drawBar paints the fill inside it.
    const r = Math.max(0, Math.min(l.radius || 0, l.w / 2, l.h / 2));
    if (r && p.roundRect) p.roundRect(-l.w / 2, -l.h / 2, l.w, l.h, r);
    else p.rect(-l.w / 2, -l.h / 2, l.w, l.h);
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
export function recomputeVectorBounds(l) {
  if (l.subtype === 'rect' || l.subtype === 'ellipse' || l.subtype === 'bar') return;  // w,h are authoritative
  if (l.subtype === 'star') { l.w = l.h = 2 * l.radius; return; }
  if (l.subtype === 'squiggle') { l.h = 2 * l.amp + Math.max(l.strokeW, 2); return; }
  recenterVector(l);  // line, path
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of l.pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  l.w = Math.max(maxX - minX, 1); l.h = Math.max(maxY - minY, 1);
}

// Set a vector's width ('x') or height ('y') directly. Box shapes take it as-is;
// pts-based shapes (line/path) scale their points along that axis to fit.
export function setVectorDim(l, axis, target) {
  if (l.subtype === 'rect' || l.subtype === 'ellipse' || l.subtype === 'bar') { l[axis === 'x' ? 'w' : 'h'] = target; return; }
  if (l.pts) {
    const cur = axis === 'x' ? l.w : l.h;
    if (cur > 1) {
      const s = target / cur, k = axis === 'x' ? 0 : 1;
      for (const p of l.pts) { p[k] *= s; if (p[2]) p[2][k] *= s; if (p[3]) p[3][k] *= s; }
    }
  }
}

// A local point -> canvas coords (for drawing/grabbing vertex handles).
export function vectorPointCanvas(l, pt) {
  let lx = pt[0] * l.scale, ly = pt[1] * l.scale;
  if (l.flipH) lx = -lx;
  const [dx, dy] = rot(lx, ly, l.rotation);
  return [l.cx + dx, l.cy + dy];
}
// Canvas coords -> a local point (for setting a dragged vertex).
export function canvasToVectorLocal(l, px, py) {
  let [lx, ly] = rot(px - l.cx, py - l.cy, -l.rotation);
  if (l.flipH) lx = -lx;
  return [lx / l.scale, ly / l.scale];
}
// Canvas position of an anchor's handle knob, or null if that handle is absent.
// (Handle offsets live at pt[2] = in, pt[3] = out.)
export function vectorHandleCanvas(l, i, which) {
  const h = l.pts[i][which];
  if (!h) return null;
  return vectorPointCanvas(l, [l.pts[i][0] + h[0], l.pts[i][1] + h[1]]);
}

// Precise hit test: inside the fill (closed shapes) or within the stroke + a few
// canvas-px of slop, rather than the loose bounding box hitLayer uses.
export function hitVector(l, px, py) {
  const [lx, ly] = canvasToVectorLocal(l, px, py);
  const path = vectorPath(l);
  const c = scratchCtx();
  let hit = false;
  c.save();
  if (isClosedVec(l) && l.fill) hit = c.isPointInPath(path, lx, ly);
  if (!hit && (l.strokeW > 0 || !l.fill)) {
    c.lineWidth = Math.max(l.strokeW, 4 / l.scale) + 10 / l.scale;
    hit = c.isPointInStroke(path, lx, ly);
  }
  c.restore();
  return hit;
}
// Unified hit test used by picking / hover.
export function layerHit(l, px, py) { return l.type === 'vector' ? hitVector(l, px, py) : hitLayer(l, px, py); }
