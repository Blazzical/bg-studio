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

Open a **normal PowerShell window** — *not* "Run as administrator" (see below) — and paste:

```powershell
iwr -useb https://raw.githubusercontent.com/Blazzical/bg-studio/main/install-bootstrap.ps1 | iex
```

Then launch **BG Studio** from the Start Menu, or run `.\start.bat` inside the folder.

Already downloaded the folder (ZIP or `git clone`)? Just **double-click `install.bat`**.
That's the whole install — no PowerShell prompt, no policy changes, no admin.

#### Do NOT run the installer as Administrator

BG Studio is a **per-user** install and needs **no admin rights**. Everything it
writes goes to your own account:

| What | Where |
|------|-------|
| App files | `%USERPROFILE%\bg-studio` |
| Start Menu entries | `%APPDATA%\Microsoft\Windows\Start Menu\Programs` |
| Autostart shortcut (optional) | your Startup folder |

Elevating doesn't just fail to help — it **breaks the install**. Under
"Run as administrator" those variables resolve to the *administrator* account,
so the shortcuts land in a profile you never log into and BG Studio appears to
have vanished. The installer now detects elevation, prints the paths it would
actually use, and asks you to confirm before continuing. Pass `-AllowElevated`
if you really do mean it.

#### If PowerShell refuses to run the script

You do **not** need admin — and you should not run `Set-ExecutionPolicy` machine-wide.
Pick whichever applies:

- **"running scripts is disabled on this system"** — use a policy bypass scoped to
  one process. Double-clicking `install.bat` does exactly this for you, or run:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
  ```
  `-ExecutionPolicy Bypass` on a single command affects that process only, changes
  nothing system-wide, and needs no elevation.
- **Prefer a persistent setting?** Scope it to yourself — still no admin:
  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
  ```
- **"...is not digitally signed" after unzipping a download** — Windows tagged the
  files as coming from the internet. The installer clears this itself now; to do it
  by hand (no admin):
  ```powershell
  Get-ChildItem .\*.ps1 | Unblock-File
  ```
- **A UAC prompt appears anyway** — that's Windows installing **Python** via `winget`,
  the one step BG Studio can't do per-user. Decline it and install Python yourself
  from [python.org](https://www.python.org/downloads/) (tick *Add python.exe to PATH*)
  if you'd rather not elevate.

The one-liner above sidesteps all of this: piping to `iex` runs the code in memory,
where the execution policy never applies.

### Linux / macOS

```bash
curl -sSL https://raw.githubusercontent.com/Blazzical/bg-studio/main/install-bootstrap.sh | bash
```

That's it — the orange **BGS** icon appears in your panel/system tray (and returns on every login). Click it to open the editor. No terminal, no fiddling.

> **Requirement:** Python 3. On Windows the bootstrapper offers to fetch it via
> `winget` if missing; on Linux/macOS use your package manager (`apt`, `dnf`,
> `brew`, …). No other dependencies — everything else runs in the browser.

Pick a different port by passing it: `./start.sh 9001` / `.\start.bat 9001`. Stop with **Ctrl-C** or by closing the window.

### Pin it to your taskbar (Chrome / Edge)

Open BG Studio in Chrome or Edge, then click the **Install** icon in the address bar (or *⋮ menu → Install BG Studio*). It becomes a standalone app with the orange **BGS** icon, pinnable to the taskbar, no browser chrome.

### System tray icon

A persistent **BGS** icon lives in your system tray / notification area, with a right-click menu (*Open BG Studio · Open Combiner · Check for updates… · Restart server · Quit*). It keeps the local server running quietly in the background and updates itself in-place from the menu.

- **Linux:** set up automatically by the installer — the icon appears immediately and on every login. (Launch it by hand with `./start-tray.sh`; skip it with `./install.sh --no-tray`.)
- **Windows:** run **BG Studio (Tray)** from the Start Menu (added by `install.ps1`) — or `.\start-tray.bat`.
- **macOS:** run `./start-tray.sh` for a menu-bar icon.

The tiny dependencies (`pystray` + `Pillow`) install automatically on first run — no manual pip needed. On Linux it uses your desktop's AppIndicator tray, falling back to a pure-X11 icon if that's unavailable (both without root).

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
  - **Big images are scaled to fit your screen.** A canvas sized to a 6000×4000 phone
    photo would be a stage you can only scroll around, so a new canvas is capped to
    your monitor with a 50 px margin on every edge and the image is scaled down to
    match (aspect preserved). A toast tells you the percentage used. Images already
    smaller than that are untouched, and you can still type any size into the Canvas
    W/H boxes afterwards.
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
  - A new text box is **never wider (or taller) than the canvas** — it's clamped to
    the image size less a 16 px margin, so it can't spawn hanging off both edges of a
    small meme. Auto-fit then shrinks the font to suit.
  - **All fonts…** opens a searchable browser of hundreds of Google Web Fonts
    plus the fonts installed on your device (previewed in the font itself). Chosen
    Google fonts are downloaded on demand — they need a connection the first time.
  - **Bold / Italic / Underline** for the whole layer, or **select part of the
    text** in the box first to style just that portion.
  - **Rich runs** — with a selection active, changing the font, size (**A−/A＋**),
    colour or outline applies to just the highlighted characters, so one text box
    can mix fonts, sizes and colours. **⟲ Reset part** clears a selection back to
    the layer default. Older saved templates load as one uniform block.
- **Add table** — a spreadsheet-style grid you can move/scale/rotate like any layer:
  rows/cols, border width (0 = no borders) + colour, table font size/colour; click a
  cell (Shift-click for a range) to set its text, background colour, and alignment;
  **Merge** / **Unmerge** ranges.
- **Layers panel** — reorder (forward/back), select, delete.
- **Export** — download a transparent-capable PNG, or *Copy* straight to the clipboard.
- **🕘 History — every Copy is autosaved.** Hitting *Copy* also files the whole
  editable scene into a rolling ring of the **last 100 unique memes**, under the
  **History** tab of the meme library. Spot a typo after pasting? Open the library,
  click the meme, and you're back in the editor with every layer intact — fix the
  word and copy again. Details:
  - Only *unique* scenes are kept, so mashing Copy on an unchanged meme doesn't fill
    the ring; re-copying an existing one just bumps it to the top.
  - Entries are named after their text, and hovering shows when they were saved.
  - Kept out of the **All** tab (it's a recovery bin, not a curated library);
    **🗑 Clear history** empties it, or ✕ removes a single entry.
  - Stored in your browser's IndexedDB alongside templates — local, like everything else.
  - Autosaves even if the clipboard write itself is blocked by the browser.

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
| `install.sh` / `install.ps1` | Optional setup: menu entry + autostart (per-user, no admin) |
| `install.bat` | Double-click Windows installer — runs `install.ps1` with a per-process policy bypass |

## License

[MIT](LICENSE) — do whatever you like; build something cool.
