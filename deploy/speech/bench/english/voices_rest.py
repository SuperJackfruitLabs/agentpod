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
import numpy as _np
_all = sorted(_np.load("/root/tts-bench/voices-v1.0.bin").files)
_done = {"af_heart","af_bella","af_nicole","af_aoede","af_kore","af_sarah","am_michael","am_fenrir","am_puck","bf_emma","bf_isabella","bm_george"}
VOICES = [(v, "en-gb" if v[0] == "b" else "en-us") for v in _all if v[:2] in ("af","am","bf","bm") and v not in _done]
opts = ort.SessionOptions()
opts.intra_op_num_threads = 6
k = Kokoro.from_session(ort.InferenceSession("/root/tts-bench/kokoro-v1.0.onnx", sess_options=opts),
                        "/root/tts-bench/voices-v1.0.bin")
for name, lang in VOICES:
    s, sr = k.create(TEXT, voice=name, speed=1.0, lang=lang)
    sf.write(f"/root/tts-bench-en/out/voice_{name}.wav", s, sr)
    print(name, round(len(s) / sr, 1), "s", flush=True)

