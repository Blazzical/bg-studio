// Encoding runs here so a long export doesn't freeze the editor. Frames arrive
// one at a time with their pixel buffers transferred (not copied), so the main
// thread never holds more than the frame it is currently rendering.
import { GifEncoder } from './gif-encoder.js';

let enc = null, total = 0, done = 0;

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'begin') {
      enc = new GifEncoder(m.w, m.h, { loop: m.loop, alphaThreshold: m.alphaThreshold });
      total = m.total; done = 0;
    } else if (m.type === 'frame') {
      enc.addFrame(new Uint8Array(m.buf), m.delay);
      done++;
      self.postMessage({ type: 'progress', done, total });
    } else if (m.type === 'finish') {
      const bytes = enc.finish();
      enc = null;
      self.postMessage({ type: 'done', buf: bytes.buffer }, [bytes.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
