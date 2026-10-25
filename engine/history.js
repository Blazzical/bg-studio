// ---------- Meme history ----------
// Every Copy autosaves into a rolling ring in IndexedDB ('bgstudio' → 'memes',
// tagged type:'history' — the same store the editor's templates and stickers
// use). The editor, Graphs and Combiner all write through here, and the
// editor's Meme library → History tab reads it back.
//
// A record is { name, type: 'history', key, at, scene, thumb }, where scene is
// the shape the editor's loadTemplate() expects. Pages that aren't the editor
// save their PNG as the scene's background, so restoring one in the editor
// lands it on the canvas ready for meme text.
//
// Only unique scenes are kept: re-copying the same scene bumps it to newest
// rather than duplicating it. The ring size is the user's call (History tab →
// "Keep last"), stored in localStorage; 100 by default.

export const HISTORY_LS = 'bgstudio_historyMax';
export const clampHistoryMax = n => Math.max(1, Math.min(1000, Math.round(+n) || 100));

export function historyMax() {
  try { return clampHistoryMax(JSON.parse(localStorage.getItem(HISTORY_LS))); }
  catch { return 100; }
}

let _db = null;
function db() {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const r = indexedDB.open('bgstudio', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('memes', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return _db;
}
function op(mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const req = fn(d.transaction('memes', mode).objectStore('memes'));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
}
const allHistory = async () => (await op('readonly', s => s.getAll())).filter(r => r.type === 'history');

// Cheap content fingerprint (djb2 over the serialised scene) — enough to spot
// "this is byte-for-byte the meme I already have".
function sceneKey(scene) {
  const s = JSON.stringify(scene);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return s.length + ':' + h.toString(36);
}

// Drop the oldest entries beyond the cap. Returns how many went.
export async function trimHistory(max = historyMax()) {
  const hist = (await allHistory()).sort((a, b) => (a.at || 0) - (b.at || 0));
  const drop = Math.max(0, hist.length - max);
  for (let i = 0; i < drop; i++) {
    try { await op('readwrite', s => s.delete(hist[i].id)); } catch { /* ignore */ }
  }
  return drop;
}

export async function addHistory({ name, scene, thumb }) {
  const key = sceneKey(scene);
  for (const r of await allHistory()) {
    if (r.key === key) { try { await op('readwrite', s => s.delete(r.id)); } catch { /* ignore */ } }
  }
  await op('readwrite', s => s.add({ name, type: 'history', key, at: Date.now(), scene, thumb }));
  await trimHistory();
}

// Scale a canvas down to a ≤320px thumbnail data URL.
export function thumbOf(src) {
  const s = Math.min(1, 320 / Math.max(src.width, src.height));
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(src.width * s));
  t.height = Math.max(1, Math.round(src.height * s));
  t.getContext('2d').drawImage(src, 0, 0, t.width, t.height);
  return t.toDataURL('image/png');
}

// Save a finished image (a graph, a combined strip) as a background-only scene.
// Transparent, so the PNG's own background — or lack of one — survives as is.
export function addImageHistory(canvas, name) {
  return addHistory({
    name,
    scene: { w: canvas.width, h: canvas.height, fill: '#ffffff', transparent: true, filters: {},
      bg: canvas.toDataURL('image/png'), layers: [] },
    thumb: thumbOf(canvas),
  });
}
