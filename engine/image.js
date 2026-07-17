// ---------- Image helpers ----------

export function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = async () => {
      // Firefox can fire onload before the bitmap is rasterised; force a decode so
      // the very first drawImage isn't blank.
      try { if (img.decode) await img.decode(); } catch { /* ignore */ }
      res(img);
    };
    img.onerror = rej;
    img.src = src;
  });
}

// An image layer's editable pixel buffer. Brush paint/erase mutates this rather
// than the original, so the original stays available to restore from.
export function makeWork(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}
