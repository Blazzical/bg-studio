// ---------- GIF89a encoder ----------
// Streaming: frames are fed in one at a time and compressed immediately, so the
// only pixels in memory are the current frame's. (The DetritaDev encoder this
// grew out of buffered every frame's ImageData up front — ~2.4GB for 10s of
// 1080p, which is why it fell over on anything real.)
//
// Runs in a worker; nothing here touches the DOM.

// A growable byte sink. GIF is a byte-at-a-time format, and pushing onto a
// plain Array boxes every byte.
class ByteWriter {
  constructor() { this.buf = new Uint8Array(1 << 16); this.len = 0; }
  _room(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + n) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  byte(v) { this._room(1); this.buf[this.len++] = v & 0xff; }
  bytes(a) { this._room(a.length); this.buf.set(a, this.len); this.len += a.length; }
  le16(v) { this.byte(v); this.byte(v >> 8); }
  str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  take() { return this.buf.slice(0, this.len); }
}

// ---------- Quantization ----------
// Median cut over a 15-bit (5:5:5) histogram.
//
// The useful property: median cut partitions colour space into boxes, and every
// populated bin lands in exactly one box. So the bin -> palette-index lookup
// falls out of the split for free, and mapping a pixel is one array read. The
// naive approach — nearest-colour searched per pixel against 256 entries — is
// what made the original encoder O(pixels x 256).
const BINS = 1 << 15;
const binOf = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

export function quantize(rgba, maxColors, alphaThreshold) {
  const count = new Uint32Array(BINS);
  const sumR = new Uint32Array(BINS), sumG = new Uint32Array(BINS), sumB = new Uint32Array(BINS);
  let anyTransparent = false;

  for (let i = 0; i < rgba.length; i += 4) {
    if (alphaThreshold != null && rgba[i + 3] < alphaThreshold) { anyTransparent = true; continue; }
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const k = binOf(r, g, b);
    count[k]++; sumR[k] += r; sumG[k] += g; sumB[k] += b;
  }

  const used = [];
  for (let k = 0; k < BINS; k++) if (count[k]) used.push(k);

  // One slot is spent on transparency when the frame needs it.
  const budget = anyTransparent ? maxColors - 1 : maxColors;

  // Fewer distinct colours than the budget: every bin becomes its own entry and
  // the image is reproduced exactly (to 5-bit precision). Handing this case to
  // medianCut would be wrong as well as pointless — it stops splitting once it
  // runs out of boxes worth splitting, leaving colours merged that didn't have
  // to be.
  const boxes = used.length > budget
    ? medianCut(used, budget, count, sumR, sumG, sumB)
    : used.map(k => makeBox([k], count, sumR, sumG, sumB));

  const palette = [];
  const lut = new Uint8Array(BINS);
  boxes.forEach((box, idx) => {
    let n = 0, r = 0, g = 0, b = 0;
    for (const k of box.bins) { n += count[k]; r += sumR[k]; g += sumG[k]; b += sumB[k]; }
    palette.push(n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0]);
    for (const k of box.bins) lut[k] = idx;
  });

  return { palette, lut, anyTransparent };
}

function medianCut(used, budget, count, sumR, sumG, sumB) {
  // Boxes hold their own bin list; splitting sorts along the widest channel and
  // cuts at the population median, so dense regions get more palette entries.
  let boxes = [makeBox(used, count, sumR, sumG, sumB)];
  while (boxes.length < budget) {
    // Split the box with the greatest population * volume — plain population
    // over-splits big flat areas, plain volume over-splits noise.
    let bi = -1, best = 0;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.bins.length < 2) continue;
      const score = bx.pop * bx.vol;
      if (score > best) { best = score; bi = i; }
    }
    if (bi < 0) break;
    const [a, b] = splitBox(boxes[bi], count, sumR, sumG, sumB);
    if (!a || !b) break;
    boxes.splice(bi, 1, a, b);
  }
  return boxes;
}

function makeBox(bins, count, sumR, sumG, sumB) {
  let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0, pop = 0;
  for (const k of bins) {
    const n = count[k];
    const r = sumR[k] / n, g = sumG[k] / n, b = sumB[k] / n;
    if (r < rmin) rmin = r; if (r > rmax) rmax = r;
    if (g < gmin) gmin = g; if (g > gmax) gmax = g;
    if (b < bmin) bmin = b; if (b > bmax) bmax = b;
    pop += n;
  }
  const dr = rmax - rmin, dg = gmax - gmin, db = bmax - bmin;
  return { bins, pop, vol: (dr + 1) * (dg + 1) * (db + 1), dr, dg, db };
}

function splitBox(box, count, sumR, sumG, sumB) {
  // Widest channel wins, weighted the way the eye sees them.
  const ch = (box.dr * 1.0 >= box.dg * 0.8 && box.dr * 1.0 >= box.db * 0.6) ? 0
           : (box.dg * 0.8 >= box.db * 0.6) ? 1 : 2;
  const sum = ch === 0 ? sumR : ch === 1 ? sumG : sumB;
  const bins = box.bins.slice().sort((x, y) => (sum[x] / count[x]) - (sum[y] / count[y]));
  const half = box.pop / 2;
  let acc = 0, cut = 0;
  for (let i = 0; i < bins.length; i++) {
    acc += count[bins[i]];
    if (acc >= half) { cut = i + 1; break; }
  }
  if (cut <= 0 || cut >= bins.length) cut = Math.max(1, Math.min(bins.length - 1, bins.length >> 1));
  const a = bins.slice(0, cut), b = bins.slice(cut);
  if (!a.length || !b.length) return [null, null];
  return [makeBox(a, count, sumR, sumG, sumB), makeBox(b, count, sumR, sumG, sumB)];
}

// ---------- LZW ----------
// Keyed on (prefixCode << 8) | byte rather than a "12,7,3"-style string. Same
// algorithm, but it doesn't allocate a string per pixel.
export function lzwEncode(indexed, minCode) {
  const clearCode = 1 << minCode;
  const eoiCode = clearCode + 1;
  let codeSize = minCode + 1;
  let next = eoiCode + 1;
  const table = new Map();
  const out = [];
  let bits = 0, nbits = 0;
  const emit = (code) => {
    bits |= code << nbits; nbits += codeSize;
    while (nbits >= 8) { out.push(bits & 0xff); bits >>>= 8; nbits -= 8; }
  };
  emit(clearCode);
  if (!indexed.length) { emit(eoiCode); if (nbits > 0) out.push(bits & 0xff); return out; }
  let cur = indexed[0];
  for (let i = 1; i < indexed.length; i++) {
    const k = indexed[i];
    const key = (cur << 8) | k;
    const found = table.get(key);
    if (found !== undefined) { cur = found; continue; }
    emit(cur);
    if (next < 4096) {
      table.set(key, next++);
      // `>` — not `===` — and that is the whole ballgame.
      //
      // The decoder lags us by exactly one code: we assign a code as we emit,
      // but it can only add that code once it has read the *following* one. So
      // when we have just assigned 511 (next === 512) the decoder's table still
      // holds 510, and it won't widen to 10 bits until one code later. Bumping
      // at `next === (1 << codeSize)` therefore writes every subsequent code one
      // bit wider than the decoder reads it, and the stream desyncs at code 512
      // — fine for small images, garbage for anything with real detail.
      // Waiting one more assignment puts both sides on the same boundary.
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clearCode);
      table.clear();
      next = eoiCode + 1;
      codeSize = minCode + 1;
    }
    cur = k;
  }
  emit(cur);
  emit(eoiCode);
  if (nbits > 0) out.push(bits & 0xff);
  return out;
}

// ---------- Encoder ----------
export class GifEncoder {
  // loop: 0 = forever, n = n extra times. alphaThreshold null = fully opaque.
  constructor(w, h, { loop = 0, alphaThreshold = null } = {}) {
    this.w = w; this.h = h;
    this.loop = loop;
    this.alphaThreshold = alphaThreshold;
    this.out = new ByteWriter();
    this._header();
  }

  _header() {
    const o = this.out;
    o.str('GIF89a');
    o.le16(this.w); o.le16(this.h);
    // No global colour table — every frame carries its own, so a frame whose
    // palette shifts (a fade, a scene change) doesn't get forced through a
    // palette chosen for some other frame.
    o.byte(0x70);   // colour resolution 8 bits, no GCT
    o.byte(0);      // background colour index
    o.byte(0);      // pixel aspect ratio
    // NETSCAPE2.0 application extension = the loop count.
    o.byte(0x21); o.byte(0xff); o.byte(0x0b);
    o.str('NETSCAPE2.0');
    o.byte(3); o.byte(1); o.le16(this.loop); o.byte(0);
  }

  // rgba: Uint8ClampedArray/Uint8Array of w*h*4. delayMs is this frame's delay.
  addFrame(rgba, delayMs) {
    const { palette, lut, anyTransparent } = quantize(rgba, 256, this.alphaThreshold);
    const transIdx = anyTransparent ? palette.length : -1;
    if (anyTransparent) palette.push([0, 0, 0]);

    const n = this.w * this.h;
    const indexed = new Uint8Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      if (transIdx >= 0 && rgba[i + 3] < this.alphaThreshold) { indexed[p] = transIdx; continue; }
      indexed[p] = lut[binOf(rgba[i], rgba[i + 1], rgba[i + 2])];
    }

    const o = this.out;
    // Graphic control extension: delay + transparency.
    // GIF delays are centiseconds. Sub-10ms delays can't be expressed, and most
    // decoders silently rewrite 0 and 1 to 10 — so clamp to 2cs and say so
    // rather than letting a "20ms" frame play back at some other speed.
    const cs = Math.max(2, Math.round(delayMs / 10));
    // Disposal 2 (restore to background) only matters when frames can be
    // see-through; otherwise each frame fully paints over the last.
    const disposal = transIdx >= 0 ? 2 : 1;
    o.byte(0x21); o.byte(0xf9); o.byte(4);
    o.byte((disposal << 2) | (transIdx >= 0 ? 1 : 0));
    o.le16(cs);
    o.byte(transIdx >= 0 ? transIdx : 0);
    o.byte(0);

    // Image descriptor + local colour table.
    o.byte(0x2c);
    o.le16(0); o.le16(0);
    o.le16(this.w); o.le16(this.h);
    const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))));
    const tableSize = 1 << bits;
    o.byte(0x80 | (bits - 1));   // local colour table, size 2^bits
    for (let i = 0; i < tableSize; i++) {
      const c = palette[i] || [0, 0, 0];
      o.byte(c[0]); o.byte(c[1]); o.byte(c[2]);
    }

    // LZW min code size must be >= 2 even for tiny palettes.
    const minCode = Math.max(2, bits);
    const data = lzwEncode(indexed, minCode);
    o.byte(minCode);
    for (let pos = 0; pos < data.length;) {
      const chunk = Math.min(255, data.length - pos);
      o.byte(chunk);
      for (let i = 0; i < chunk; i++) o.byte(data[pos++]);
    }
    o.byte(0);   // block terminator
  }

  finish() {
    this.out.byte(0x3b);   // trailer
    return this.out.take();
  }
}
