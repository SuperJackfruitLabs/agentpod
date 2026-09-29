#!/bin/bash
cd ~/tts-bench-en
export HF_HUB_OFFLINE=1
run() { for t in "${THR[@]}"; do env TTS_THREADS=$t "$@" idle 2>&1 | grep "^\[" ; done; }
THR=(2 4 6)
run ~/tts-bench/.venv/bin/python bench/run_kokoro.py
run .venv-supertonic/bin/python bench/run_supertonic.py
run .venv-kitten/bin/python bench/run_kitten.py
KITTEN_REPO=KittenML/kitten-tts-nano-0.8-fp32 KITTEN_NAME=kitten-nano run .venv-kitten/bin/python bench/run_kitten.py
THR=(1 2 4 6)
run .venv-soprano/bin/python bench/run_soprano.py
THR=(2 3 6 8)
VOICE=Ava run .venv-moss/bin/python bench/run_moss.py
echo SWEEP_DONE
