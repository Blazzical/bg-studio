# Android APK — ongoing task

Goal: ship BG Studio (editor, combiner, graphs, GIF editor) as an installable
Android APK that works offline except for model/font downloads, with phone-usable
UI and cutout quality at least on par with phone meme apps.

**Approach: [Capacitor](https://capacitorjs.com/).** It bundles the static files
into the APK and serves them from `https://localhost/` inside a system WebView,
and gives us native plugins (share, save to gallery, HTTP, clipboard) for the
bits a browser page can't do on Android. Rejected: a TWA (Trusted Web Activity)
— it needs the site hosted publicly over HTTPS, and still can't replace serve.py.

The desktop app must keep working unchanged: the APK build *copies* the static
files into `www/` rather than moving them, and every Android-only code path is
behind a `window.Capacitor?.isNativePlatform()` check.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## Phase 0 — Toolchain
- [x] Install Node LTS — **24.20.0** via winget (Capacitor 8 needs ≥ 22; was 18.15).
- [x] Install JDK 21 — Microsoft OpenJDK 21.0.12 (`JAVA_HOME` set, user scope).
      The old Java 8 is still first on PATH for `java`; Gradle uses `JAVA_HOME`.
- [x] Set `ANDROID_HOME` = `%LOCALAPPDATA%\Android\Sdk` (user scope). SDK has
      platform android-36.1, build-tools 36.1.0, emulator, x86_64 Play system image.
- [x] Installed cmdline-tools 23.0 (now the "Android CLI"; `sdkmanager` still
      works but is deprecated in favour of `android sdk`). `platform-tools` +
      `cmdline-tools\latest\bin` added to user PATH; licences accepted.
      Open a new terminal for the env/PATH changes to apply.

## Phase 1 — Scaffold, first APK that boots
- [x] `package.json` with `@capacitor/core`, `@capacitor/android`, `@capacitor/cli`
      **8.5.3** (compileSdk/targetSdk 36, minSdk 24). Scripts: `npm run www`,
      `npm run sync`, `npm run android:build`, `npm run android:run`.
- [x] `capacitor.config.json`: appId `au.com.bartech.bgstudio`, appName
      "BG Studio", `webDir: "www"`.
- [x] `tools/build-www.mjs` (Node, so one script for every OS instead of
      .sh + .ps1): copies top-level html/js/css/json/icons + `engine/` + `memes/`
      into `www/`; skips `serve.py`, `tools/`, installers. `.gitignore` covers
      `node_modules/`, `www/`, Gradle build dirs, `local.properties`, keystores.
- [x] `npx cap add android` — `android/` project generated (commit it).
- [x] Debug build: `npm run android:build` → `android/app/build/outputs/apk/debug/app-debug.apk`
      (**88 MB**, nearly all the bundled meme library). First build ~6 min
      (Gradle downloads); needs `JAVA_HOME` = JDK 21.
- [x] Emulator (`Medium_Phone_API_36.1`, Android 16, WebView 134): installs and
      launches; editor, combiner, graphs and GIF pages all load with **no errors**;
      868 bundled memes load; drawing works. Checked over the WebView's devtools
      socket (`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`;
      Playwright can't attach to a WebView, so a raw CDP script).
      Findings for later phases: `crossOriginIsolated` is false (Phase 4),
      `navigator.gpu` exists but the emulator can't make a WebGPU context
      (expected on an emulator; test on a real phone), layout is the desktop one
      squeezed (Phase 5).
- [ ] Install on a real phone (`adb install -r app-debug.apk`, or copy the APK
      over and allow "install unknown apps").

## Phase 2 — Replace what serve.py did
- [ ] `/proxy` (imgflip import): on native, fetch with `CapacitorHttp` (native
      HTTP, no CORS) → blob URL, so imported templates don't taint the canvas.
- [ ] `/update` button: hide on native (updates come as a new APK).
- [ ] Bundled meme library (`memes/manifest.json` + `memes/img/`, ~870 files):
      decide bundle-all vs. download-on-demand (APK size).

## Phase 3 — Output: save, share, copy
- [ ] Export PNG: `<a download>` does nothing in a WebView → `@capacitor/filesystem`
      + save into the gallery (MediaStore), with a toast.
- [ ] Share button → `@capacitor/share` (send straight to Messenger/Discord etc.).
- [ ] ⧉ Copy: WebView image clipboard is unreliable → native clipboard plugin
      for images, or fall back to Share.
- [ ] **Graphs/Combiner → Editor hand-off**: desktop flow is copy-then-paste;
      on a phone add a "Send to editor" button that passes the PNG via
      IndexedDB (same origin) and opens the editor with it as a new layer.
- [ ] Paste: no Ctrl+V on a phone → "Paste image" button reading the clipboard.
- [ ] Android share-target intent: "Share to BG Studio" from the gallery opens
      the image in the editor.

## Phase 4 — Background removal on a phone
- [ ] Measure: does the Android System WebView on the test phone expose
      `navigator.gpu`? Time Fast (ISNet) and Best (BiRefNet) on GPU and CPU.
- [ ] Multi-threaded WASM needs `crossOriginIsolated` (COOP/COEP headers) —
      check whether Capacitor's local server can send them; otherwise single-thread.
- [ ] If BiRefNet on the phone CPU is too slow, default to Fast on native.
- [ ] **Native cutout plugin (likely the real quality win):** a small custom
      Capacitor plugin wrapping Google ML Kit *Subject Segmentation* (on-device,
      fast, same class of model phone meme apps use). Returns a mask → same
      `destination-in` compositing as `bg-remove.js`. Add as a third engine
      ("Phone (ML Kit)"), default on Android.
- [ ] Compare cutouts side by side with Meme Maker Pro on the same images.

## Phase 5 — Phone UI
- [x] Phone layout (`engine/mobile-shell.js` + `body.m-phone` CSS, any screen
      ≤ 820px wide, so phone browsers too): bottom icon tab bar, each panel
      opens as a sheet under the stage, secondary top-bar actions in a ☰ menu,
      Add/Shapes as icon tiles, full-screen modals. Editor, Combiner, Graphs.
- [ ] GIF editor page: not wired yet (gif.html/gif.js had uncommitted edits).
- [ ] Touch: pointer events already used (good) — add pinch-zoom/pan on the
      stage, larger handles, long-press instead of right-click/Alt-drag
      (pen tool curve handles), no hover-only affordances.
- [ ] Hide desktop-only features on native: Local Font Access ("Device fonts"),
      keyboard-shortcut hints, drag-and-drop hints, "Keep bg-remover loaded"
      wording.
- [ ] Android back button: close modals first, then navigate back between pages.
- [ ] Safe-area insets / status bar colour (theme `#ff7a1a`).

## Phase 6 — Release
- [ ] App icon (adaptive, from `icon-512.png`/`favicon.svg`) + splash screen.
- [ ] Release keystore (keep it OUT of git; back it up), signing config.
- [ ] `gradlew assembleRelease` → signed APK; versionCode/versionName from a
      single source.
- [ ] Optional: GitHub Actions workflow that builds the APK on a tag and attaches
      it to a GitHub release.
- [ ] README: install instructions (sideload, "install unknown apps").

## Open questions
- APK size budget (bundled meme library? bundle the ~40 MB ISNet model for
  offline cutouts?).
- Sideload only, or Play Store eventually (needs AAB + store listing + policy)?
- Minimum Android version (WebView WebGPU and ML Kit both want fairly recent).

## Log
- 2026-10-22 — Phase 1 done except the real-phone check: Capacitor 8.5.3 project,
  88 MB debug APK, all pages run in the emulator.
- 2026-10-22 — Phase 0 done: Node 24.20.0, JDK 21.0.12, cmdline-tools 23.0,
  ANDROID_HOME/JAVA_HOME/PATH set.
- 2026-10-22 — Task created. Environment check: Android SDK present; Node 18 and
  Java 8 too old (Phase 0).
- 2026-10-23 — Phase 5 started: phone layout (tab bar + sheets) for Editor,
  Combiner, Graphs; checked in Chrome at 390px and in the APK on the emulator.
  `android:build` now calls `.\gradlew.bat`; `android/local.properties` sets sdk.dir.
