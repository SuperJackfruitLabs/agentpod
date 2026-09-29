import resource
import time

import soundfile as sf
import torch
from miocodec import MioCodecModel, load_audio
from transformers import AutoModelForCausalLM, AutoTokenizer

torch.set_num_threads(12)
TEXTS = {
    "hi_short": "कल सुबह दस बजे टीम की बैठक है।",
    "hi_para": (
        "कल सुबह दस बजे टीम की बैठक है। कृपया अपनी रिपोर्ट समय पर भेज दीजिए और नई योजना के "
        "बारे में अपने सुझाव तैयार रखिए। बैठक के बाद हम ग्राहक को अपडेट भेजेंगे और अगले हफ्ते "
        "की समय सीमा तय करेंगे।"
    ),
    "hinglish": "मीटिंग के बाद please final report भेज देना, और client को भी update कर देना।",
    "en_short": "The quarterly review has moved to Thursday afternoon.",
}
OFFSET = 151669

t = time.time()
tok = AutoTokenizer.from_pretrained("SPRINGLab/Indic-Mio", trust_remote_code=True)
model = AutoModelForCausalLM.from_pretrained("SPRINGLab/Indic-Mio", torch_dtype=torch.float32).eval()
codec = MioCodecModel.from_pretrained("Aratako/MioCodec-25Hz-24kHz").eval()
sr = codec.config.sample_rate
with torch.inference_mode():
    ref = codec.encode(load_audio("ref.wav", sample_rate=sr), return_content=False).global_embedding
print(f"load {time.time() - t:.1f}s, sample rate {sr}", flush=True)

for name, text in TEXTS.items():
    prompt = tok.apply_chat_template([{"role": "user", "content": text}], tokenize=False, add_generation_prompt=True)
    inputs = tok(prompt, return_tensors="pt")
    with torch.inference_mode():
        t = time.time()
        out = model.generate(**inputs, max_new_tokens=1500, do_sample=True, temperature=0.9, top_p=0.9)
        gen = time.time() - t
        new = out[0][inputs["input_ids"].shape[1]:]
        codes = [x.item() - OFFSET for x in new if OFFSET <= x.item() < OFFSET + 12800]
        t = time.time()
        wav = codec.decode(content_token_indices=torch.tensor(codes, dtype=torch.long), global_embedding=ref)
        dec = time.time() - t
    audio = wav.reshape(-1).float().numpy()
    dur = len(audio) / sr
    sf.write(f"out/mio_{name}.wav", audio, sr)
    print(f"  {name:9} audio {dur:5.1f}s  tokens {len(codes):4d} at {len(new) / gen:5.1f} tok/s  "
          f"generate {gen:6.1f}s + decode {dec:4.1f}s  x{dur / (gen + dec):4.2f} realtime", flush=True)
print(f"peak RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024:.0f} MB")
