import os, sys, time; sys.argv = [sys.argv[0], "none"]
os.environ["TTS_THREADS"] = os.environ.get("TTS_THREADS", "6")
exec(open("/root/tts-bench-en/bench/run_neutts.py").read().split("run(f\"neutts")[0])
load()
t = M["t"]; text = "The staging database finished copying overnight and the row counts match, so I think we are clear to point the read replicas at it this afternoon."
for i in range(2):
    a = time.perf_counter(); s = t._infer_ggml(M["codes"], M["txt"], text); b = time.perf_counter()
    w = t._decode(s); c = time.perf_counter()
    ww = t.watermarker.apply_watermark(w, sample_rate=24000) if t.watermarker else w; d = time.perf_counter()
    print(f"backbone {b-a:.2f}s ({s.count('speech_')} tokens, {s.count('speech_')/(b-a):.0f} tok/s)  codec {c-b:.2f}s  watermark {d-c:.2f}s  audio {len(w)/24000:.2f}s")
