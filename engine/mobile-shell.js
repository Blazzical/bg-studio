// ---------- Phone layout ----------
// On a narrow screen (phone browser or the Android APK) the always-open
// sidebar becomes a bottom tab bar of icon tiles: tapping one opens that panel
// as a sheet under the stage, tapping it again (or ✕) closes it. Top-bar
// actions other than the primary export fold into a ☰ menu. Shared by every
// page with the topbar / .app > .sidebar + main layout; desktop is untouched.
//
// Panels can set data-tab (key), data-icon and data-label; otherwise the key
// and label come from the panel's <h3>. Any element with data-tiles gets its
// buttons laid out as icon-over-label tiles on a phone.

const PHONE = matchMedia('(max-width: 820px), (pointer: coarse) and (max-height: 500px)');

let sidebar, nav, sheetHead, sheetTitle, menuBtn, menu, actions;
let tabs = [];          // { key, label, icon, panel, tile }
let current = null;     // key of the open panel, or null when the sheet is closed
const listeners = [];

function panelLabel(p) {
  if (p.dataset.label) return p.dataset.label;
  const h = p.querySelector('h3');
  // First text node only: drops trailing hints like "— your saved bits".
  const t = h ? [...h.childNodes].find(n => n.nodeType === 3 && n.textContent.trim()) : null;
  return t ? t.textContent.trim() : 'Panel';
}

// "🖼 Meme library" → icon span + label span, so a tile can stack them.
function splitTile(el) {
  if (el.dataset.tiled) return;
  const t = [...el.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
  if (!t) return;
  const m = t.textContent.trim().match(/^(\S+)\s+(.*)$/u);
  if (!m) return;
  const ico = document.createElement('span'); ico.className = 't-ico'; ico.textContent = m[1];
  const lbl = document.createElement('span'); lbl.className = 't-lbl';
  // A trailing "(Ctrl/Cmd+V)" means nothing on a phone: keep it, but as a
  // span the phone CSS hides.
  const pm = m[2].match(/^(.*?)\s*(\(.*\))\s*$/);
  lbl.textContent = pm ? pm[1] : m[2];
  if (pm) { const k = document.createElement('span'); k.className = 't-key'; k.textContent = ' ' + pm[2]; lbl.append(k); }
  t.replaceWith(ico, ' ', lbl);
  el.dataset.tiled = '1';
}

// A tab only shows while its panel could be visible (Graphs hides whole
// groups of panels per chart type).
function refreshTiles() {
  for (const t of tabs) {
    let hidden = false;
    for (let e = t.panel.parentElement; e && e !== sidebar; e = e.parentElement) {
      if (e.classList.contains('hidden') || e.style.display === 'none') { hidden = true; break; }
    }
    if (t.panel.classList.contains('hidden') || t.panel.style.display === 'none') hidden = true;
    t.tile.classList.toggle('hidden', hidden);
    if (hidden && current === t.key) show(null);
  }
}

function refit() {
  // Stages size themselves on window resize; opening/closing the sheet changes
  // the space they have without the window changing.
  window.dispatchEvent(new Event('resize'));
}

export function show(key) {
  if (key === current) key = null;
  current = key;
  for (const t of tabs) {
    t.panel.classList.toggle('m-active', t.key === key);
    t.tile.classList.toggle('active', t.key === key);
  }
  document.body.classList.toggle('m-sheet', !!key);
  const t = tabs.find(t => t.key === key);
  sheetTitle.textContent = t ? t.label : '';
  if (t) { sidebar.scrollTop = 0; t.tile.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  refit();
  for (const fn of listeners) fn(key);
}

export const isPhone = () => PHONE.matches;
export const currentTab = () => current;
export function onTabChange(fn) { listeners.push(fn); }
// Flag a tab (e.g. "a layer is selected") without opening it.
export function markTab(key, on) {
  const t = tabs.find(t => t.key === key);
  if (t) t.tile.classList.toggle('dot', !!on);
}

function closeMenu() { menu.classList.remove('open'); menuBtn.classList.remove('active-mode'); }

// Move the secondary actions into the ☰ menu on a phone, back on desktop.
function placeActions() {
  const phone = PHONE.matches;
  document.body.classList.toggle('m-phone', phone);
  if (phone) {
    for (const el of [...actions.children]) {
      if (el === menuBtn || el.classList.contains('primary')) continue;
      el.dataset.mMoved = '1';
      menu.appendChild(el);
    }
  } else {
    for (const el of [...menu.children]) { if (el.dataset.mMoved) actions.insertBefore(el, menuBtn); }
    closeMenu();
    show(null);
  }
  // On a phone every page is one app: open sibling pages in place, not new tabs.
  for (const a of document.querySelectorAll('.topbar a[target="_blank"], .topbar a[data-m-target]')) {
    if (phone) { a.dataset.mTarget = a.target || '_blank'; a.removeAttribute('target'); }
    else if (a.dataset.mTarget) a.target = a.dataset.mTarget;
  }
  refit();
}

export function initMobileShell() {
  sidebar = document.querySelector('.app > .sidebar');
  actions = document.querySelector('.topbar .top-actions');
  if (!sidebar || !actions) return;

  sheetHead = document.createElement('div');
  sheetHead.className = 'm-sheet-head';
  sheetTitle = document.createElement('span');
  const close = document.createElement('button');
  close.className = 'ghost small'; close.textContent = '✕'; close.title = 'Close';
  close.addEventListener('click', () => show(null));
  sheetHead.append(sheetTitle, close);
  sidebar.prepend(sheetHead);

  nav = document.createElement('nav');
  nav.className = 'm-tabs';
  const used = new Set();
  // data-order puts the most-used panels first in the tab bar; the rest keep page order.
  const panels = [...sidebar.querySelectorAll('section.panel')]
    .map((p, i) => [p, p.dataset.order != null ? +p.dataset.order : 100 + i])
    .sort((a, b) => a[1] - b[1]).map(([p]) => p);
  for (const panel of panels) {
    const label = panelLabel(panel);
    let key = panel.dataset.tab || label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    while (used.has(key)) key += '-';
    used.add(key);
    const icon = panel.dataset.icon || '•';
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'm-tab';
    tile.innerHTML = '<span class="t-ico"></span><span class="t-lbl"></span>';
    tile.firstChild.textContent = icon;
    tile.lastChild.textContent = label;
    tile.addEventListener('click', () => show(key));
    nav.appendChild(tile);
    tabs.push({ key, label, icon, panel, tile });
  }
  document.body.appendChild(nav);

  for (const box of document.querySelectorAll('[data-tiles]')) {
    for (const el of box.querySelectorAll(':scope > button, :scope > label.filebtn')) splitTile(el);
  }

  menuBtn = document.createElement('button');
  menuBtn.className = 'm-menu-btn ghost';
  menuBtn.textContent = '☰';
  menuBtn.title = 'More';
  menu = document.createElement('div');
  menu.className = 'm-menu';
  actions.append(menuBtn);
  document.querySelector('.topbar').appendChild(menu);
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menuBtn.classList.toggle('active-mode', menu.classList.toggle('open'));
  });
  // Tapping a menu item (or anywhere else) closes the menu; tapping a checkbox
  // row inside it doesn't.
  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('open')) return;
    if (menu.contains(e.target) && e.target.closest('label')) return;
    closeMenu();
  });

  new MutationObserver(refreshTiles).observe(sidebar, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  PHONE.addEventListener('change', placeActions);
  placeActions();
  refreshTiles();
}
