#!/usr/bin/env bash
# Publishes the playable build to the public repo Beeem33/STORMCAM-play,
# which GitHub Pages serves at https://beeem33.github.io/STORMCAM-play/.
# Only the minified build (dist/) goes public; this source repo stays private.
set -euo pipefail

PLAY_REPO="https://github.com/Beeem33/STORMCAM-play.git"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm run build

SHA="$(git rev-parse --short HEAD)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

cp -R dist/. "$OUT/"
touch "$OUT/.nojekyll"
cat > "$OUT/README.md" <<'MD'
# STORMCAM (play build)

**[▶ Play in your browser](https://beeem33.github.io/STORMCAM-play/)**: Chrome or Edge on a desktop or laptop, keyboard and mouse. Click the view to capture the mouse.

This repo only holds the published build of the game. It is replaced on every release.
MD

cd "$OUT"
git init -q -b main
git add -A
# GitHub no-reply address, so no personal email appears in the public repo.
git -c user.name="Beeem33" -c user.email="256909019+Beeem33@users.noreply.github.com" \
  commit -q -m "Play build from STORMCAM@$SHA"
git push -q --force "$PLAY_REPO" main
echo "Published build $SHA → https://beeem33.github.io/STORMCAM-play/"
