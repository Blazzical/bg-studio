// ---------- Layer rendering ----------
// Renders one layer to any 2D context. Pure with respect to app state: it reads
// only the layer and writes only the context, which is what lets the same code
// paint the live stage, an export buffer, and an offscreen GIF frame.
//
// Selection handles and other editor chrome deliberately live above this, in the
// caller — so an exported frame can never contain them.
import { drawTextHighlight, measureChars, charFont, sameDraw, lineHeight } from './text.js';
import { vectorPath, isClosedVec } from './vector.js';
import { paintFill } from './fills.js';
import { drawTable } from './table.js';
import { filterString, pixelateCanvas, fxBuffer } from './filters.js';

// An animation modifier, as produced by anim.js computeAnim(). The identity
// value means "draw the layer exactly as authored" — which is what the still
// editor always passes.
export const NO_ANIM = { opacity: 1, offsetX: 0, offsetY: 0, scale: 1, rotation: 0, textClip: 1 };

// Does this layer paint over itself? Then a partial alpha has to be applied to
// the finished layer, not to each of its parts — see drawLayer.
function selfOverlaps(l) {
  if (l.type === 'text') return l.strokeW > 0 || l.hlOn;
  if (l.type === 'vector') return l.strokeW > 0 && !!l.fill;
  if (l.type === 'table') return true;   // borderless cells deliberately overlap by ~1px
  return false;                          // image/paint is a single drawImage
}

// Scratch buffers for group-alpha compositing. Pooled rather than a singleton
// because pixelate holds fxBuffer at the same time.
const _pool = [];
function getBuf(w, h) {
  const b = _pool.pop() || document.createElement('canvas');
  if (b.width !== w || b.height !== h) { b.width = w; b.height = h; }
  else b.getContext('2d').clearRect(0, 0, w, h);
  return b;
}

// `scene` supplies the buffer size for the two passes that need a screen-space
// buffer: pixelate, and group alpha.
export function drawLayer(c, l, anim = NO_ANIM, scene = null) {
  const alpha = l.opacity * anim.opacity;
  // Group opacity. drawLayerRaw strokes and then fills, so at alpha < 1 the
  // now-translucent fill can no longer mask the stroke underneath it and an
  // outlined glyph goes grey through the middle (and, counterintuitively, gains
  // ink as it fades). Render the layer opaque, then fade the whole result.
  if (scene && alpha < 1 && alpha > 0 && selfOverlaps(l)) {
    const buf = getBuf(scene.w, scene.h);
    drawLayerInner(buf.getContext('2d'), l, anim, scene, 1);
    c.save();
    c.globalAlpha = alpha;
    c.drawImage(buf, 0, 0);
    c.restore();
    _pool.push(buf);
    return;
  }
  drawLayerInner(c, l, anim, scene, alpha);
}

function drawLayerInner(c, l, anim, scene, alpha) {
  const px = l.filters && l.filters.pixelate;
  if (px >= 2 && scene) {
    // pixelate needs a screen-space pass: render the layer to a buffer, then blockify it
    const buf = fxBuffer(scene.w, scene.h), bc = buf.getContext('2d');
    bc.clearRect(0, 0, buf.width, buf.height);
    drawLayerRaw(bc, l, anim, alpha);
    pixelateCanvas(buf, px);
    c.drawImage(buf, 0, 0);
  } else {
    drawLayerRaw(c, l, anim, alpha);
  }
}

// `alpha` defaults to the layer's own effective opacity; drawLayer overrides it
// to 1 when it is compositing the layer as a group.
export function drawLayerRaw(c, l, anim = NO_ANIM, alpha = l.opacity * anim.opacity) {
  c.save();
  c.globalAlpha = alpha;
  c.filter = filterString(l.filters);
  // The anim offset/rotation/scale ride on top of the layer's own transform.
  // Each type applies l.scale itself below, so an anim scale applied here is
  // uniform across every layer type for free.
  c.translate(l.cx + anim.offsetX, l.cy + anim.offsetY);
  c.rotate(l.rotation + anim.rotation);
  if (anim.scale !== 1) c.scale(anim.scale, anim.scale);
  if (l.flipH) c.scale(-1, 1);
  if (l.type === 'image' && l.img) {
    const w = l.w * l.scale, h = l.h * l.scale;
    if (l.crop) c.drawImage(l.img, l.crop.x, l.crop.y, l.crop.w, l.crop.h, -w / 2, -h / 2, w, h);
    else c.drawImage(l.img, -w / 2, -h / 2, w, h);
  } else if (l.type === 'text') {
    c.scale(l.scale, l.scale);
    // Runs are laid out left-to-right by hand (per-character bold/italic mean a
    // line can mix faces), so we always draw with textAlign 'left' and compute
    // each line's start x from its own measured width.
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    const align = l.align || 'center';
    const lines = l._lines || [];
    const lineHs = l._lineHs || lines.map(ln => lineHeight(ln, l.fontSize));
    const totalH = lineHs.reduce((a, b) => a + b, 0);
    const maxW = l._maxW || 1;
    if (l.hlOn) drawTextHighlight(c, l, lines, lineHs, align);
    // textClip < 1 reveals only the first N% of the layer's characters (a typing
    // effect). Counted across the whole layer, not per line, so the reveal runs
    // continuously through a wrapped paragraph.
    const totalChars = lines.reduce((a, ln) => a + ln.length, 0);
    const shown = anim.textClip >= 1 ? Infinity : Math.floor(totalChars * anim.textClip);
    let seen = 0;
    let top = -totalH / 2;
    lines.forEach((ln, i) => {
      const lh = lineHs[i];
      const y = top + lh / 2;               // baseline centre for this line
      top += lh;
      const lineW = ln.length ? measureChars(l.fontSize, ln, 0, ln.length) : 0;
      let x = align === 'left' ? -maxW / 2 : align === 'right' ? maxW / 2 - lineW : -lineW / 2;
      let idx = 0;
      while (idx < ln.length) {
        const d = ln[idx]; let j = idx, s = '';
        while (j < ln.length && sameDraw(ln[j], d)) { s += ln[j].ch; j++; }
        const rsize = l.fontSize * d.sizeMul;
        c.font = charFont(d, l.fontSize);
        const rw = c.measureText(s).width;
        if (seen < shown) {
          // Partially-revealed run: draw only the characters still within budget.
          const take = Math.min(s.length, shown - seen);
          const vis = take >= s.length ? s : s.slice(0, take);
          if (d.strokeW > 0) { c.strokeStyle = d.stroke; c.lineWidth = d.strokeW; c.strokeText(vis, x, y); }
          c.fillStyle = d.color;
          c.fillText(vis, x, y);
          if (d.u) {   // underline scaled to this run's size
            const uw = take >= s.length ? rw : c.measureText(vis).width;
            const uy = y + rsize * 0.36;
            c.strokeStyle = d.color;
            c.lineWidth = Math.max(1, rsize * 0.055);
            c.beginPath(); c.moveTo(x, uy); c.lineTo(x + uw, uy); c.stroke();
          }
        }
        seen += s.length;
        x += rw; idx = j;
      }
    });
  } else if (l.type === 'table') {
    c.scale(l.scale, l.scale);
    c.translate(-l.w / 2, -l.h / 2);
    drawTable(c, l);
  } else if (l.type === 'vector') {
    c.scale(l.scale, l.scale);
    const path = vectorPath(l);
    if (l.subtype === 'bar') { drawBar(c, l, path); c.restore(); return; }
    c.lineCap = l.cap; c.lineJoin = l.join;
    if (l.dashed && l.strokeW > 0) c.setLineDash([l.strokeW * 2.4, l.strokeW * 1.8]);
    if (isClosedVec(l) && l.fill) { c.fillStyle = l.fill; c.fill(path); }
    if (l.strokeW > 0) { c.strokeStyle = l.stroke; c.lineWidth = l.strokeW; c.stroke(path); }
  }
  c.restore();
}

// Loading bar: track (l.track, '' = none) → fill covering l.value% of the
// inner box (inset by l.inset) in l.fillStyle → border → optional % label.
// Called in the layer's local frame (origin at centre, already scaled).
function drawBar(c, l, path) {
  const w = l.w, h = l.h, r = Math.max(0, Math.min(l.radius || 0, w / 2, h / 2));
  if (l.track) { c.fillStyle = l.track; c.fill(path); }
  const ins = Math.max(0, Math.min(l.inset || 0, w / 2 - 1, h / 2 - 1));
  const ix = -w / 2 + ins, iy = -h / 2 + ins, iw = w - ins * 2, ih = h - ins * 2;
  const v = Math.max(0, Math.min(100, l.value != null ? l.value : 60)) / 100;
  const dir = l.dir || 'ltr';
  let fx = ix, fy = iy, fw = iw, fh = ih;
  if (dir === 'ltr') fw = iw * v;
  else if (dir === 'rtl') { fw = iw * v; fx = ix + iw - fw; }
  else if (dir === 'ttb') fh = ih * v;
  else { fh = ih * v; fy = iy + ih - fh; }   // btt
  if (l.fill && fw > 0 && fh > 0) {
    // Clip to the inner rounded box so a partial fill keeps the track's
    // rounded ends instead of rounding its own cut edge.
    c.save();
    const ir = Math.max(0, r - ins);
    c.beginPath();
    if (ir && c.roundRect) c.roundRect(ix, iy, iw, ih, ir); else c.rect(ix, iy, iw, ih);
    c.clip();
    paintFill(c, fx, fy, fw, fh, {
      style: l.fillStyle, color: l.fill, color2: l.color2,
      block: l.block, gap: l.gap, stripe: l.stripe, angle: l.angle, dir,
    });
    c.restore();
  }
  if (l.strokeW > 0) { c.strokeStyle = l.stroke; c.lineWidth = l.strokeW; c.stroke(path); }
  if (l.showPct) {
    const fs = Math.max(6, Math.min(h, w) * 0.55);
    c.font = `bold ${fs}px Arial, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.lineWidth = Math.max(2, fs * 0.16); c.strokeStyle = l.pctStroke || '#000000';
    const txt = Math.round(v * 100) + '%';
    c.strokeText(txt, 0, 0);
    c.fillStyle = l.pctColor || '#ffffff';
    c.fillText(txt, 0, 0);
  }
}
