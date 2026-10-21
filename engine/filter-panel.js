// ---------- Filter panel UI ----------
// The preset buttons + sliders that edit a filters object (see filterString in
// ./filters.js). Shared by the editor (per-layer and whole-image) and the
// combiner (per-panel).

export const FILTER_PRESETS = [
  ['None', {}],
  ['B&W', { grayscale: 100 }],
  ['Sepia', { sepia: 100 }],
  ['Invert', { invert: 100 }],
  ['Deep fry', { saturate: 400, contrast: 200, brightness: 115, hue: 8 }],
];
export const FILTER_SLIDERS = [
  ['brightness', 'Brightness', 0, 300, 100, '%'],
  ['contrast', 'Contrast', 0, 300, 100, '%'],
  ['saturate', 'Saturation', 0, 400, 100, '%'],
  ['hue', 'Hue', 0, 360, 0, '°'],
  ['blur', 'Blur', 0, 40, 0, 'px'],
  ['pixelate', 'Pixelate', 0, 40, 0, 'px'],
  ['shadow', 'Drop shadow', 0, 40, 0, 'px'],
];
// Build a set of filter controls into `container`. getTarget() returns the
// filters object to mutate (layer.filters or state.filters); onChange() redraws.
export function makeFilterPanel(container, getTarget, onChange) {
  const presetRow = document.createElement('div');
  presetRow.className = 'btn-grid btn-grid-3';
  FILTER_PRESETS.forEach(([name, vals]) => {
    const b = document.createElement('button');
    b.className = 'ghost small'; b.textContent = name;
    b.addEventListener('click', () => {
      const t = getTarget();
      for (const k in t) delete t[k];
      Object.assign(t, vals);
      sync(); onChange();
    });
    presetRow.appendChild(b);
  });
  container.appendChild(presetRow);

  const inputs = {}, vals = {};
  FILTER_SLIDERS.forEach(([key, label, min, max, def, unit]) => {
    const lab = document.createElement('label');
    const name = document.createElement('span'); name.textContent = label + ' ';
    const val = document.createElement('span'); val.className = 'fx-val'; val.textContent = def + unit;
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.value = def;
    inp.addEventListener('input', () => {
      const t = getTarget(), v = +inp.value;
      if (v === def) delete t[key]; else t[key] = v;
      val.textContent = v + unit;
      onChange();
    });
    lab.appendChild(name); lab.appendChild(val); lab.appendChild(inp);
    container.appendChild(lab);
    inputs[key] = inp; vals[key] = val;
  });

  const scLab = document.createElement('label'); scLab.className = 'row gap';
  const scName = document.createElement('span'); scName.textContent = 'Shadow colour';
  const sc = document.createElement('input'); sc.type = 'color'; sc.value = '#000000';
  sc.addEventListener('input', () => { getTarget().shadowColor = sc.value; onChange(); });
  scLab.appendChild(scName); scLab.appendChild(sc);
  container.appendChild(scLab);

  function sync() {
    const t = getTarget();
    for (const s of FILTER_SLIDERS) {
      const key = s[0], def = s[4], unit = s[5];
      const v = t[key] != null ? t[key] : def;
      inputs[key].value = v; vals[key].textContent = v + unit;
    }
    sc.value = t.shadowColor || '#000000';
  }
  sync();
  return { sync };
}
