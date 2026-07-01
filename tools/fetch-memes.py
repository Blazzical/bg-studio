#!/usr/bin/env python3
"""Fetch a bundled meme-template library for BG Studio.

Pulls template names + blank images from two open sources — memegen.link
(watermark-free blanks, preferred) and imgflip's get_memes API (the 100 classics)
— dedupes by normalised name, downloads each image into memes/img/, and writes
memes/manifest.json as [{name, file}]. Re-runnable: skips images already on disk.
"""
import json
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMGDIR = os.path.join(ROOT, "memes", "img")
MANIFEST = os.path.join(ROOT, "memes", "manifest.json")
os.makedirs(IMGDIR, exist_ok=True)

UA = {"User-Agent": "BG-Studio-meme-fetch/1.0"}


def get(url, timeout=25):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=timeout).read()


def slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "meme"


def norm(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())


# ---- gather (name, image_url) pairs; memegen first so its blanks win on dupes ----
entries = []            # ordered list of (name, url)
seen = set()

def add(name, url):
    k = norm(name)
    if not name or not url or k in seen:
        return
    seen.add(k)
    entries.append((name.strip(), url))

try:
    mg = json.loads(get("https://api.memegen.link/templates"))
    for t in mg:
        add(t.get("name", ""), t.get("blank", ""))
    print(f"memegen: {len(mg)} templates")
except Exception as e:
    print("memegen failed:", e)

try:
    imf = json.loads(get("https://api.imgflip.com/get_memes"))["data"]["memes"]
    for m in imf:
        add(m.get("name", ""), m.get("url", ""))
    print(f"imgflip: {len(imf)} templates")
except Exception as e:
    print("imgflip failed:", e)

print(f"unique after dedupe: {len(entries)}")

# ---- download images + build manifest ----
manifest = []
used = set()
ok = fail = skip = 0
for i, (name, url) in enumerate(entries):
    ext = os.path.splitext(url.split("?")[0])[1].lower() or ".jpg"
    if ext not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
        ext = ".jpg"
    base = slug(name)
    fn = base + ext
    n = 2
    while fn in used:
        fn = f"{base}-{n}{ext}"; n += 1
    used.add(fn)
    path = os.path.join(IMGDIR, fn)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        manifest.append({"name": name, "file": fn}); skip += 1; continue
    try:
        data = get(url)
        if len(data) < 200:
            raise ValueError("too small")
        with open(path, "wb") as f:
            f.write(data)
        manifest.append({"name": name, "file": fn}); ok += 1
    except Exception as e:
        fail += 1
        print(f"  [{i}] FAIL {name}: {e}", file=sys.stderr)
    if i % 25 == 0:
        print(f"  ...{i}/{len(entries)}")
    time.sleep(0.03)

manifest.sort(key=lambda x: x["name"].lower())
with open(MANIFEST, "w") as f:
    json.dump(manifest, f, indent=0)

total = sum(os.path.getsize(os.path.join(IMGDIR, m["file"])) for m in manifest)
print(f"\ndone: {len(manifest)} in manifest (downloaded {ok}, skipped {skip}, failed {fail})")
print(f"images dir size: {total/1e6:.1f} MB")
