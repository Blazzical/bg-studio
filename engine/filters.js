// ---------- Filters ----------
// A filters object (on a layer, or state.filters for the whole image) maps
// CSS-filter params to values. Most map straight to ctx.filter; `pixelate` is
// done separately (down/up-scale) since CSS filters can't do it.

export function filterString(f) {
  if (!f) return 'none';
  const p = [];
  if (f.brightness != null && f.brightness !== 100) p.push(`brightness(${f.brightness}%)`);
  if (f.contrast != null && f.contrast !== 100) p.push(`contrast(${f.contrast}%)`);
  if (f.saturate != null && f.saturate !== 100) p.push(`saturate(${f.saturate}%)`);
  if (f.grayscale) p.push(`grayscale(${f.grayscale}%)`);
  if (f.sepia) p.push(`sepia(${f.sepia}%)`);
  if (f.invert) p.push(`invert(${f.invert}%)`);
  if (f.hue) p.push(`hue-rotate(${f.hue}deg)`);
  if (f.blur) p.push(`blur(${f.blur}px)`);
  if (f.shadow) {
    const o = Math.round(f.shadow * 0.5);
    p.push(`drop-shadow(${o}px ${o}px ${f.shadow}px ${f.shadowColor || '#000000'})`);
  }
  return p.length ? p.join(' ') : 'none';
}
// Blocky pixelation, in place: shrink to 1/block then scale back up un-smoothed.
export function pixelateCanvas(cv, block) {
  const w = cv.width, h = cv.height;
  const sw = Math.max(1, Math.round(w / block)), sh = Math.max(1, Math.round(h / block));
  const tmp = document.createElement('canvas'); tmp.width = sw; tmp.height = sh;
  const tc = tmp.getContext('2d'); tc.imageSmoothingEnabled = false;
  tc.drawImage(cv, 0, 0, w, h, 0, 0, sw, sh);
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.clearRect(0, 0, w, h);
  c.drawImage(tmp, 0, 0, sw, sh, 0, 0, w, h);
  c.imageSmoothingEnabled = true;
}
// Reused scratch buffer for per-layer pixelation. Sized by the caller's scene
// (it used to read the editor's global state, which an offscreen frame render
// has no access to).
let _fxBuf = null;
export function fxBuffer(w, h) {
  if (!_fxBuf) _fxBuf = document.createElement('canvas');
  if (_fxBuf.width !== w || _fxBuf.height !== h) { _fxBuf.width = w; _fxBuf.height = h; }
  return _fxBuf;
}
