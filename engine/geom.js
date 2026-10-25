// ---------- Geometry helpers ----------
// Every layer rides the same transform: a centre (cx, cy), a uniform scale, a
// rotation and an optional horizontal flip. These map between canvas space and
// a layer's local space. Pure — no state, no canvas.

export function rot(x, y, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}
// half extents of a layer in canvas pixels (after its scale)
export function halfExtents(l) { return [l.w * l.scale / 2, l.h * l.scale / 2]; }

export function corners(l) {
  const [hw, hh] = halfExtents(l);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const [dx, dy] = rot(sx * hw, sy * hh, l.rotation);
    return [l.cx + dx, l.cy + dy];
  });
}
export function rotateHandlePos(l) {
  const [, hh] = halfExtents(l);
  const [dx, dy] = rot(0, -(hh + 26), l.rotation);
  return [l.cx + dx, l.cy + dy];
}
// World position of the amplitude handle for a squiggle vector layer —
// sits on the wave's top peak (local (0, -amp * scale)).
export function squiggleAmpHandlePos(l) {
  const [dx, dy] = rot(0, -l.amp * l.scale, l.rotation);
  return [l.cx + dx, l.cy + dy];
}
// World position of the height handle for an auto-fit text layer — sits just
// below the bottom-centre of the box. Dragging it grows the box height (and
// auto-derives Max lines). Offset by 16px so it clears the box edge.
export function textHeightHandlePos(l) {
  const [, hh] = halfExtents(l);
  const [dx, dy] = rot(0, hh + 16, l.rotation);
  return [l.cx + dx, l.cy + dy];
}
// world point -> layer-local (un-rotated, un-scaled-to-base) coords
export function toLocal(l, px, py) {
  const [lx, ly] = rot(px - l.cx, py - l.cy, -l.rotation);
  return [lx, ly];
}
export function hitLayer(l, px, py) {
  const [lx, ly] = toLocal(l, px, py);
  const [hw, hh] = halfExtents(l);
  return Math.abs(lx) <= hw && Math.abs(ly) <= hh;
}

// Map a canvas-space point to a pixel coordinate inside a layer's backing canvas,
// undoing its rotation, scale and horizontal flip.
export function canvasToImagePx(l, px, py) {
  let [lx, ly] = rot(px - l.cx, py - l.cy, -l.rotation);
  if (l.flipH) lx = -lx;
  const ox = l.crop ? l.crop.x : 0, oy = l.crop ? l.crop.y : 0;
  return [lx / l.scale + l.w / 2 + ox, ly / l.scale + l.h / 2 + oy];
}
