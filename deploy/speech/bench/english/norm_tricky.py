"""Speak the normalised tricky line with Kokoro or Supertonic.

usage: norm_tricky.py kokoro|supertonic   (normalised text is read from out/tricky_normalised.txt)
"""
import os
import sys

import numpy as np
import soundfile as sf

which = sys.argv[1]
text = open("/root/tts-bench-en/out/tricky_normalised.txt").read().strip()
out = f"/root/tts-bench-en/out/{which}_tricky_normalised.wav"

if which == "kokoro":
    import onnxruntime as ort
    from kokoro_onnx import Kokoro

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 6
    sess = ort.InferenceSession("/root/tts-bench/kokoro-v1.0.onnx", sess_options=opts)
    k = Kokoro.from_session(sess, "/root/tts-bench/voices-v1.0.bin")
    samples, sr = k.create(text, voice="af_heart", speed=1.0, lang="en-us")
else:
    os.environ.setdefault("SUPERTONIC_CACHE_DIR", "/root/tts-bench-en/models/supertonic-3")
    from supertonic import TTS

    t = TTS(auto_download=True, intra_op_num_threads=4, inter_op_num_threads=1)
    samples, _ = t.synthesize(text, voice_style=t.get_voice_style(voice_name="F1"), lang="en")
    samples = np.asarray(samples, dtype=np.float32).reshape(-1)
    peak = float(np.abs(samples).max()) or 1.0
    samples = samples * (0.9 / peak)  # Supertonic renders quiet; match the others' level
    sr = t.sample_rate
sf.write(out, samples, sr)
print(which, "written", round(len(samples) / sr, 1), "s")
