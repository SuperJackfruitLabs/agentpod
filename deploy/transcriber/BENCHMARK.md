# Transcriber benchmark (2026-09-26)

Why the transcriber runs faster-whisper `large-v3-turbo`, int8, in batched
mode, on foundry. Scripts are in `bench/`, raw results in `bench/results/`.

## Machines

- **foundry**: Ryzen 5 3600 (6 cores / 12 threads, AVX2, no AVX-512/VNNI),
  62 GB RAM, no GPU.
- **infra** (the hub's host): 4 vCPU, 7.6 GB RAM, no GPU. Measured once, to
  see whether the hub's own host could do it.

## Clips

Ten short clips, one sentence or two each (5–8 s), made with macOS `say`
voices from `bench/refs.tsv`: English, Hindi, Hinglish (Hindi-English mixed,
romanised), Japanese, Chinese, Russian, Hebrew, Thai, Vietnamese, Indonesian.
Plus `long5.wav`: the English sentence forty times, trimmed to exactly
5 minutes (the cap the service enforces). `bench/make_clips.sh` rebuilds them
all on a Mac; the audio is not in the repo.

## 1. Model and host (plain faster-whisper, int8, beam 5, VAD on)

`bench/bench.py <model> <threads>`: 6 threads on foundry, 4 on infra.

| | foundry `small` | foundry `large-v3-turbo` | infra `small` | infra `large-v3-turbo` |
|---|---|---|---|---|
| Load | 8.1 s | 20.4 s (incl. first download) | 5.3 s | 10.4 s |
| Short clip | 2.5–3.6 s | 12.0–13.2 s | 7.2–15.0 s | 28.5–33.4 s |
| 5-minute clip | 199.4 s | 200.3 s | 659.0 s | 497.1 s |

- infra is out: 8–11 minutes for a 5-minute note, on the cores the hub needs.
- `small` is no faster than turbo on long audio, and much worse (below).

## 2. Making turbo fast on foundry

`bench/bench_plain12.py`, `bench/bench_batched.py <threads> <batch>`,
`bench/bench_cpp.py 12` (whisper.cpp through pywhispercpp, `ggml-large-v3-turbo-q5_0`).
Output in `bench/results/batched-and-whispercpp.txt`.

| Setup | Hindi clip | English clip | 5-minute clip |
|---|---|---|---|
| faster-whisper plain, 6 threads (section 1) | 13.2 s | 12.2 s | 200.3 s |
| faster-whisper plain, 12 threads | 13.1 s | not recorded | 216.0 s |
| **faster-whisper batched, 6 threads, batch 8** | 13.4 s | 12.1 s | **84.3 s** |
| faster-whisper batched, 12 threads, batch 8 | 13.5 s | 12.7 s | 82.9 s |
| faster-whisper batched, 12 threads, batch 16 | 13.6 s | 12.7 s | 81.4 s |
| whisper.cpp q5_0 (prebuilt wheel), 12 threads | 24.8 s | 24.2 s | 262.7 s |

- **Batched** is 2.4x faster on long audio, with the same text.
- **Threads**: 12 is no better than 6 (the CPU has six physical cores).
- **Short notes cost ~13 s whatever the setup**: the encoder always processes
  a 30-second window.
- **whisper.cpp** was slower. The prebuilt wheel is probably not built for this
  CPU; a native build needs a compiler on foundry, and it was too far behind to
  be worth one.

## 3. Accuracy

Full transcripts per clip are in `bench/results/res-*.jsonl`; word error rates
were not computed, only read against `refs.tsv`.

- **turbo**: near-exact in all ten languages. English, Chinese, Japanese,
  Russian, Vietnamese, Indonesian: exact apart from digits for number words
  and ё written as е. Hindi: three words misspelt ("तीम" for "टीम", "कृटिया"
  for "कृपया", "लिखे" for "लिखिए"). Thai: one letter. Hebrew: one word split
  in two ("המעוד כאן").
- **small**: dropped whole sentences of Hindi and Thai, heard "sore" as
  "sorry" (Indonesian), wrote Chinese in traditional characters.
- **Hinglish** is the weak spot for every setup: the gist survives, but the
  whole sentence comes out in Devanagari ("मीटिंग", "फाइनल रिपोर्ट") with
  several words garbled ("मज" for "mujhe", "एच आउपडेट" for "update"), and
  the first word is lost.
- whisper.cpp ran the same model and gave the same quality.

## Decision

`large-v3-turbo`, int8, batched (batch 8), 6 threads, on foundry, one
transcription at a time (`server.py`): ~13 s for a short note, ~82 s for five
minutes. Re-measured on 2026-09-29 through the live service: 82.3 s and 82.5 s
for `long5.wav`, and 83.9 s in the TTS benchmark's idle run.

## Re-running

On the host being measured (numbers above were foundry, as root):

```sh
mkdir -p ~/stt-bench && cd ~/stt-bench   # with bench/*.py, refs.tsv and the clips
uv venv .venv && VIRTUAL_ENV=.venv uv pip install faster-whisper
export HF_HOME=~/stt-bench/.hf
for m in small large-v3-turbo; do .venv/bin/python bench.py $m 6; done
.venv/bin/python bench_plain12.py
for c in "6 8" "12 8" "12 16"; do .venv/bin/python bench_batched.py $c; done
uv venv .venv-cpp && VIRTUAL_ENV=.venv-cpp uv pip install pywhispercpp
mkdir -p ggml && curl -fsSL -o ggml/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
.venv-cpp/bin/python bench_cpp.py 12
```

Stop nothing else heavy while it runs, and do not run two at once: on foundry
the live transcriber and the speech service share the CPU (see
`deploy/speech/BENCHMARK.md` for what that costs). To time the live service
instead, use `deploy/speech/bench/english/stt_long.sh`, which reads the token
from `/etc/agentpod-transcriber.env` and never prints it.
