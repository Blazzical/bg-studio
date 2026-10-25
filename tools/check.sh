#!/usr/bin/env bash
# Syntax-check the ES modules. `node --check` can't parse `import` unless the
# file looks like a module, so copy each to a .mjs in a temp dir and check that.
set -u
d=$(mktemp -d); rc=0
for f in "$@"; do
  cp "$f" "$d/$(basename "$f" .js).mjs"
  if node --check "$d/$(basename "$f" .js).mjs" 2>&1 | grep -q .; then
    echo "FAIL $f"; node --check "$d/$(basename "$f" .js).mjs"; rc=1
  else echo "ok   $f"; fi
done
rm -rf "$d"; exit $rc
