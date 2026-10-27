// BG Studio — background removal engines.
//   'instant' U²-Net-p (4.5MB, vendored at models/u2netp.onnx) straight on
//           onnxruntime-web, 320x320 input. Well under a second even on the CPU,
//           nothing to download but the runtime. Softer edges than the others.
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

// ---------- 'instant' (U²-Net-p) ----------
// The rembg release file (md5 8e83ca70e441ab06c318d82300c84806, Apache-2.0),
// fed the way rembg feeds it: scaled by the brightest channel, then ImageNet
// mean/std. 1.22, not 1.18: 1.18's WebGPU backend never reaches the GPU in
// current Chrome (same requestAdapterInfo problem as imgly 1.5.5 above).
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const INSTANT = {
  url: new URL('./models/u2netp.onnx', import.meta.url).href, size: 320,
  mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225],
};
let instantModel = null;   // promise of { ort, session, gpu }
function loadInstant() {
  if (!instantModel) {
    instantModel = (async () => {
      // The webgpu build carries the WASM backend too. Imported lazily so the
      // editor still boots with no network.
      const ort = await import(ORT_BASE + 'ort.webgpu.min.mjs');
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? (navigator.hardwareConcurrency || 4) : 1;
      const res = await fetch(INSTANT.url);
      if (!res.ok) throw new Error(`${INSTANT.url}: HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (await gpuUsable()) {
        try {
          const session = await ort.InferenceSession.create(buf.slice(0), { executionProviders: ['webgpu'] });
          return { ort, session, gpu: true };
        } catch (err) {
          console.info('U²-Net-p: WebGPU failed, using WASM -', err && err.message);
        }
      }
      const session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
      return { ort, session, gpu: false };
    })();
    instantModel.catch(() => { instantModel = null; });   // allow a retry
  }
  return instantModel;
}

// Alpha-only canvas at the model's resolution; the caller scales it up.
async function instantMask(bmp) {
  const { ort, session } = await loadInstant();
  const S = INSTANT.size, n = S * S;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0, S, S);
  const px = cx.getImageData(0, 0, S, S).data;
  let max = 1;
  for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2]);
  const { mean, std } = INSTANT;
  const input = new Float32Array(3 * n);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    for (let k = 0; k < 3; k++) input[j + k * n] = (px[i + k] / max - mean[k]) / std[k];
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) });
  const pred = out[session.outputNames[0]].data;   // d0: the fused, final side output
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < n; j++) { if (pred[j] < lo) lo = pred[j]; if (pred[j] > hi) hi = pred[j]; }
  const span = hi - lo || 1;
  const mask = cx.createImageData(S, S);
  for (let j = 0; j < n; j++) mask.data[j * 4 + 3] = 255 * (pred[j] - lo) / span;
  cx.putImageData(mask, 0, 0);
  return c;
}

async function removeInstant(src, progress) {
  progress(instantModel ? 'run' : 'init', 0);
  const bmp = await sourceBitmap(src);
  const { gpu } = await loadInstant();
  progress('run', 0);
  const mc = await instantMask(bmp);
  lastRun = { engine: 'instant', gpu, threads: self.crossOriginIsolated };
  return applyMask(bmp, mc);
}

// Scale an alpha-only matte up onto the full-res image with destination-in
// (bilinear upsampling keeps the edge soft) and encode the result.
function applyMask(bmp, mc) {
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
    lastActivity = performance.now();
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
    resetWorker(new Error(e.message || 'background-removal worker failed to start'));
  };
  return worker;
}

// Kill the worker outright: the only way to stop a GPU job that has wedged.
// Rejects everything in flight; the next call spawns a fresh worker (and
// re-loads the model from the browser cache).
function resetWorker(err) {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  if (worker) worker.terminate();
  worker = null; readyPromise = null; backendInfo = null;
}

// Watchdog: if the worker goes this long without a sign of life (a progress
// message or a result), treat it as hung. Download progress keeps it fed, so a
// slow first download isn't mistaken for a hang; model init + a cutout should
// fit well inside this on a GPU. Testing on an RTX 5070 saw WebGPU session
// setup never return, which is what this guards against.
const STALL_MS = 45000;
let lastActivity = 0;
let bestStalled = false;   // once it has hung, don't make every click wait 45s again

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

// Race `work` against the watchdog; on a stall, kill the worker and reject.
function guarded(work) {
  lastActivity = performance.now();
  let timer;
  const stalled = new Promise((_, reject) => {
    timer = setInterval(() => {
      if (performance.now() - lastActivity < STALL_MS) return;
      const err = new Error(`BiRefNet stopped responding for ${STALL_MS / 1000}s`);
      bestStalled = true;
      resetWorker(err); reject(err);
    }, 1000);
  });
  return Promise.race([work, stalled]).finally(() => clearInterval(timer));
}

async function removeBest(src, progress) {
  onProgress = progress;
  const bmp = await sourceBitmap(src);
  const { mask, w, h } = await guarded((async () => {
    await loadBest();
    const forWorker = await createImageBitmap(bmp);
    lastActivity = performance.now();   // the run itself starts the clock afresh
    return call({ type: 'run', bitmap: forWorker }, [forWorker]);
  })());

  // Matte → alpha-only canvas at model res, then scale it up onto the image
  // with destination-in (bilinear upsampling keeps the edge soft).
  const mc = document.createElement('canvas');
  mc.width = w; mc.height = h;
  const mctx = mc.getContext('2d');
  const id = mctx.createImageData(w, h);
  for (let i = 0, j = 3; i < mask.length; i++, j += 4) id.data[j] = mask[i];
  mctx.putImageData(id, 0, 0);
  return applyMask(bmp, mc);
}

// ---------- Public API ----------
export function hasWebGPU() { return !!navigator.gpu; }
// navigator.gpu existing isn't enough: on some setups requestAdapter() returns
// null or requestDevice() throws, and imgly then drops to WASM *silently*.
// Probe once for a real device so we can pick 'cpu' up front and label honestly.
let _gpuProbe = null;
export function gpuUsable() {
  if (!_gpuProbe) {
    _gpuProbe = (async () => {
      if (!navigator.gpu) return false;
      try {
        const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!a) return false;
        const d = await a.requestDevice();
        d.destroy();
        return true;
      } catch { return false; }
    })();
  }
  return _gpuProbe;
}
export function bestBackend() { return backendInfo; }
// What actually ran last: { engine: 'instant'|'best'|'fast', gpu: bool, threads: bool }.
let lastRun = null;
export function lastRunInfo() { return lastRun; }

// progress(phase, pct) with phase 'fetch' | 'init' | 'run'.
// If 'best' can't load (no network to the hub, worker blocked…), falls back to
// 'fast' and reports it through onFallback(err) so the UI can say so.
export async function removeBg(src, { engine = 'fast', progress = () => {}, onFallback } = {}) {
  if (engine === 'instant') return removeInstant(src, progress);
  if (engine === 'best' && bestStalled) {
    if (onFallback) onFallback(new Error('BiRefNet hung earlier this session'));
  } else if (engine === 'best') {
    try {
      const blob = await removeBest(src, progress);
      lastRun = { engine: 'best', gpu: backendInfo && backendInfo.device === 'webgpu', threads: self.crossOriginIsolated };
      return blob;
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
  if (fastDevice === 'gpu' && !(await gpuUsable())) fastDevice = 'cpu';
  const note = () => { lastRun = { engine: 'fast', gpu: fastDevice === 'gpu', threads: self.crossOriginIsolated }; };
  try {
    note();
    return await removeBackground(src, { ...IMGLY_OPTS, device: fastDevice, progress: imglyProgress(progress) });
  } catch (err) {
    if (fastDevice !== 'gpu') throw err;
    console.warn('ISNet on WebGPU failed, retrying on CPU', err);
    fastDevice = 'cpu';
    note();
    return removeBackground(src, { ...IMGLY_OPTS, device: fastDevice, progress: imglyProgress(progress) });
  }
}

export async function warm(engine = 'fast', progress) {
  if (engine === 'instant') return loadInstant();
  if (engine === 'best') { onProgress = progress || null; return loadBest(); }
  if (fastDevice === 'gpu' && !(await gpuUsable())) fastDevice = 'cpu';
  return preload({ ...IMGLY_OPTS, device: fastDevice });
}
