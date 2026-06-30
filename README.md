# 🪄 BG Studio — local meme generator + background remover

A self-hosted, fully local image editor. Like imgflip's meme generator, but it
runs on **your** machine and can **remove the background** from any image layer.

Nothing leaves your computer: background removal runs entirely in your browser
(WASM/ONNX via [`@imgly/background-removal`](https://github.com/imgly/background-removal-js)).
The only network call is a one-time ~40 MB model download on first use (then it's
cached by the browser and works offline).

It's just static files (`index.html` + `app.js` + `style.css`) served by a tiny
Python script bound to `127.0.0.1`, so there's no build step and no server to trust.

---

## Quick start

### Linux / macOS

```bash
git clone https://github.com/Blazzical/bg-studio.git
cd bg-studio
./install.sh          # checks Python, adds a menu entry
./start.sh            # serves http://localhost:8899/ and opens your browser
```

### Windows

```powershell
git clone https://github.com/Blazzical/bg-studio.git
cd bg-studio
powershell -ExecutionPolicy Bypass -File .\install.ps1   # checks Python, adds a Start Menu shortcut
.\start.bat                                              # serves http://localhost:8899/ and opens your browser
```

> **Requirement:** Python 3. On Windows the installer can fetch it via `winget`
> for you; on Linux/macOS use your package manager (`apt`, `dnf`, `brew`, …).
> No other dependencies — everything else runs in the browser.

Pick a different port by passing it through: `./start.sh 9001` / `.\start.bat 9001`.
Press **Ctrl-C** (or close the window) to stop.

### Run at startup (optional)

- **Linux (systemd):** `./install.sh --autostart` — runs now and on every boot via a
  systemd *user* service.
- **Windows:** `.\install.ps1 -Autostart` — adds a (minimized) shortcut to your
  Startup folder so it launches at login.

Undo either with `./install.sh --uninstall` / `.\install.ps1 -Uninstall`.

---

## What you can do

- **Background image** — upload a base image (the canvas auto-sizes to it), or set a
  solid fill / transparent canvas and build from scratch.
- **Add image layers** — drop in stickers / photos via the file picker, **paste** an
  image from the clipboard (Ctrl/Cmd+V), or click **📋 Paste image**. Each layer can
  be moved, scaled (corner handles), rotated (top handle), flipped, and have its
  opacity set.
  - In **Firefox**, Ctrl/Cmd+V over the canvas uses the async Clipboard API, which may
    show a one-time "paste" permission prompt. If a keyboard paste is ever blocked, the
    **📋 Paste image** button always works.
- **✂ Remove background (auto)** — select an image layer and click *Remove background*.
  The cut-out replaces the layer in place, keeping its position/size.
- **🖌 Brush (paint + manual erase)** — toggle the brush, then on the selected
  image/paint layer:
  - **Paint** lays down colour (circle or square nib, adjustable size + feather, colour
    picker).
  - **Erase** rubs out pixels — i.e. *manually* mask out a background or clean up what
    auto-removal missed. Works correctly even on rotated/scaled layers.
  - **⟲ Restore** undoes erasing on the selected layer.
  - **＋ Add paint layer** gives you a blank full-canvas layer to annotate over everything.
  - Shortcuts: **B** toggles the brush, **[** / **]** resize the nib.
- **Add text** — meme-style text with outline, font, colour, size, UPPERCASE.
  Multi-line (press **Enter**) with left / centre / right alignment.
- **Add table** — a spreadsheet-style grid you can move/scale/rotate like any layer:
  rows/cols, border width (0 = no borders) + colour, table font size/colour; click a
  cell (Shift-click for a range) to set its text, background colour, and alignment;
  **Merge** / **Unmerge** ranges.
- **Layers panel** — reorder (forward/back), select, delete.
- **Export** — download a transparent-capable PNG, or *Copy* straight to the clipboard.

## Tips / shortcuts

- Drag a layer to move; corner squares to scale; top circle to rotate.
- Hold **Shift** while rotating to snap to 15°.
- Arrow keys nudge the selected layer (Shift = 10 px steps); **Del** removes it.
- Want transparency in the export? Click **Transparent** in the Canvas panel so there's
  no solid fill behind your layers.

## Notes & troubleshooting

- **First background-removal is slow** — it downloads the ~40 MB model once. After that
  it's cached and offline.
- **Images preview blank in Firefox?** Some GPU drivers mis-handle Firefox's accelerated
  canvas. Set `gfx.canvas.accelerated = false` in `about:config` and restart Firefox.
- **Copy to clipboard** needs a secure context — `localhost` counts, so it works when
  launched via `start.sh` / `start.bat`.

## How it works

| File | Role |
|------|------|
| `index.html` | UI shell |
| `app.js` | All the editor logic (canvas compositing, layers, brush, tables, export) |
| `style.css` | Dark theme |
| `serve.py` | Tiny no-cache static server bound to `127.0.0.1` (cross-platform) |
| `start.sh` / `start.bat` | Launchers (serve + open browser) |
| `install.sh` / `install.ps1` | Optional setup: menu entry + autostart |

## License

[MIT](LICENSE) — do whatever you like; build something cool.
