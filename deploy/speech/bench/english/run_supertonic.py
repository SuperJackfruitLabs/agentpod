import os, sys; sys.path.insert(0, "/root/tts-bench-en/bench")
os.environ.setdefault("SUPERTONIC_CACHE_DIR", "/root/tts-bench-en/models/supertonic-3")
from bench_common import run, THREADS
from supertonic import TTS
VOICE = os.environ.get("VOICE", "F1")
M = {}
def load():
    M["t"] = TTS(auto_download=True, intra_op_num_threads=THREADS, inter_op_num_threads=1)
    M["s"] = M["t"].get_voice_style(voice_name=VOICE)
def synth(text):
    wav, dur = M["t"].synthesize(text, voice_style=M["s"], lang="en")
    return wav
def sr():
    return M["t"].sample_rate
import supertonic
run("supertonic3", load, synth, sr, meta={"voice": VOICE, "steps": 8})
