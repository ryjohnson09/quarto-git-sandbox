#!/usr/bin/env bash
# Build the extension's browser assets from src/ and vendor/.
#
#   ./build.sh          rebuild git-sandbox.js from src/
#   ./build.sh --vendor  also re-bundle isomorphic-git (needs npm install first)
#
# Both outputs land in _extensions/git-sandbox/resources/, which is what
# `quarto add` ships to users.

set -euo pipefail
cd "$(dirname "$0")"

RES=_extensions/git-sandbox/resources
mkdir -p "$RES"

# ---------------------------------------------------------------- sandbox js

OUT="$RES/git-sandbox.js"
{
  cat <<'HDR'
/* =====================================================================
   git-sandbox.js — a real git repository that lives entirely in the page.

   Runs isomorphic-git (MIT) against an in-memory filesystem, and renders a
   terminal, a working-directory/staging/repository diagram, and a live commit
   graph. Nothing is sent to a server; nothing is written to disk.

   GENERATED FILE — do not edit. Built from src/ by ./build.sh.
   ===================================================================== */

HDR
  cat src/sandbox-core.js
  echo; echo
  cat src/sandbox-when.js
  echo; echo
  cat src/sandbox-ui.js
} > "$OUT"

node --check "$OUT"
echo "built $OUT ($(wc -l < "$OUT") lines, $(du -h "$OUT" | cut -f1))"

# ------------------------------------------------------------------- vendor

if [ "${1:-}" = "--vendor" ]; then
  TMP=$(mktemp -d)
  ./node_modules/.bin/esbuild vendor/entry.js --bundle --minify --format=iife \
    --target=es2018 --legal-comments=none --outfile="$TMP/bundle.js"
  {
    cat <<'HDR'
/*! isomorphic-git (MIT) + the `buffer` polyfill (MIT), bundled for browsers.

    Exposes a global `git`. The polyfill is not optional: isomorphic-git's
    index code calls a global Buffer, which browsers do not provide, so a bare
    CDN copy of isomorphic-git fails at the first `git add`.

    Rebuild with: npm install && ./build.sh --vendor   (see vendor/entry.js)
    Licences: https://github.com/isomorphic-git/isomorphic-git/blob/main/LICENSE.md
              https://github.com/feross/buffer/blob/master/LICENSE            */
HDR
    cat "$TMP/bundle.js"
  } > "$RES/isomorphic-git.bundle.js"
  rm -rf "$TMP"
  node --check "$RES/isomorphic-git.bundle.js"
  echo "built $RES/isomorphic-git.bundle.js ($(du -h "$RES/isomorphic-git.bundle.js" | cut -f1))"
fi
