#!/usr/bin/env python3
"""Shared updater for BG Studio.

Called from three places:
  * `update.bat` / `update.sh`  (CLI, user double-click)
  * `serve.py`'s POST /update   (in-app Update button)
  * directly:  `python tools/update.py`

Strategy:
  1. If the target dir has a `.git` folder AND git is on PATH, run
     `git pull --ff-only`. This is the fast, correct path for anyone who
     did `git clone` and it preserves any local commits.
  2. Otherwise (zip download, missing .git, no git installed), fetch a
     tarball of the current `main` branch from GitHub, extract it into a
     temp dir, then copy the tree over the target dir. This clobbers
     tracked files but leaves untracked files (e.g. user config) alone.

Public API:
  update(target_dir: str) -> dict
    { "ok": bool, "method": "git" | "tarball" | "error", "message": str }

CLI:
  python tools/update.py                 # updates the repo this file lives in
  python tools/update.py /path/to/repo   # updates a different checkout
  exit 0 on success, 1 on failure.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

TARBALL_URL = 'https://api.github.com/repos/Blazzical/bg-studio/tarball/main'
NETWORK_TIMEOUT = 60


def update(target_dir: str) -> dict:
    target_dir = os.path.abspath(target_dir)
    if _has_git_checkout(target_dir) and _git_available():
        return _git_pull(target_dir)
    return _tarball_fetch(target_dir)


def _has_git_checkout(d: str) -> bool:
    return os.path.isdir(os.path.join(d, '.git'))


def _git_available() -> bool:
    try:
        subprocess.run(['git', '--version'], capture_output=True, timeout=5)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _git_pull(target_dir: str) -> dict:
    try:
        proc = subprocess.run(
            ['git', '-C', target_dir, 'pull', '--ff-only'],
            capture_output=True, text=True, timeout=NETWORK_TIMEOUT,
        )
        return {
            'ok': proc.returncode == 0,
            'method': 'git',
            'message': (proc.stdout + proc.stderr).strip(),
        }
    except Exception as e:
        return {'ok': False, 'method': 'git', 'message': f'git pull failed: {e}'}


def _tarball_fetch(target_dir: str) -> dict:
    try:
        req = urllib.request.Request(TARBALL_URL, headers={'User-Agent': 'BG-Studio-Updater/1.0'})
        with urllib.request.urlopen(req, timeout=NETWORK_TIMEOUT) as r:
            data = r.read()
    except Exception as e:
        return {'ok': False, 'method': 'tarball', 'message': f'download failed: {e}'}

    try:
        with tempfile.TemporaryDirectory() as tmp:
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as tar:
                _safe_extract(tar, tmp)
            entries = os.listdir(tmp)
            if not entries:
                return {'ok': False, 'method': 'tarball', 'message': 'tarball was empty'}
            # GitHub tarballs wrap everything in Blazzical-bg-studio-<sha>/
            root = os.path.join(tmp, entries[0])
            _copy_tree_over(root, target_dir)
        return {'ok': True, 'method': 'tarball', 'message': 'Updated from GitHub tarball.'}
    except Exception as e:
        return {'ok': False, 'method': 'tarball', 'message': f'extract/copy failed: {e}'}


def _safe_extract(tar: tarfile.TarFile, dest: str) -> None:
    dest_abs = os.path.abspath(dest)
    for m in tar.getmembers():
        p = os.path.abspath(os.path.join(dest, m.name))
        if not (p == dest_abs or p.startswith(dest_abs + os.sep)):
            raise RuntimeError(f'tarball member escapes destination: {m.name}')
    tar.extractall(dest)


def _copy_tree_over(src: str, dst: str) -> None:
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        target_root = dst if rel == '.' else os.path.join(dst, rel)
        os.makedirs(target_root, exist_ok=True)
        for f in files:
            shutil.copy2(os.path.join(root, f), os.path.join(target_root, f))


if __name__ == '__main__':
    target = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    result = update(target)
    label = {'git': 'git', 'tarball': 'GitHub tarball'}.get(result['method'], result['method'])
    if result['ok']:
        print(f"[{label}] {result['message'] or 'ok'}")
        sys.exit(0)
    print(f"[{label}] update failed: {result['message']}", file=sys.stderr)
    sys.exit(1)
