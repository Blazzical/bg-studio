// BG Studio — high-quality background removal worker.
// Runs BiRefNet-lite (MIT, onnx-community/BiRefNet_lite-ONNX) through
// transformers.js, on WebGPU when the browser has it. Kept off the main thread
// so the page stays responsive while the model loads and runs.
//
// Protocol (main → worker):
//   { type: 'load' }                        load the model (and report progress)
//   { type: 'run', id, bitmap }             segment an ImageBitmap (transferred)
// Worker → main:
//   { type: 'progress', phase, pct }        phase: 'fetch' | 'init' | 'run'
//   { type: 'ready', device, dtype }
//   { type: 'mask', id, mask, w, h }        Uint8Array alpha matte, w×h (model res)
//   { type: 'error', id?, message }
import { AutoModel, AutoProcessor, RawImage, env } from
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/dist/transformers.min.js';

const MODEL_ID = 'onnx-community/BiRefNet_lite-ONNX';
const SIZE = 1024;           // the model's native input resolution
env.allowLocalModels = false;  // always fetch from the HF hub (cached by the browser)

let loading = null;          // in-flight/settled load promise → { model, processor, device, dtype }

async function pickBackend() {
  if (!self.navigator.gpu) return { device: 'wasm', dtype: 'fp32' };
  try {
    const adapter = await self.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { device: 'wasm', dtype: 'fp32' };
    // fp16 halves the download (115MB vs 224MB) and runs faster, but needs
    // shader-f16. Without it fp32 still runs fine on the GPU.
    return { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'fp16' : 'fp32' };
  } catch {
    return { device: 'wasm', dtype: 'fp32' };
  }
}

async function loadModel(backend) {
  const files = new Map();   // per-file download progress, folded into one %
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, [p.loaded, p.total]);
      let l = 0, t = 0;
      for (const [a, b] of files.values()) { l += a; t += b; }
      self.postMessage({ type: 'progress', phase: 'fetch', pct: Math.round(l / t * 100) });
    } else if (p.status === 'done') {
      self.postMessage({ type: 'progress', phase: 'init', pct: 100 });
    }
  };
  const [model, processor] = await Promise.all([
    AutoModel.from_pretrained(MODEL_ID, { device: backend.device, dtype: backend.dtype, progress_callback }),
    AutoProcessor.from_pretrained(MODEL_ID),
  ]);
  return { model, processor, ...backend };
}

// navigator.gpu existing doesn't mean a device can be created (driver
// blocklists, missing DXC libs…) — if WebGPU fails to start, retry on WASM.
async function loadWithFallback() {
  const backend = await pickBackend();
  try {
    return await loadModel(backend);
  } catch (err) {
    if (backend.device !== 'webgpu') throw err;
    console.warn('WebGPU failed to start, using WASM', err);
    return loadModel({ device: 'wasm', dtype: 'fp32' });
  }
}

function ensureLoaded() {
  if (!loading) {
    loading = loadWithFallback().catch((err) => { loading = null; throw err; });
  }
  return loading;
}

// Run the model on a SIZE×SIZE RGB image; returns the uint8 matte.
async function infer(m, image) {
  const { pixel_values } = await m.processor(image);
  const { output_image } = await m.model({ input_image: pixel_values });
  const t = output_image[0].sigmoid().mul(255).to('uint8');
  return { data: t.data, w: t.dims[t.dims.length - 1], h: t.dims[t.dims.length - 2] };
}

// An fp16 overflow shows up as NaN → an all-zero (fully transparent) matte.
// Treat a matte with nothing above ~6% opacity as that failure.
function looksBroken(data) {
  for (let i = 0; i < data.length; i++) if (data[i] > 16) return false;
  return true;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      const m = await ensureLoaded();
      self.postMessage({ type: 'ready', device: m.device, dtype: m.dtype });
      return;
    }
    if (msg.type === 'run') {
      let m = await ensureLoaded();
      self.postMessage({ type: 'progress', phase: 'run', pct: 0 });
      const oc = new OffscreenCanvas(SIZE, SIZE);
      const octx = oc.getContext('2d');
      octx.drawImage(msg.bitmap, 0, 0, SIZE, SIZE);
      msg.bitmap.close();
      const rgba = octx.getImageData(0, 0, SIZE, SIZE).data;
      const image = new RawImage(rgba, SIZE, SIZE, 4).rgb();
      let out = await infer(m, image);
      if (m.dtype === 'fp16' && looksBroken(out.data)) {
        // Fall back to the fp32 weights once and stay there for the session.
        loading = loadModel({ device: m.device, dtype: 'fp32' }).catch((err) => { loading = null; throw err; });
        m = await loading;
        out = await infer(m, image);
      }
      self.postMessage({ type: 'mask', id: msg.id, mask: out.data, w: out.w, h: out.h }, [out.data.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: (err && err.message) || String(err) });
  }
};
