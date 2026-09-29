import re
import time

import soundfile as sf
from kokoro_onnx import Kokoro

HI = (
    "कल सुबह दस बजे टीम की बैठक है। कृपया अपनी रिपोर्ट समय पर भेज दीजिए और नई योजना के "
    "बारे में अपने सुझाव तैयार रखिए। बैठक के बाद हम ग्राहक को अपडेट भेजेंगे और अगले हफ्ते "
    "की समय सीमा तय करेंगे।"
)
k = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
print("phonemes as-is:", k.tokenizer.phonemize(HI, "hi")[:160])
print("phonemes danda->period:", k.tokenizer.phonemize(HI.replace("।", "."), "hi")[:160])


def say(text, name, voice="hf_alpha"):
    t = time.time()
    s, sr = k.create(text, voice=voice, speed=1.0, lang="hi")
    print(f"{name}: {len(s) / sr:.1f}s audio in {time.time() - t:.2f}s")
    return s, sr


# A: as-is (baseline). B: danda replaced by a full stop.
# C: split into sentences on the danda and join with a short silence.
say(HI, "A_as_is")
sB, sr = say(HI.replace("।", "."), "B_danda_to_period")
sf.write("out/hi_B_period.wav", sB, sr)
import numpy as np

parts = [p.strip() for p in re.split(r"(?<=[।.!?])\s*", HI) if p.strip()]
chunks = []
for p in parts:
    s, sr = k.create(p.replace("।", "."), voice="hf_alpha", speed=1.0, lang="hi")
    chunks += [s, np.zeros(int(sr * 0.35), dtype=s.dtype)]
sf.write("out/hi_C_sentences.wav", np.concatenate(chunks), sr)
print("C_sentences:", len(parts), "sentences")
for v in ("hf_beta", "hm_omega", "hm_psi"):
    s, sr = k.create(HI.replace("।", "."), voice=v, speed=1.0, lang="hi")
    sf.write(f"out/hi_B_{v}.wav", s, sr)
print("voices written")
