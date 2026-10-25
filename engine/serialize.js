// ---------- Layer serialization ----------
// The wire format for a layer, shared by meme templates, saved bits, and the
// GIF editor's documents — so a bit saved in one editor drops into the other.
//
// Runtime refs (img/work/baseImg) and `_`-prefixed measurement caches are
// dropped; an image layer's pixels are carried as a PNG data URL instead.
import { loadImage, makeWork } from './image.js';
import { measureText } from './text.js';

export function serializeLayer(l) {
  const o = {};
  for (const k in l) {
    if (k === 'img' || k === 'work' || k === 'baseImg') continue;  // runtime canvas/image refs
    if (k[0] === '_') continue;                                     // cached text measurements
    o[k] = l[k];
  }
  if (l.type === 'image') o.src = (l.work || l.img).toDataURL('image/png');  // may throw if tainted
  return o;
}

// `uid` is injected because the id counter belongs to whichever document is
// receiving the layer, not to the serializer.
export async function deserializeLayer(o, uid) {
  const l = structuredClone(o);
  delete l.src;
  l.id = uid();
  if (o.type === 'image') {
    const img = await loadImage(o.src);
    l.work = makeWork(img); l.img = l.work; l.baseImg = img;
  } else if (o.type === 'text') {
    // Migrate legacy text layers to autoFit: transfer their rendered box
    // (w*scale × h*scale) into the box dimensions and reset scale, so the
    // wrap-and-fit engine picks a font size that fills the same area.
    if (l.autoFit === undefined) {
      l.autoFit = true;
      const s = l.scale || 1;
      l.w = Math.max(30, (l.w || 40) * s);
      l.h = Math.max(20, (l.h || 40) * s);
      l.scale = 1;
    }
    measureText(l);
  }
  return l;
}
