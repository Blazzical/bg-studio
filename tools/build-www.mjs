// Copy the static app into www/ for the Android (Capacitor) build.
// The desktop app is served straight from the repo root by serve.py; the APK
// needs just the web files in one folder, without the server, installers or
// tooling. Run via `npm run www` (also part of `npm run android:build`).
import { cpSync, rmSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');

// Top-level files that ship: every page, script and stylesheet, plus icons.
const FILE_EXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.ico', '.png']);
const SKIP_FILES = new Set(['package.json', 'package-lock.json', 'capacitor.config.json']);
const DIRS = ['engine', 'memes'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
let n = 0;
for (const f of readdirSync(root)) {
  const p = join(root, f);
  if (!statSync(p).isFile() || SKIP_FILES.has(f) || !FILE_EXT.has(extname(f))) continue;
  cpSync(p, join(out, f));
  n++;
}
for (const d of DIRS) cpSync(join(root, d), join(out, d), { recursive: true });
console.log(`www/: ${n} files + ${DIRS.join(', ')}/`);
