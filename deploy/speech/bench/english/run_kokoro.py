import sys; sys.path.insert(0, "/root/tts-bench-en/bench")
from bench_common import run, patch_onnxruntime
patch_onnxruntime()
from kokoro_onnx import Kokoro
M = {}
def load():
    M["k"] = Kokoro("/root/tts-bench/kokoro-v1.0.onnx", "/root/tts-bench/voices-v1.0.bin")
def synth(text):
    s, sr = M["k"].create(text, voice="af_heart", speed=1.0, lang="en-us")
    return s
run("kokoro", load, synth, 24000, meta={"voice": "af_heart", "variant": "kokoro-onnx fp32"})
