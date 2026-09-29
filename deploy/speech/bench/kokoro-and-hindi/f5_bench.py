import os
import resource
import sys
import time

import numpy as np
import soundfile as sf
import torch
from transformers import AutoModel

torch.set_num_threads(12)
TEXTS = {
    "hi_short": "कल सुबह दस बजे टीम की बैठक है।",
    "hi_para": (
        "कल सुबह दस बजे टीम की बैठक है। कृपया अपनी रिपोर्ट समय पर भेज दीजिए और नई योजना के "
        "बारे में अपने सुझाव तैयार रखिए। बैठक के बाद हम ग्राहक को अपडेट भेजेंगे और अगले हफ्ते "
        "की समय सीमा तय करेंगे।"
    ),
    "hinglish": "मीटिंग के बाद please final report भेज देना, और client को भी update कर देना।",
}
# Reference voice: Indic-Mio's own published sample, and its transcript from that model card.
REF_AUDIO = os.path.abspath("ref.wav")
REF_TEXT = (
    "प्लान तो बढ़िया है, but wait... Have you checked the hotel bookings? "
    "Last minute पे रूम मिलना is next to impossible on weekends."
)

t = time.time()
here = os.getcwd()
os.chdir("models/IndicF5")
sys.path.insert(0, os.getcwd())
model = AutoModel.from_pretrained(".", trust_remote_code=True)
print(f"load {time.time() - t:.1f}s", flush=True)
for name, text in TEXTS.items():
    t = time.time()
    audio = model(text, ref_audio_path=REF_AUDIO, ref_text=REF_TEXT)
    el = time.time() - t
    a = np.asarray(audio, dtype=np.float32)
    if a.dtype.kind == "i" or np.abs(a).max() > 1.5:
        a = a / 32768.0
    dur = len(a) / 24000
    sf.write(os.path.join(here, f"out/f5_{name}.wav"), a, 24000)
    print(f"  {name:9} audio {dur:5.1f}s  synth {el:6.1f}s  x{dur / el:4.2f} realtime", flush=True)
print(f"peak RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024:.0f} MB")
