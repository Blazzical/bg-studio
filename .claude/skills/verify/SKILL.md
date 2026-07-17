---
name: verify
description: Build, serve and drive BG Studio in a real browser to observe a change working. Use when verifying any change to app.js / index.html / style.css / combiner.js.
---

# Verifying BG Studio

Zero build step — it's static files. "Building" means nothing; the only
verification that counts is driving the page in a real browser and looking at
the canvas.

## Syntax check

`node --check app.js` **does not work** — app.js is an ES module (it imports
`@imgly/background-removal` from esm.sh) and plain `--check` rejects `import`.
The `.claude/settings.local.json` allowlist entry for it is a leftover.

Use instead:

```bash
./tools/check.sh app.js combiner.js
```

It copies each file to a temp `.mjs` and checks that. This is a syntax gate
only — it proves nothing about behaviour.

## Serve

```bash
python serve.py &          # binds 127.0.0.1:8899, sends no-cache headers
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8899/index.html
```

The no-cache headers mean you never need to hard-reload between edits.

## Drive it

There are no tests and there is no test framework. Use Playwright.
First time on a machine:

```bash
cd <scratchpad> && npm init -y && npm install playwright@1.61.1
npx playwright install chromium
```

Do **not** install into `/tmp` on Windows — git-bash `/tmp` resolves to
`C:\tmp`, and node's ESM resolver won't find the package. Install into the
scratchpad and import bare (`from 'playwright'`).

### Gotchas that will cost you an hour

- **Setting a control's value in JS does nothing on its own.** Everything is
  wired through `bindText(id, fn)` which listens for `input`. Always:
  `el.value = v; el.dispatchEvent(new Event('input', {bubbles:true}))`.
- **Rich-text selection lives in `_textSel`, not the DOM.** The app records it
  from `select`/`keyup`/`mouseup` on `#text-value`, but only while that
  textarea is `document.activeElement`. To select: `ta.focus();
  ta.setSelectionRange(a,b); ta.dispatchEvent(new Event('select'))`. To clear
  it: focus, collapse to `(0,0)`, dispatch `select` again.
- **Selection offsets are UTF-16; `charStyles` indices are code points.**
  Fine for ASCII, wrong the moment there's an emoji. `utf16ToCp` bridges them.
- **Layers are z-ordered, `state.layers` is module-scoped and not reachable
  from the page.** You cannot read state from Playwright. Observe the canvas
  instead (below), or open the Inspect modal and read `#inspect-body`.

### Observing the canvas

The stage canvas is the actual output. Sample it rather than eyeballing:

```js
const countColor = (hex) => pg.evaluate((hex) => {
  const [tr,tg,tb] = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16));
  const c = document.getElementById('stage');
  const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i+3] < 128) continue;
    if (Math.abs(d[i]-tr)<40 && Math.abs(d[i+1]-tg)<40 && Math.abs(d[i+2]-tb)<40) n++;
  }
  return n;
}, hex);
```

Pixel counts are the evidence. Antialiasing means you need a tolerance
(~40) and you'll never get exact counts.

### Proving a bug fix

For a rendering/state bug, run the same script against the unfixed code first:

```bash
git stash push app.js index.html style.css
node drive.mjs     # capture the broken numbers
git stash pop
node drive.mjs     # capture the fixed numbers
```

The before/after pixel counts are far stronger evidence than the fixed run
alone. Watch out: a `head -N drive.mjs > control.mjs` control run will
**overwrite the fixed run's screenshots** — give the control its own filenames.

## Useful control IDs

`#btn-add-text` `#btn-add-table` `#btn-add-paint` `#btn-add-line`
`#btn-add-rect` `#btn-add-ellipse` `#btn-add-star` `#btn-add-squiggle`
`#btn-add-path` · text: `#text-value` `#text-color` `#text-stroke`
`#text-stroke-w` `#text-font` `#text-bold` · `#btn-inspect` opens the
underlying-settings modal (`#inspect-body`), the fastest way to see what a
layer is *really* set to.

## Build stamp

`const BUILD` near the bottom of app.js renders bottom-right. Bump it on every
change — it's how you prove which app.js the browser actually has. If a
screenshot shows the old stamp, you're looking at stale code.
