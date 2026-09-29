import sys, time, json
from pywhispercpp.model import Model
threads = int(sys.argv[1])
t = time.time()
m = Model("ggml/ggml-large-v3-turbo-q5_0.bin", n_threads=threads, print_progress=False, print_realtime=False, language="auto")
res = {"engine": "whisper.cpp q5_0", "threads": threads, "load": round(time.time() - t, 1)}
for clip in ["hi.wav", "hinglish.wav", "th.wav", "en.wav", "long5.wav"]:
    t = time.time()
    segs = m.transcribe(clip)
    res[clip] = {"secs": round(time.time() - t, 1), "text": " ".join(s.text.strip() for s in segs)[:120]}
print(json.dumps(res, ensure_ascii=False))
