"""Render one normalised passage in Kokoro's better English voices, plus two blends."""
import numpy as np
import onnxruntime as ort
import soundfile as sf
from kokoro_onnx import Kokoro

TEXT = (
    "Quick update before tomorrow's standup. The staging database finished copying overnight "
    "and the row counts match. I suggest we flip the export first, watch it for a day, and "
    "schedule the failover drill for Friday at nine thirty AM."
)
VOICES = [
    ("af_heart", "en-us"), ("af_bella", "en-us"), ("af_nicole", "en-us"), ("af_aoede", "en-us"),
    ("af_kore", "en-us"), ("af_sarah", "en-us"), ("am_michael", "en-us"), ("am_fenrir", "en-us"),
    ("am_puck", "en-us"), ("bf_emma", "en-gb"), ("bf_isabella", "en-gb"), ("bm_george", "en-gb"),
]
opts = ort.SessionOptions()
opts.intra_op_num_threads = 6
k = Kokoro.from_session(ort.InferenceSession("/root/tts-bench/kokoro-v1.0.onnx", sess_options=opts),
                        "/root/tts-bench/voices-v1.0.bin")
for name, lang in VOICES:
    s, sr = k.create(TEXT, voice=name, speed=1.0, lang=lang)
    sf.write(f"/root/tts-bench-en/out/voice_{name}.wav", s, sr)
    print(name, round(len(s) / sr, 1), "s", flush=True)

# Blends: a weighted mix of the style vectors is itself a usable voice.
BLENDS = {
    "blend_heart60_bella40": [("af_heart", 0.6), ("af_bella", 0.4)],
    "blend_michael60_fenrir40": [("am_michael", 0.6), ("am_fenrir", 0.4)],
}
for name, parts in BLENDS.items():
    style = sum(k.get_voice_style(v) * w for v, w in parts).astype(np.float32)
    s, sr = k.create(TEXT, voice=style, speed=1.0, lang="en-us")
    sf.write(f"/root/tts-bench-en/out/voice_{name}.wav", s, sr)
    print(name, round(len(s) / sr, 1), "s", flush=True)
