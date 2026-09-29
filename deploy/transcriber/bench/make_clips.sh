#!/bin/sh
# The test clips, as they were made (2026-09-26): macOS `say` voices reading
# refs.tsv, converted to 16 kHz mono WAV. Runs on a Mac; copy the WAVs to the
# host being measured. The clips are not in the repo because this rebuilds
# them exactly.
set -e
cd "$(dirname "$0")"
while IFS="$(printf '\t')" read -r id voice text; do
  say -v "$voice" -o "$id.aiff" "$text"
  afconvert -f WAVE -d LEI16@16000 -c 1 "$id.aiff" "$id.wav"
  rm "$id.aiff"
done < refs.tsv
# long5.wav: the English sentence 40 times ("Item 1. ..."), trimmed to 300 s.
long=$(for i in $(seq 1 40); do printf "Item %s. The quarterly review is moved to Thursday afternoon. Please send your updated numbers by Wednesday evening, and include the risks you see for the next release. " "$i"; done)
say -v Samantha -r 170 -o long.aiff "$long"
afconvert -f WAVE -d LEI16@16000 -c 1 long.aiff long5.wav
rm long.aiff
python3 - <<'EOF'
import wave
w = wave.open("long5.wav"); p = w.getparams(); d = w.readframes(p.framerate * 300); w.close()
o = wave.open("long5.wav", "wb"); o.setparams(p); o.writeframes(d); o.close()
EOF
