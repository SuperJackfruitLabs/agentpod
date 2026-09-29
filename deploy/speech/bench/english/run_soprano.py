import os, sys; sys.path.insert(0, "/root/tts-bench-en/bench")
from bench_common import run, THREADS
import torch
from soprano import SopranoTTS
torch.set_num_threads(THREADS)
M = {}
def load():
    M["m"] = SopranoTTS(backend="transformers", device="cpu")
def synth(text):
    return M["m"].infer(text).cpu().numpy()
def stream(text):
    for c in M["m"].infer_stream(text, chunk_size=1):
        yield c.numpy()
run("soprano", load, synth, 32000, stream_fn=stream, meta={"voice": "built-in (single voice)", "repo": "ekwek/Soprano-1.1-80M"})
