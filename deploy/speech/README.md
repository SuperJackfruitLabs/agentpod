# agentpod-speech

Text to speech for agents' replies, sent back as voice notes. An
OpenAI-compatible `POST /v1/audio/speech`, so the hub, Hermes and OpenClaw
each use the OpenAI speech client they already have. Kokoro-82M on CPU, after
a normaliser has turned the reply's markdown, numbers and abbreviations into
words. See `BENCHMARK.md` for why, and `server.py` for the defaults.

Runs on **foundry** next to the transcriber (`deploy/transcriber`), reachable
only over Tailscale, with a bearer token.

## Install

```sh
sudo mkdir -p /opt/agentpod-speech && cd /opt/agentpod-speech
sudo cp server.py speech_text.py requirements.txt /opt/agentpod-speech/
R=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
curl -fLO $R/kokoro-v1.0.onnx && curl -fLO $R/voices-v1.0.bin   # 311 MB + 27 MB
sha256sum -c <<SUMS
7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5  kokoro-v1.0.onnx
bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d  voices-v1.0.bin
SUMS
# uv: https://github.com/astral-sh/uv/releases (single binary)
uv venv -p 3.12 .venv && VIRTUAL_ENV=.venv uv pip install -r requirements.txt
sudo tee /etc/agentpod-speech.env <<ENV
SPEECH_TOKEN=<random>
SPEECH_HOST=<tailscale ip>
SPEECH_PORT=8841
ENV
sudo chmod 600 /etc/agentpod-speech.env
sudo cp agentpod-speech.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agentpod-speech
curl -s http://<tailscale ip>:8841/health
```

It starts in about 2 s: the model, the normaliser's grammars (prebuilt in the
WeTextProcessing wheel) and one warm-up sentence. Previews are cached in
`/opt/agentpod-speech/cache`. The other settings (`SPEECH_THREADS`,
`SPEECH_QUEUE`, `SPEECH_TIMEOUT`, ...) are listed at the top of `server.py`.

## API

All but `/health` need `Authorization: Bearer $SPEECH_TOKEN`.

```sh
curl -s -H "Authorization: Bearer $SPEECH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"input": "The deploy finished at 3:45 p.m.", "voice": "af_heart"}' \
  http://<tailscale ip>:8841/v1/audio/speech -o reply.ogg
```

**`POST /v1/audio/speech`**, OpenAI's request shape:

| Field | |
|---|---|
| `input` | The text, markdown and all; up to 4096 characters (413 beyond, 400 when empty or nothing in it can be said, such as only emoji) |
| `voice` | A voice id, an OpenAI voice name, or a blend; default `af_heart` |
| `response_format` | `opus` (default: Ogg/Opus, what a Matrix voice note is), `mp3`, `wav`, `flac`, or `pcm` (raw signed 16-bit little-endian, 24 kHz mono). All are encoded by libsndfile inside the `soundfile` wheel; no ffmpeg. `aac` is not offered |
| `speed` | 0.5 to 2.0, default 1.0 (Kokoro's range; 400 outside it) |
| `waveform` | `true` adds **`X-Audio-Waveform`** to the answer (below). Default `false`; the header `X-Want-Waveform: 1` asks the same |
| `model` | Ignored. There is one model, and OpenAI clients send `tts-1`, `tts-1-hd` or `gpt-4o-mini-tts`; refusing those would break them for nothing |

The answer is the audio, with its `Content-Type` (`audio/ogg`, `audio/mpeg`,
`audio/wav`, `audio/flac`, `audio/pcm`) and **`X-Audio-Duration-Ms`**, which a
Matrix voice note needs in its `info.duration`. Asked for, **`X-Audio-Waveform`**
is 60 comma-separated loudness values, 0 to 1024 (RMS of 60 equal slices of the
audio, loudest slice = 1024, computed from the PCM before encoding): the
`waveform` of MSC3246 (`org.matrix.msc1767.audio`), which Element and
Supermessage draw as the voice note's bars. The hub asks for it because it
cannot decode Opus cheaply; a client that does not ask gets exactly what it
got before. Errors are
`{"detail": "..."}`: 400 for a bad request (not FastAPI's 422, to match
OpenAI), 401, 413, 503 with `Retry-After` when the queue is full, 504 past
the deadline.

**`GET /v1/voices`**: the 28 English voices with `id`, `name`, `accent` (US or
UK), `gender`, `grade` (the overall grade from Kokoro's
[VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md))
and `preview_url`; plus `default` and the OpenAI `aliases`.

**`GET /v1/voices/{id}/preview`**: a few seconds of that voice introducing
itself, as Ogg/Opus. Made on first request, then served from the cache.

**`GET /health`**: `{"ok", "model", "loaded", "queue": {"running", "waiting", "max_waiting"}}`.

### Voices

`af_*` / `am_*` are American female and male, `bf_*` / `bm_*` British. The
best-graded are `af_heart` (A), `af_bella` (A-), `af_nicole` and `bf_emma`
(B-).

**OpenAI names** map to the best-graded voice of the same character, not to
Kokoro's voices of the same name (those grade C and D):

| OpenAI | Kokoro |
|---|---|
| `alloy` | `af_heart` |
| `echo` | `am_michael` |
| `fable` | `bm_george` |
| `onyx` | `am_fenrir` |
| `nova` | `af_bella` |
| `shimmer` | `af_nicole` |

**Blends**: `af_heart:60+af_bella:40` mixes the voices' style vectors. Up to
four voices; weights are optional (`af_heart+af_bella` is even), must be above
zero, and are normalised to sum to 1. OpenAI names work as parts. All 28 are
English, so US and UK voices may be mixed; the accent (en-us or en-gb) comes
from the first voice.

### One at a time

One synthesis runs at a time: ONNX Runtime already uses six threads, and the
transcriber shares the CPU. Up to `SPEECH_QUEUE` (8) more wait their turn;
beyond that a request gets 503 at once. A request that is still waiting, or
still speaking, `SPEECH_TIMEOUT` (120 s) after it arrived gets 504; synthesis
stops between sentences.

Text is normalised, split into sentences, and each sentence synthesised in
turn, with 0.25 s between sentences and 0.5 s between paragraphs (list items,
table rows). The generator in `server.speak` yields each sentence's audio as
it is made, so a streaming endpoint can be added without changing it.

The service logs voice, format, lengths and timings, never the text: it is
someone's message.

## The normaliser (`speech_text.py`)

`to_speech(text, lang="en")` makes an agent's reply speakable, in three stages:

1. **Formatting.** Emphasis, headers, blockquotes and table pipes go; list
   items, table rows and `**Label:** value` lines become sentences of their
   own. A fenced code block becomes "I've included a code snippet in the
   message." (once per block). Inline code is read without backticks, as words
   (`create_app()` is "create app"), unless it is a JSON-like soup ("some
   code"). `[text](url)` is its text; a bare URL is "a link to github dot com";
   a path is its file name ("voice dot ts") or "a file path"; emoji go; "!!!"
   is "!", "???" is "?".
2. **What the grammar misses or misreads**: i.e., e.g., etc., vs., approx.,
   a.k.a., incl., w/, w/o, and/or; and "10x", "1-2 hours", "20k", "$5.99",
   "1,284", "per month", "1990s", "24/7", "50/50", "~5", "<5 ms",
   "+250/-80", "v0.1.76", "Mon.", "(a1b2c3d)". Each is a rule with its
   reason next to it in `_BEFORE_GRAMMAR`.
3. **WeTextProcessing** (Apache-2.0; rule-based grammars, not a model):
   numbers, dates, times, money, percentages and measures.

Then `split_sentences` cuts the result into sentences, not breaking after
titles or initials ("St.", "J."), and cutting a sentence over 300 characters
at a comma.

**What it cannot do.** It has no idea what the text means, so:

- Ambiguous abbreviations are read one way: "5 m" is always five *minutes*,
  never metres; "St." is left for Kokoro (street or saint).
- Identifiers and code are read literally or not at all: `hermes:analyst-echo`
  stays as written, `git rebase -i` is read out, a long flag becomes "some
  code". camelCase is not split.
- Commit hashes are dropped only in parentheses; elsewhere they are read
  character by character. IP addresses are read digit by digit.
- "Yes/no" and other word/word pairs keep their slash; phone numbers and
  measures with unusual units come out however WeTextProcessing reads them.
- Anything WeTextProcessing gets wrong that no rule here catches.

**When a reply is read out wrong**, add it to `tests/corpus.tsv` with the text
it should have been spoken as, watch the test fail, then fix the rule.
`tests/corpus.tsv` holds realistic agent replies and exactly what is spoken for
each; the unit tests in `tests/test_speech_text.py` pin one rule each.

**Hindi** is not offered (no Hindi voices are exposed). `to_speech(text,
lang="hi")` exists for later: it does the formatting stage, turns the danda
"।" into "." (Kokoro's phonemiser drops the danda, and the pause with it), and
skips the English grammar.

## Tests

WeTextProcessing depends on pynini, which has wheels for Linux x86-64 only,
so the tests run on Linux (CI, or foundry), not on a Mac:

```sh
uv venv -p 3.12 .venv && VIRTUAL_ENV=.venv uv pip install -r tests/requirements.txt
.venv/bin/python -m pytest                    # normaliser + API, Kokoro faked
SPEECH_MODEL=kokoro-v1.0.onnx SPEECH_VOICES=voices-v1.0.bin \
  .venv/bin/python -m pytest -m slow          # the real model
```

CI runs the first on every change under `deploy/speech`
(`.github/workflows/speech.yml`).

## Licences

Kokoro-82M weights: Apache-2.0. kokoro-onnx: MIT. ONNX Runtime: MIT.
WeTextProcessing: Apache-2.0. soundfile: BSD-3-Clause, with libsndfile, Opus,
LAME and mpg123 (LGPL) inside its wheel. kokoro-onnx also brings **phonemizer
and espeak-ng, both GPL-3.0**, loaded into this service's process. That is one
reason this is a separate network service on foundry rather than part of the
hub: nothing AgentPod ships links them. Keep it that way, or take advice before
bundling the service into anything distributed.
