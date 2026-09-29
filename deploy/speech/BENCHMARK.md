# Speech benchmark (2026-09-29)

Why the speech service runs Kokoro-82M (kokoro-onnx, fp32, 6 threads) with
WeTextProcessing in front of it, on foundry. Scripts are in `bench/`, raw
results in `bench/results/`. Quality was judged by the operator, by ear; the
numbers only rule models in or out.

**Machine**: foundry, Ryzen 5 3600 (6 cores / 12 threads, AVX2, no
AVX-512/VNNI), 62 GB RAM, no GPU. The transcriber (`deploy/transcriber`)
runs on the same CPU.

**Texts**, the same for every model (`bench/english/bench_common.py`):

- *short*: "The quarterly review has moved to Thursday afternoon."
- *para*: an 85-word status update, about 25 s spoken.
- *tricky*: "Dr. Smith's API returned HTTP 503 at 3:45 p.m. on 29/09/2026 —
  roughly $1,250 of retries, i.e. 12.5% of the budget."

**RTF** below is seconds of audio per second of synthesis (higher is faster;
above 1 is faster than real time), best of two runs.

## 1. First look: Kokoro

`bench/kokoro-and-hindi/bench.py` and `bench2.py`, default ONNX Runtime
session (12 threads); output in `bench/results/kokoro-first-run.txt`.

- fp32: para 25.4 s of audio in 8.67 s (2.9x); 1.45 GB peak RSS.
- **int8 is 3–4x slower** than fp32 here (para 32.5 s, 0.8x): this CPU has
  no VNNI, which is what makes int8 fast.
- Sentence by sentence, the first sentence is ready in 0.78 s (1.30 s while
  a 5-minute transcription runs).
- One para during a 5-minute transcription: the transcription took 87.1 s
  instead of 82.5 s.

## 2. English models

`bench/english/run_<model>.py` on the shared harness `bench_common.py`,
one venv per model; results in `bench/results/<model>.json` (12 threads) and
`<model>_tuned.json` (the model's best thread count from `sweep.sh`).

| Model | Licence | Voice | RTF para, 12 threads | RTF para, best threads | Para synthesis, best | First audio | Peak RSS |
|---|---|---|---|---|---|---|---|
| **Kokoro-82M** (kokoro-onnx fp32) | Apache-2.0 | af_heart | 3.67 | **3.93 (6)** | 6.46 s | 0.80 s, by sentence | 1439 MB |
| Supertonic 3 | OpenRAIL-M | F1 | 4.29 | 5.53 (4) | 5.33 s | 0.85 s, by sentence | 637 MB |
| Pocket TTS, 6-layer | MIT code, CC-BY-4.0 weights | alba | 2.45 | 3.04 (1) | 8.16 s | 0.14 s, streamed | 1019 MB |
| Pocket TTS, 24-layer | same | alba | 0.89 | not recorded | 31.69 s (12) | 0.32 s, streamed | 2960 MB |
| Soprano-1.1-80M | Apache-2.0 | its only voice | 4.31 | 4.91 (4) | 4.70 s | 0.21 s, streamed (1.37x overall when streamed) | 951 MB |
| Kitten TTS mini 0.8 | Apache-2.0 | Bella | 1.20 | 1.33 (6) | 29.64 s | 4.01 s, by sentence | 890 MB |
| Kitten TTS nano 0.8 fp32 | Apache-2.0 | Bella | 13.36 | 15.49 (6) | 3.12 s | 0.40 s, by sentence | 660 MB |
| MOSS-TTS-Nano (ONNX) | Apache-2.0 | Ava | 0.65 | 1.81 (4) | 17.00 s | 0.32 s, streamed | 4627 MB |
| NeuTTS Air Q8_0 (GGUF) | Apache-2.0 | jo | 0.55 | not recorded | 52.30 s (12) | 3.49 s, streamed | 2814 MB |
| NeuTTS Air Q4_K_M (GGUF) | Apache-2.0 | jo | 0.56 | 0.64 (6) | 48.27 s | 3.68 s, streamed | 2586 MB |

- **Threads**: every model was slower on 12 threads than on its best count;
  the CPU has six physical cores. Kokoro: 3.67x on 12, 3.93x on 6.
- Kitten speaks slowly (para 39–48 s of audio against Kokoro's 25 s), which
  flatters its RTF.
- NeuTTS's official weights are gated and their terms were not accepted; the
  runs used mradermacher's GGUFs and an int8 codec decoder identical by sha256
  to Neuphonic's. Its llama-cpp-python was compiled without OpenMP.

## 3. Sharing the CPU with the transcriber

`run_<model>.py contention`: the para synthesised back to back for the whole
of a 5-minute transcription on the live transcriber (`stt_long.sh`), so the
worst case. Results in `bench/results/*_contention_*.json`. The transcription
alone took 83.9 s that session (measured, not saved to a file).

| Model (threads) | Para synthesis, idle → during | Transcription |
|---|---|---|
| Supertonic 3 (4) | 5.32 → 8.15 s | 127.2 s |
| Pocket TTS (1) | 8.58 → 11.53 s | 125.5 s |
| Kokoro (6) | 6.43 → 9.59 s | 135.5 s |

The service itself, measured the same way from staging after it was built
(stage 1; through HTTP, so normalising and Opus encoding included):

| | Para request | Transcription |
|---|---|---|
| Alone | 7.46 s | 82.3 s |
| Back to back for the whole transcription | 11.58 s mean | 125.7 s |
| One reply during a transcription | 11.44 s | 86.8 s |

A single reply costs a transcription about 4–5 s; only continuous speech
costs it half again.

## 4. The tricky line

Every model's *tricky* WAV transcribed back by the transcriber
(`transcribe.sh`, `results/transcripts.tsv`):

| Model | Heard as |
|---|---|
| MOSS-TTS-Nano | "…HTTP 503 at 3.45pm on the 29th of September, 2026. Roughly $1,250 of retries, i.e. 12.5% of the budget." (the only fully correct read; it runs WeTextProcessing itself) |
| Soprano | "…at 345 p.m on 29-9-2026 roughly 1250 dollars of retries **i dot e** 12.5 percent…" |
| Kokoro | "…at **345p** on **29-09-2026**, roughly $1,250 of retries, i.e. **12, 5%**…" |
| Supertonic 3 | "…at 3.45 p.m. on **2909-2020-26**, roughly **$1.50** of retries…" |
| Kitten mini | "…at 345p. On 29-09-2026, roughly **1-250** of retries, I. E. 12. 5%…" |
| Kitten nano | "…http **five and three** … **one two and fifty** of retries…" |
| NeuTTS Air Q8 | "Dr. Smith's **APE** … roughly **$1,000** of retries **of retries**, i.e. 12." (stops) |
| Pocket TTS | "…HTTP **53** on **29002 sick**, roughly **1 to 50** of retries…" |
| Pocket TTS 24-layer | "…returned **HTP 5PM** on 29-9-26, roughly 20-52." |

On the *para*, Kokoro, Supertonic, Pocket and both Kittens transcribed back
without word errors; MOSS said "overnight in the row counts", Soprano "raid
replicas", NeuTTS Q8 "matched" and "re-replicas", Pocket 24-layer "rel
counts" and "red replicas". (NeuTTS Q4's para was not transcribed.)

## 5. Listening (the operator, by ear)

- **Kokoro**: high quality; its one fault was a pause between "P" and "M" in
  "p.m." on the tricky line.
- **MOSS-TTS-Nano**: said "PM" correctly and was the best overall, but at
  1.8x realtime and 4.6 GB.
- **Supertonic 3**: the para sounded good with correct pronunciation, but
  given normalised text it said "retrees" for "retries" and paused between
  "five hundred" and "and three": faults of the model, which no normaliser
  can fix.
- **NeuTTS Air**: low quality, though it pronounced the tricky line almost
  correctly. 0.6x realtime.
- **Kitten** (all versions), **Pocket TTS**, **Soprano**: not good.

## 6. The normaliser experiment

MOSS's advantage on the tricky line was its text normaliser, so the same
normaliser (WeTextProcessing's English grammar, plus one rule, "i.e." →
"that is") was run on the line and the result given to Kokoro and Supertonic
(`bench/english/norm_tricky.py`). The text they spoke:

> doctor Smith's API returned HTTP five hundred and three at three forty five
> PM on the twenty ninth of september twenty twenty six — roughly one thousand
> two hundred and fifty dollars of retries, that is twelve point five percent
> of the budget.

Verdict: Kokoro with the normaliser "got a lot better"; Supertonic kept its
"retrees" and its pause. (MOSS reads "i.e." as letters;
the normalised Kokoro says "that is".)

**Decision: Kokoro-82M, fp32, 6 threads, with WeTextProcessing in front**,
plus AgentPod's own rules for what the grammar misses (`speech_text.py`).
All 28 English Kokoro voices were rendered for the operator
(`voices_demo.py`, `voices_rest.py`); the service offers all of them.

## 7. Hindi (deferred)

`bench/kokoro-and-hindi/`:

- Kokoro's Hindi runs as fast as its English (para 15.2 s in 5.24 s), but its
  phonemiser **drops the danda "।"**, and the sentence pause with it.
  Replacing "।" with "." (`hindi.py`, version B) or splitting at it with a
  0.35 s gap (version C) fixed the pauses; the operator heard both as correct,
  but less fluent than Kokoro's English. Hindi voices tried: hf_alpha,
  hf_beta, hm_omega, hm_psi.
- **SPRINGLab/Indic-Mio** (0.6B, Apache-2.0; `mio_bench.py`): sounded
  promising, but ran at **0.24–0.26x realtime** in PyTorch on CPU (15.4 s of
  Hindi in 63 s; 6.1–6.6 tokens/s where realtime needs 25), 4.1 GB. Running it
  under llama.cpp was not tried. `results/indic-mio.txt`.
- **ai4bharat/indic-parler-tts** and **ai4bharat/IndicF5** (gated; access
  granted): downloaded and installed (`parler_bench.py`, `f5_bench.py`), but
  their runs were stopped before producing results when the operator deferred
  Hindi. Not measured.

The service's normaliser keeps `lang="hi"` for later: it turns "।" into "."
and skips the English grammar. No Hindi voice is offered yet.

## Licences

Kokoro-82M weights Apache-2.0; kokoro-onnx MIT; WeTextProcessing Apache-2.0.
kokoro-onnx brings phonemizer and espeak-ng, both **GPL-3.0**; they run in
the speech service's own process on foundry, which nothing AgentPod ships
links. The rejected models' licences are in the table in section 2
(Supertonic's OpenRAIL-M carries use restrictions; Pocket TTS's CC-BY-4.0
weights need attribution).

## Re-running

On foundry, as root. The model files are from
`https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/`
(`kokoro-v1.0.onnx`, `kokoro-v1.0.int8.onnx`, `voices-v1.0.bin`).

```sh
# Kokoro first look, in ~/tts-bench with the model files
uv venv -p 3.12 .venv && uv pip install -p .venv/bin/python kokoro-onnx soundfile
.venv/bin/python bench.py kokoro-v1.0.int8.onnx kokoro-v1.0.onnx
.venv/bin/python bench2.py idle

# English comparison, in ~/tts-bench-en with bench/ = bench/english
bash bench/install1.sh && bash bench/install2.sh && bash bench/download.sh
bash bench/build_llama.sh            # NeuTTS only: llama-cpp-python built with zig
TTS_THREADS=6 ~/tts-bench/.venv/bin/python bench/run_kokoro.py            # bench
TTS_THREADS=6 ~/tts-bench/.venv/bin/python bench/run_kokoro.py contention # with a 5-minute transcription
bash bench/sweep.sh && bash bench/tuned.sh
bash bench/transcribe.sh out/*_tricky.wav
```

Paths inside the scripts are foundry's (`/root/tts-bench`, `/root/tts-bench-en`);
the MOSS, Soprano and NeuTTS runners expect those projects' sources cloned
into `src/`. The contention and transcription scripts read the transcriber's
token from `/etc/agentpod-transcriber.env` and never print it.
