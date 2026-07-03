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

**No git required — just Python 3.** The one-liner downloads the latest release, extracts it to `~/bg-studio` (or `%USERPROFILE%\bg-studio` on Windows), and adds a menu entry.

### Windows

```powershell
iwr -useb https://raw.githubusercontent.com/Blazzical/bg-studio/main/install-bootstrap.ps1 | iex
```

Then launch **BG Studio** from the Start Menu, or run `.\start.bat` inside the folder.

### Linux / macOS

```bash
curl -sSL https://raw.githubusercontent.com/Blazzical/bg-studio/main/install-bootstrap.sh | bash
```

Then run `./start.sh` inside the folder.

> **Requirement:** Python 3. On Windows the bootstrapper offers to fetch it via
> `winget` if missing; on Linux/macOS use your package manager (`apt`, `dnf`,
> `brew`, …). No other dependencies — everything else runs in the browser.

Pick a different port by passing it: `./start.sh 9001` / `.\start.bat 9001`. Stop with **Ctrl-C** or by closing the window.

### Pin it to your taskbar (Chrome / Edge)

Open BG Studio in Chrome or Edge, then click the **Install** icon in the address bar (or *⋮ menu → Install BG Studio*). It becomes a standalone app with the orange **BGS** icon, pinnable to the taskbar, no browser chrome.

### System tray (Windows)

Prefer a persistent notification-area icon over the browser install? Run **BG Studio (Tray)** from the Start Menu (added by `install.ps1`) — or `.\start-tray.bat` directly. It shows a BGS icon in the notification area with a right-click menu (*Open BG Studio · Open Combiner · Check for updates… · Restart server · Quit*), keeps the server running silently in the background with no console window, and updates itself in-place from the menu. On first run it installs `pystray` + `Pillow` via pip (one-time setup).

### Run at startup (optional)

- **Windows:** `.\install.ps1 -Autostart` — adds a (minimized) Startup-folder shortcut.
- **Linux (systemd):** `./install.sh --autostart` — enables a user service.

Undo with `.\install.ps1 -Uninstall` / `./install.sh --uninstall`.

### Update to the latest

- **In-app:** the **⟳ Update** button in the top bar posts to a same-origin `/update` endpoint that runs the same logic as the CLI.
- **Windows CLI:** double-click **BG Studio - Update** in the Start Menu, or run `.\update.bat`.
- **Linux / macOS CLI:** `./update.sh`.

All three routes go through `tools/update.py`, which prefers `git pull` when the checkout has a `.git` folder and falls back to a fresh GitHub tarball otherwise — so **updates work even without git installed**.

Restart BG Studio afterwards so the local server picks up any server-side changes (browser-side files pick themselves up on the next reload thanks to no-cache headers).

### With git (contributors)

If you want to hack on it or track upstream by branch:

```bash
git clone https://github.com/Blazzical/bg-studio.git
cd bg-studio
./install.sh    # or .\install.ps1 on Windows
```

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
