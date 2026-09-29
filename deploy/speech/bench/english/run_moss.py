import os, sys, queue, threading
sys.path.insert(0, "/root/tts-bench-en/bench")
from bench_common import run, THREADS
REPO = "/root/tts-bench-en/src/MOSS-TTS-Nano"
sys.path.insert(1, REPO)
os.chdir(REPO)
import torch
torch.set_num_threads(THREADS)
from onnx_tts_runtime import OnnxTtsRuntime
VOICE = os.environ.get("VOICE", "")
M = {}
def load():
    M["r"] = OnnxTtsRuntime(thread_count=THREADS)
def synth(text):
    return M["r"].synthesize(text=text, voice=VOICE, streaming=False)["waveform"]
def stream(text):
    r = M["r"]
    q = queue.Queue()
    sess = r.codec_streaming_session
    orig = sess.run_frames
    def patched(frames):
        out = orig(frames)
        if out is not None and out[1] > 0:
            audio, n = out
            q.put(audio[0, :, :n].mean(axis=0))
        return out
    sess.run_frames = patched
    def worker():
        try:
            r.synthesize(text=text, voice=VOICE, streaming=True)
        finally:
            q.put(None)
    th = threading.Thread(target=worker); th.start()
    try:
        while (item := q.get()) is not None:
            yield item
    finally:
        th.join(); sess.run_frames = orig
if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "voices":
    r = OnnxTtsRuntime(thread_count=THREADS)
    for v in r.list_builtin_voices():
        print({k: v[k] for k in v if k != "prompt_audio_codes"})
    sys.exit()
run("moss-nano", load, synth, 48000, stream_fn=stream, meta={"voice": VOICE, "backend": "official ONNX CPU runtime"})
