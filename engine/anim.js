// ---------- Timed-layer animation ----------
// Ported from the DetritaDev video editor (server/templates/video.html), which
// worked out the useful set of entry/exit motions. The maths is theirs; the
// units are not — three things had to change to fit this renderer:
//
//   offsets   there: fractions of the comp size (-0.4 = 40% of width)
//             here:  canvas pixels, so computeAnim takes the scene dimensions
//   rotation  there: degrees        here: radians (matches l.rotation)
//   scale     there: seeded from the layer's own scale, i.e. an absolute
//             here:  a multiplier starting at 1 — drawLayerRaw already applies
//                    l.scale per type, so seeding it would apply it twice
//
// Everything returned is therefore a delta (offsetX/offsetY/rotation) or a
// multiplier (opacity/scale), composed on top of the layer as authored. The
// identity value is render.js's NO_ANIM.

export const EASINGS = {
  linear:    t => t,
  easeIn:    t => t * t,
  easeOut:   t => t * (2 - t),
  easeInOut: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  easeInCubic:  t => t * t * t,
  easeOutCubic: t => (--t) * t * t + 1,
  easeInOutCubic: t => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
  backIn:    t => t * t * (2.7 * t - 1.7),
  backOut:   t => { t--; return t * t * (2.7 * t + 1.7) + 1; },
  elasticOut: t => t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t - 0.075) * 2 * Math.PI / 0.3) + 1,
  bounceOut: t => {
    if (t < 1 / 2.75) return 7.5625 * t * t;
    if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
    if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
    return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
  },
};

// The motions an entry/exit can use, for building UI menus.
export const ANIM_TYPES = ['none', 'fade', 'slideLeft', 'slideRight', 'slideUp', 'slideDown', 'zoom', 'zoomRotate', 'typewriter', 'pop', 'drop'];

const ease = name => EASINGS[name] || EASINGS.linear;   // unknown/missing name must not throw

const DEG = Math.PI / 180;

// `progress` runs 0 (fully out) -> 1 (fully in) for both entry and exit; an exit
// is just the same curve walked backwards, so exits reuse the entry motions.
// sw/sh are the scene dimensions, used to turn fractional slides into pixels.
// `fadeDir` ('left' | 'right' | 'top' | 'bottom', or empty for an even fade) turns
// a fade into a soft-edged sweep: render.js masks the layer with r.wipe. An exit
// walks the same sweep backwards, so an exit "from left" vanishes toward the left.
function applyAnimType(type, progress, r, isExit, sw, sh, fadeDir) {
  switch (type) {
    case 'fade':
      if (fadeDir) r.wipe = { dir: fadeDir, p: progress };
      else r.opacity *= progress;
      break;
    case 'slideLeft':  r.offsetX += (1 - progress) * -0.4 * sw; break;
    case 'slideRight': r.offsetX += (1 - progress) * 0.4 * sw; break;
    case 'slideUp':    r.offsetY += (1 - progress) * -0.3 * sh; break;
    case 'slideDown':  r.offsetY += (1 - progress) * 0.3 * sh; break;
    case 'zoom': r.scale *= progress; r.opacity *= progress; break;
    case 'zoomRotate':
      r.scale *= progress;
      r.rotation += (1 - progress) * (isExit ? -15 : 15) * DEG;
      r.opacity *= progress;
      break;
    case 'typewriter': r.textClip = Math.min(r.textClip, progress); break;
    case 'pop': {
      // overshoot to 1.15x at 60% then settle back to 1
      const p = progress < 0.6 ? (progress / 0.6) * 1.15 : 1.15 - (progress - 0.6) / 0.4 * 0.15;
      r.scale *= Math.max(0.01, p);
      r.opacity *= Math.min(1, progress * 3);
      break;
    }
    case 'drop': {
      const b = EASINGS.bounceOut(progress);
      r.offsetY += (1 - b) * -0.3 * sh;
      r.opacity *= Math.min(1, progress * 4);
      break;
    }
  }
}

// Evaluate a timed layer's animation at absolute scene time `t` (ms).
// A layer with no animation fields configured returns the identity.
export function computeAnim(l, t, sw, sh) {
  const r = { opacity: 1, offsetX: 0, offsetY: 0, scale: 1, rotation: 0, textClip: 1, wipe: null };
  const dur = l.timeOut - l.timeIn;
  const localT = t - l.timeIn;
  const exitT = l.timeOut - t;

  if (l.entryType && l.entryType !== 'none' && l.entryDuration > 0 && localT < l.entryDuration) {
    const raw = Math.max(0, Math.min(1, localT / l.entryDuration));
    applyAnimType(l.entryType, ease(l.entryEasing)(raw), r, false, sw, sh, l.entryFadeDir);
  }
  if (l.exitType && l.exitType !== 'none' && l.exitDuration > 0 && exitT < l.exitDuration) {
    const raw = Math.max(0, Math.min(1, exitT / l.exitDuration));
    applyAnimType(l.exitType, ease(l.exitEasing)(raw), r, true, sw, sh, l.exitFadeDir);
  }
  if (l.scaleAnimOn && dur > 0) {
    const raw = Math.max(0, Math.min(1, localT / dur));
    const p = ease(l.scaleEasing)(raw);
    r.scale *= l.scaleFrom + (l.scaleTo - l.scaleFrom) * p;
  }
  // Reveal keyframes, if present, are authoritative over any typewriter entry.
  // [{time (ms from timeIn), clip (0..1 of characters shown)}], sorted by time.
  const kfs = l.revealKeyframes;
  if (kfs && kfs.length) {
    if (localT <= kfs[0].time) r.textClip = kfs[0].clip;
    else if (localT >= kfs[kfs.length - 1].time) r.textClip = kfs[kfs.length - 1].clip;
    else {
      for (let k = 0; k < kfs.length - 1; k++) {
        if (localT >= kfs[k].time && localT < kfs[k + 1].time) {
          const segT = (localT - kfs[k].time) / (kfs[k + 1].time - kfs[k].time);
          r.textClip = kfs[k].clip + (kfs[k + 1].clip - kfs[k].clip) * segT;
          break;
        }
      }
    }
  }
  return r;
}
