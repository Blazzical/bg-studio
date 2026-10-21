// BG Studio — background removal engines.
//   'best'  BiRefNet-lite in a worker (bg-worker.js), WebGPU when available.
//           ~115MB (fp16) / ~224MB (fp32) first download, much cleaner edges.
//   'fast'  @imgly/background-removal (ISNet, ~40MB), now with device:'gpu' so
//           it uses WebGPU too (falls back to WASM on its own when it can't).
// Both resolve to a transparent PNG Blob the same size as the source.
// 1.7.0, not 1.5.5: 1.5.5 bundles onnxruntime-web 1.18, whose WebGPU backend
// calls adapter.requestAdapterInfo() — gone from current Chrome — so it never
// actually ran on the GPU. publicPath is spelled out because the esm.sh build
// doesn't resolve the package's own default.
const IMGLY_VERSION = '1.7.0';
import { removeBackground, preload } from 'https://esm.sh/@imgly/background-removal@1.7.0';

const IMGLY_OPTS = {
  device: 'gpu', model: 'isnet_fp16', output: { format: 'image/png' },
  publicPath: `https://staticimgly.com/@imgly/background-removal-data/${IMGLY_VERSION}/dist/`,
};

// ---------- 'fast' (imgly) ----------
function imglyProgress(progress) {
  return (key, current, total) => {
    const pct = total ? Math.round((current / total) * 100) : 0;
    progress(key.startsWith('fetch') ? 'fetch' : 'run', pct);
  };
}

// ---------- 'best' (BiRefNet worker) ----------
let worker = null;
let nextId = 1;
const pending = new Map();   // id → { resolve, reject }
let onProgress = null;       // progress sink for whichever call is current
let readyPromise = null;
let backendInfo = null;      // { device, dtype } once the worker has loaded

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./bg-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') { if (onProgress) onProgress(m.phase, m.pct); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  };
  worker.onerror = (e) => {
    // A failed module import lands here, not in onmessage — fail everything
    // in flight and drop the worker so the next call starts clean.
    const err = new Error(e.message || 'background-removal worker failed to start');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker.terminate();
    worker = null; readyPromise = null;
  };
  return worker;
}

function call(msg, transfer) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer || []);
  });
}

function loadBest() {
  if (!readyPromise) {
    readyPromise = call({ type: 'load' })
      .then((m) => { backendInfo = { device: m.device, dtype: m.dtype }; return backendInfo; })
      .catch((err) => { readyPromise = null; throw err; });
  }
  return readyPromise;
}

async function sourceBitmap(src) {
  const blob = src instanceof Blob ? src : await (await fetch(src)).blob();
  return createImageBitmap(blob);
}

async function removeBest(src, progress) {
  onProgress = progress;
  await loadBest();
  const bmp = await sourceBitmap(src);
  const forWorker = await createImageBitmap(bmp);
  const { mask, w, h } = await call({ type: 'run', bitmap: forWorker }, [forWorker]);

  // Matte → alpha-only canvas at model res, then scale it up onto the image
  // with destination-in (bilinear upsampling keeps the edge soft).
  const mc = document.createElement('canvas');
  mc.width = w; mc.height = h;
  const mctx = mc.getContext('2d');
  const id = mctx.createImageData(w, h);
  for (let i = 0, j = 3; i < mask.length; i++, j += 4) id.data[j] = mask[i];
  mctx.putImageData(id, 0, 0);

  const out = document.createElement('canvas');
  out.width = bmp.width; out.height = bmp.height;
  const octx = out.getContext('2d');
  octx.drawImage(bmp, 0, 0);
  octx.globalCompositeOperation = 'destination-in';
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(mc, 0, 0, out.width, out.height);
  bmp.close();
  return new Promise((res) => out.toBlob(res, 'image/png'));
}

// ---------- Public API ----------
export function hasWebGPU() { return !!navigator.gpu; }
export function bestBackend() { return backendInfo; }

// progress(phase, pct) with phase 'fetch' | 'init' | 'run'.
// If 'best' can't load (no network to the hub, worker blocked…), falls back to
// 'fast' and reports it through onFallback(err) so the UI can say so.
export async function removeBg(src, { engine = 'best', progress = () => {}, onFallback } = {}) {
  if (engine === 'best') {
    try {
      return await removeBest(src, progress);
    } catch (err) {
      console.error('BiRefNet failed, falling back to ISNet', err);
      if (onFallback) onFallback(err);
    }
  }
  return removeFast(src, progress);
}

// imgly only falls back to WASM when navigator.gpu is missing, not when the
// GPU device fails to start — so catch that and rerun on the CPU, then stay there.
let fastDevice = IMGLY_OPTS.device;
async function removeFast(src, progress) {
  try {
    return await removeBackground(src, { ...IMGLY_OPTS, device: fastDevice, progress: imglyProgress(progress) });
  } catch (err) {
    if (fastDevice !== 'gpu') throw err;
    console.warn('ISNet on WebGPU failed, retrying on CPU', err);
    fastDevice = 'cpu';
    return removeBackground(src, { ...IMGLY_OPTS, device: fastDevice, progress: imglyProgress(progress) });
  }
}

export function warm(engine = 'best', progress) {
  if (engine === 'best') { onProgress = progress || null; return loadBest(); }
  return preload({ ...IMGLY_OPTS, device: fastDevice });
}
