import resource
import time

import soundfile as sf
import torch
from parler_tts import ParlerTTSForConditionalGeneration
from transformers import AutoTokenizer

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
DESC = (
    "Divya speaks at a moderate pace with a clear, natural and slightly expressive voice. "
    "The recording is of very high quality, with the speaker's voice sounding clear and very close up."
)

t = time.time()
path = "models/indic-parler-tts"
model = ParlerTTSForConditionalGeneration.from_pretrained(path).eval()
tok = AutoTokenizer.from_pretrained(path)
desc_tok = AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)
sr = model.config.sampling_rate
print(f"load {time.time() - t:.1f}s, sample rate {sr}", flush=True)
d = desc_tok(DESC, return_tensors="pt")
for name, text in TEXTS.items():
    p = tok(text, return_tensors="pt")
    with torch.inference_mode():
        t = time.time()
        audio = model.generate(input_ids=d.input_ids, attention_mask=d.attention_mask,
                               prompt_input_ids=p.input_ids, prompt_attention_mask=p.attention_mask)
        el = time.time() - t
    a = audio.cpu().numpy().squeeze()
    dur = len(a) / sr
    sf.write(f"out/parler_{name}.wav", a, sr)
    print(f"  {name:9} audio {dur:5.1f}s  synth {el:6.1f}s  x{dur / el:4.2f} realtime", flush=True)
print(f"peak RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024:.0f} MB")
