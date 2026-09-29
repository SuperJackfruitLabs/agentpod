import os, sys; sys.path.insert(0, "/root/tts-bench-en/bench")
from bench_common import run, patch_onnxruntime
patch_onnxruntime()
from kittentts import KittenTTS
REPO = os.environ.get("KITTEN_REPO", "KittenML/kitten-tts-mini-0.8")
NAME = os.environ.get("KITTEN_NAME", "kitten-mini")
VOICE = os.environ.get("VOICE", "Bella")
M = {}
def load():
    M["m"] = KittenTTS(REPO)
def synth(text):
    return M["m"].generate(text, voice=VOICE)
run(NAME, load, synth, 24000, meta={"voice": VOICE, "repo": REPO})
