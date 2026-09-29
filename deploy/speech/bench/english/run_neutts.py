import os, sys, glob; sys.path.insert(0, "/root/tts-bench-en/bench")
from bench_common import run, THREADS, split_sentences
import numpy as np, torch
torch.set_num_threads(THREADS)
import neutts.neutts as nt
nt._n_perf_cores = lambda: THREADS
# The ungated mradermacher GGUF marks <|speech_N|> as control tokens, which llama-cpp-python
# drops when detokenizing; render special tokens so neutts can parse its own output.
from llama_cpp import Llama
_detok = Llama.detokenize
Llama.detokenize = lambda self, tokens, prev_tokens=None, special=False: _detok(self, tokens, prev_tokens, special=True)
QUANT = os.environ.get("QUANT", "Q8_0")
GGUF = f"/root/tts-bench-en/models/neutts/neutts-air.{QUANT}.gguf"
CODEC = glob.glob("/root/tts-bench-en/hf/hub/models--aoiandroid--neuphonic-neucodec-onnx-decoder-int8-mirror/snapshots/*/model.onnx")[0]
REF = os.environ.get("REF", "jo")
SAMPLES = "/root/tts-bench-en/src/neutts/samples"
M = {}
def load():
    M["t"] = nt.NeuTTS(backbone_repo=GGUF, backbone_device="cpu", codec_repo=CODEC, codec_device="cpu", language="en-us")
    M["codes"] = torch.load(f"{SAMPLES}/{REF}.pt")
    M["txt"] = open(f"{SAMPLES}/{REF}.txt").read().strip()
def chunks(text):
    # 2048-token context (~30 s incl. the reference): long text must go sentence by sentence
    return split_sentences(text) if len(text) > 300 else [text]
def synth(text):
    return np.concatenate([M["t"].infer(c, M["codes"], M["txt"]) for c in chunks(text)])
def stream(text):
    for c in chunks(text):
        for a in M["t"].infer_stream(c, M["codes"], M["txt"]):
            yield a
run(f"neutts-air-{QUANT.lower()}", load, synth, 24000, stream_fn=stream,
    meta={"voice": f"{REF} (bundled reference)", "gguf": os.path.basename(GGUF), "codec": "neucodec ONNX decoder int8 (sha256-identical mirror)"})
