import resource
import sys
import time

import soundfile as sf
from kokoro_onnx import Kokoro

TEXTS = {
    "en_short": ("The quarterly review has moved to Thursday afternoon.", "af_heart", "en-us"),
    "en_para": (
        "Quick update on the migration before tomorrow's standup. The staging database finished "
        "copying overnight and the row counts match, so I think we are clear to point the read "
        "replicas at it this afternoon. Two things are still open. First, the nightly export job "
        "still writes to the old bucket. Second, we have not tested a failover under real load. "
        "I suggest we flip the export first, watch it for a day, and schedule the failover drill "
        "for Friday morning.",
        "af_heart",
        "en-us",
    ),
    "hi_short": ("कल सुबह दस बजे टीम की बैठक है।", "hf_alpha", "hi"),
    "hi_para": (
        "कल सुबह दस बजे टीम की बैठक है। कृपया अपनी रिपोर्ट समय पर भेज दीजिए और नई योजना के "
        "बारे में अपने सुझाव तैयार रखिए। बैठक के बाद हम ग्राहक को अपडेट भेजेंगे और अगले हफ्ते "
        "की समय सीमा तय करेंगे।",
        "hf_alpha",
        "hi",
    ),
}

for model in sys.argv[1:]:
    tag = "int8" if "int8" in model else "fp32"
    t = time.time()
    k = Kokoro(model, "voices-v1.0.bin")
    print(f"== {tag}: load {time.time() - t:.1f}s", flush=True)
    for name, (text, voice, lang) in TEXTS.items():
        best = None
        for _ in range(2):
            t = time.time()
            samples, sr = k.create(text, voice=voice, speed=1.0, lang=lang)
            el = time.time() - t
            best = el if best is None else min(best, el)
        dur = len(samples) / sr
        print(f"  {name:9} audio {dur:5.1f}s  synth {best:5.2f}s  x{dur / best:4.1f} realtime", flush=True)
        sf.write(f"out/{name}_{tag}.ogg", samples, sr, format="OGG", subtype="OPUS")
    print(f"  peak RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024:.0f} MB", flush=True)
