#!/bin/bash
cd ~/tts-bench-en
export HF_HUB_OFFLINE=1
b() { env RESULT_TAG=tuned "$@" 2>&1 | grep "^\[" ; }
b TTS_THREADS=6 ~/tts-bench/.venv/bin/python bench/run_kokoro.py
b TTS_THREADS=4 .venv-supertonic/bin/python bench/run_supertonic.py
b TTS_THREADS=1 .venv-pocket/bin/python bench/run_pocket.py
b TTS_THREADS=4 .venv-soprano/bin/python bench/run_soprano.py
b TTS_THREADS=6 .venv-kitten/bin/python bench/run_kitten.py
b TTS_THREADS=6 KITTEN_REPO=KittenML/kitten-tts-nano-0.8-fp32 KITTEN_NAME=kitten-nano .venv-kitten/bin/python bench/run_kitten.py
b TTS_THREADS=4 VOICE=Ava .venv-moss/bin/python bench/run_moss.py
b TTS_THREADS=6 QUANT=Q4_K_M .venv-neutts/bin/python bench/run_neutts.py
HF_HUB_OFFLINE=1 QUANT=Q4_K_M .venv-neutts/bin/python bench/run_neutts.py 2>&1 | grep "^\["
echo TUNED_DONE
