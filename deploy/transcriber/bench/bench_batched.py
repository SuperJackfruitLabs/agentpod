import sys, time, json
from faster_whisper import WhisperModel, BatchedInferencePipeline
threads, batch = int(sys.argv[1]), int(sys.argv[2])
m = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8", cpu_threads=threads)
p = BatchedInferencePipeline(model=m)
res = {"threads": threads, "batch": batch}
for clip in ["hi.wav", "en.wav", "long5.wav"]:
    t = time.time()
    segs, info = p.transcribe(clip, batch_size=batch)
    text = " ".join(s.text.strip() for s in segs)
    res[clip] = {"secs": round(time.time() - t, 1), "lang": info.language, "text": text[:120]}
print(json.dumps(res, ensure_ascii=False))
