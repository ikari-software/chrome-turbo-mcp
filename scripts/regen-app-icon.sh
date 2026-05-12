#!/usr/bin/env bash
# Regenerate the four manifest-referenced app-icon sizes from the design
# source. Run after editing design/icons/app-icon.png.
#
# Usage: scripts/regen-app-icon.sh
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="design/icons/app-icon.png"
DST="extension/icons"

if [[ ! -f "$SRC" ]]; then
  echo "missing source: $SRC" >&2
  exit 1
fi

mkdir -p "$DST"
for size in 16 32 48 128; do
  magick "$SRC" -filter Lanczos -resize "${size}x${size}" -background none -strip \
    "${DST}/app-icon-${size}.png"
  echo "wrote ${DST}/app-icon-${size}.png"
done
