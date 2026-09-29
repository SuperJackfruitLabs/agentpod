import os, sys; sys.path.insert(0, "/root/tts-bench-en/bench")
from bench_common import run, THREADS
from pocket_tts import TTSModel
import torch
torch.set_num_threads(THREADS)
LANG = os.environ.get("POCKET_LANG", "english")
NAME = os.environ.get("POCKET_NAME", "pocket")
VOICE = os.environ.get("VOICE", "alba")
M = {}
def load():
    M["m"] = TTSModel.load_model(language=LANG)
    M["v"] = M["m"].get_state_for_audio_prompt(VOICE)
def synth(text):
    return M["m"].generate_audio(M["v"], text).numpy()
def stream(text):
    for c in M["m"].generate_audio_stream(M["v"], text):
        yield c.numpy()
run(NAME, load, synth, lambda: M["m"].sample_rate, stream_fn=stream, meta={"voice": VOICE, "language": LANG, "torch_threads": torch.get_num_threads()})
