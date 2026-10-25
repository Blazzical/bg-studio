// ---------- Fill patterns ----------
// Paint a rectangle with a decorative fill. Shared by the editor's loading-bar
// shape (engine/vector.js 'bar') and the Graphs page's bar charts.
//
// opts:
//   style   'solid' | 'blocks' | 'stripes'
//   color   main colour
//   color2  second stripe colour ('' = leave the gaps between stripes empty)
//   block   blocks: segment length in px          (default 8)
//   gap     blocks: gap between segments in px    (default 2)
//   stripe  stripes: band width in px             (default 10)
//   angle   stripes: band angle in degrees        (default 45, barber pole)
//   dir     which way the fill grows, so blocks start at the "empty" end:
//           'ltr' | 'rtl' | 'btt' | 'ttb'          (default 'ltr')
//   radius  corner radius of the clip, px         (default 0)
//
// Blocks are always whole segments counted from the start edge, so a bar that
// grows doesn't make every block shimmer; the last one is cut by the fill edge.

export const FILL_STYLES = [['solid', 'Solid'], ['blocks', 'Blocks'], ['stripes', 'Barber pole']];

function roundRectPath(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r || 0, w / 2, h / 2));
  c.beginPath();
  if (r && c.roundRect) c.roundRect(x, y, w, h, r);
  else c.rect(x, y, w, h);
}

export function paintFill(c, x, y, w, h, opts = {}) {
  if (w <= 0 || h <= 0) return;
  const style = opts.style || 'solid';
  c.save();
  roundRectPath(c, x, y, w, h, opts.radius);
  c.clip();
  if (style === 'blocks') {
    const block = Math.max(1, opts.block || 8), gap = Math.max(0, opts.gap != null ? opts.gap : 2);
    const dir = opts.dir || 'ltr';
    const horiz = dir === 'ltr' || dir === 'rtl';
    const len = horiz ? w : h;
    c.fillStyle = opts.color;
    for (let s = 0; s < len; s += block + gap) {
      const seg = Math.min(block, len - s);
      if (dir === 'ltr') c.fillRect(x + s, y, seg, h);
      else if (dir === 'rtl') c.fillRect(x + w - s - seg, y, seg, h);
      else if (dir === 'ttb') c.fillRect(x, y + s, w, seg);
      else c.fillRect(x, y + h - s - seg, w, seg);   // btt
    }
  } else if (style === 'stripes') {
    if (opts.color2) { c.fillStyle = opts.color2; c.fillRect(x, y, w, h); }
    const stripe = Math.max(1, opts.stripe || 10);
    const a = ((opts.angle != null ? opts.angle : 45) * Math.PI) / 180;
    // Draw bands in a rotated frame big enough to cover the rect at any angle.
    const cx = x + w / 2, cy = y + h / 2, R = Math.hypot(w, h) / 2 + stripe * 2;
    c.translate(cx, cy);
    c.rotate(a);
    c.fillStyle = opts.color;
    // Bands sit on a grid in canvas space (projected onto the stripe axis), not
    // relative to the rect, so stripes stay put as a bar's fill length changes.
    const P = stripe * 2, proj = cx * Math.cos(a) + cy * Math.sin(a);
    for (let u = Math.floor((proj - R) / P) * P; u < proj + R; u += P) c.fillRect(u - proj, -R, stripe, R * 2);
  } else {
    c.fillStyle = opts.color;
    c.fillRect(x, y, w, h);
  }
  c.restore();
}

// The same rounded-rect outline, for callers drawing a track/border around a fill.
export function strokeRoundRect(c, x, y, w, h, r) {
  roundRectPath(c, x, y, w, h, r);
  c.stroke();
}
export function fillRoundRect(c, x, y, w, h, r) {
  roundRectPath(c, x, y, w, h, r);
  c.fill();
}
