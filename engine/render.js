// ---------- Layer rendering ----------
// Renders one layer to any 2D context. Pure with respect to app state: it reads
// only the layer and writes only the context, which is what lets the same code
// paint the live stage, an export buffer, and an offscreen GIF frame.
//
// Selection handles and other editor chrome deliberately live above this, in the
// caller — so an exported frame can never contain them.
import { drawTextHighlight, measureChars, charFont, sameDraw, lineHeight } from './text.js';
import { vectorPath, isClosedVec } from './vector.js';
import { drawTable } from './table.js';
import { filterString, pixelateCanvas, fxBuffer } from './filters.js';

// An animation modifier, as produced by anim.js computeAnim(). The identity
// value means "draw the layer exactly as authored" — which is what the still
// editor always passes.
export const NO_ANIM = { opacity: 1, offsetX: 0, offsetY: 0, scale: 1, rotation: 0, textClip: 1 };

// `scene` supplies the pixelate buffer size; only needed when a layer uses the
// pixelate filter, which needs a screen-space pass.
export function drawLayer(c, l, anim = NO_ANIM, scene = null) {
  const px = l.filters && l.filters.pixelate;
  if (px >= 2 && scene) {
    // pixelate needs a screen-space pass: render the layer to a buffer, then blockify it
    const buf = fxBuffer(scene.w, scene.h), bc = buf.getContext('2d');
    bc.clearRect(0, 0, buf.width, buf.height);
    drawLayerRaw(bc, l, anim);
    pixelateCanvas(buf, px);
    c.drawImage(buf, 0, 0);
  } else {
    drawLayerRaw(c, l, anim);
  }
}

export function drawLayerRaw(c, l, anim = NO_ANIM) {
  c.save();
  c.globalAlpha = l.opacity * anim.opacity;
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
    c.lineCap = l.cap; c.lineJoin = l.join;
    if (l.dashed && l.strokeW > 0) c.setLineDash([l.strokeW * 2.4, l.strokeW * 1.8]);
    if (isClosedVec(l) && l.fill) { c.fillStyle = l.fill; c.fill(path); }
    if (l.strokeW > 0) { c.strokeStyle = l.stroke; c.lineWidth = l.strokeW; c.stroke(path); }
  }
  c.restore();
}
