#!/bin/bash
cd ~/tts-bench-en
export HF_HOME=$PWD/hf
mkdir -p models/neutts
PY=.venv-moss/bin/python
$PY - <<'P'
from huggingface_hub import hf_hub_download, snapshot_download
for f in ["neutts-air.Q8_0.gguf","neutts-air.Q4_K_M.gguf"]:
    print(hf_hub_download("mradermacher/neutts-air-GGUF", f, local_dir="models/neutts"))
print(snapshot_download("neuphonic/neucodec-onnx-decoder"))
print(snapshot_download("ekwek/Soprano-1.1-80M"))
print(snapshot_download("KittenML/kitten-tts-mini-0.8"))
P
