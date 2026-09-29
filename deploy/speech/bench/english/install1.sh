#!/bin/bash
cd ~/tts-bench-en
CPU=https://download.pytorch.org/whl/cpu
( uv venv -q -p 3.12 .venv-supertonic && VIRTUAL_ENV=.venv-supertonic uv pip install -q supertonic soundfile psutil && echo SUPERTONIC_OK ) > logs/supertonic.log 2>&1 &
( uv venv -q -p 3.12 .venv-kitten && VIRTUAL_ENV=.venv-kitten uv pip install -q https://github.com/KittenML/KittenTTS/releases/download/0.8/kittentts-0.8.0-py3-none-any.whl soundfile psutil && echo KITTEN_OK ) > logs/kitten.log 2>&1 &
( uv venv -q -p 3.12 .venv-pocket && VIRTUAL_ENV=.venv-pocket uv pip install -q --index-strategy unsafe-best-match --extra-index-url $CPU pocket-tts torch torchaudio soundfile psutil scipy && echo POCKET_OK ) > logs/pocket.log 2>&1 &
wait
echo ALL_DONE
