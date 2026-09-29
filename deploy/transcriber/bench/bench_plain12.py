import time, json
from faster_whisper import WhisperModel
m = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8", cpu_threads=12)
res = {"mode": "plain", "threads": 12}
for clip in ["hi.wav", "long5.wav"]:
    t = time.time(); segs, info = m.transcribe(clip, beam_size=5, vad_filter=True); n = sum(1 for _ in segs)
    res[clip] = round(time.time() - t, 1)
print(json.dumps(res))
