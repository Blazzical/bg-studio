// A detached 2D context used purely for measurement and hit-testing.
//
// Text width measuring and vector hit tests need *a* context, not *the* visible
// one. Borrowing the stage's context (as this code used to) meant every
// measureText run did a save/restore on the live surface, and it silently tied
// the text engine to a canvas that happens to be on screen — which the GIF
// editor's offscreen frame renderer doesn't have. Font metrics and Path2D hit
// tests are document-level, so a detached canvas gives identical results.
let _c = null;
export function scratchCtx() {
  if (!_c) _c = document.createElement('canvas').getContext('2d');
  return _c;
}
