#!/usr/bin/env bash
#
# Rasterise each harness mark to the white-on-transparent PNG the bridge
# composites at provisioning time.
#
# The `.svg` files beside this script are the *sources* — the official marks,
# taken from simple-icons (see README.md). The `.png` files are generated and
# checked in: the hub composites at runtime and must not shell out to a
# rasteriser on a Fly machine, and a mark that changed silently between two
# deploys would change every agent's face with no diff to show for it.
#
# Re-run after replacing a source SVG:  ./build-marks.sh
set -euo pipefail

cd "$(dirname "$0")"

# 256px is what Matrix clients ask the media repo to thumbnail down from; the
# mark occupies 54% of it, which leaves the ring of space a circular crop needs
# so nothing important lands under the clip.
SIZE=256
INSET=59 # (256 - 256*0.54) / 2, rounded

command -v rsvg-convert >/dev/null || {
    echo "rsvg-convert not found — brew install librsvg" >&2
    exit 1
}

for svg in *.svg; do
    name="${svg%.svg}"
    # Force white here rather than in the committed source, so each source stays
    # byte-identical to what upstream publishes and re-fetching one is a clean
    # diff.
    #
    # Any existing `fill` is STRIPPED before the white one is added. Simply
    # prepending produced `<path fill="#FFFFFF" fill="#fff" ...>` for a source
    # that already carried one — a duplicate attribute, which is not valid XML
    # and which rsvg is entitled to reject. Sources differ: simple-icons ships
    # `currentColor` or no fill at all, pi.dev ships `fill="#fff"`.
    #
    # `fill-rule` must survive, so the match is anchored to `fill=` preceded by
    # a space and followed by a quote — it cannot eat `fill-rule=`.
    sed 's/ fill="[^"]*"//g; s/<path /<path fill="#FFFFFF" /g' "$svg" > ".tmp-$name.svg"
    rsvg-convert -w "$((SIZE - INSET * 2))" -h "$((SIZE - INSET * 2))" \
        ".tmp-$name.svg" -o ".tmp-$name.png"
    # Centre it on a transparent canvas of the full size.
    magick -size "${SIZE}x${SIZE}" xc:none ".tmp-$name.png" \
        -gravity center -composite "PNG32:$name.png"
    rm -f ".tmp-$name.svg" ".tmp-$name.png"
    echo "built $name.png"
done
