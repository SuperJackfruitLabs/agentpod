#!/bin/bash
cd ~/tts-bench-en
CPU=https://download.pytorch.org/whl/cpu
( uv venv -q --allow-existing -p 3.12 .venv-kitten && UV_SKIP_WHEEL_FILENAME_CHECK=1 VIRTUAL_ENV=.venv-kitten uv pip install -q https://github.com/KittenML/KittenTTS/releases/download/0.8/kittentts-0.8.0-py3-none-any.whl soundfile psutil && echo KITTEN_OK ) > logs/kitten.log 2>&1 &
( uv venv -q -p 3.12 .venv-soprano && VIRTUAL_ENV=.venv-soprano uv pip install -q --index-strategy unsafe-best-match --extra-index-url $CPU -e src/soprano torch soundfile psutil && echo SOPRANO_OK ) > logs/soprano.log 2>&1 &
( uv venv -q -p 3.12 .venv-neutts && VIRTUAL_ENV=.venv-neutts uv pip install -q --index-strategy unsafe-best-match --extra-index-url $CPU --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu -e "src/neutts[all]" torch torchaudio espeakng_loader psutil && echo NEUTTS_OK ) > logs/neutts.log 2>&1 &
( uv venv -q -p 3.12 .venv-moss && VIRTUAL_ENV=.venv-moss uv pip install -q numpy onnxruntime sentencepiece soundfile psutil huggingface_hub && echo MOSS_OK ) > logs/moss.log 2>&1 &
wait
echo ALL_DONE
