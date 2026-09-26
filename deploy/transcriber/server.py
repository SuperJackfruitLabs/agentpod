"""
AgentPod transcriber: speech to text for voice notes sent into bridged rooms.

An OpenAI-compatible `POST /v1/audio/transcriptions`, so the hub has one
client for this and for any hosted provider that speaks the same API
(OpenAI, Groq, ...). Runs faster-whisper's batched pipeline on CPU.

Why these choices (benchmarked on foundry, 2026-09-26, Ryzen 5 3600, no GPU):
- `large-v3-turbo`, not `small`: `small` dropped whole sentences of Hindi and
  Thai and was no faster on long audio. Turbo was near-exact across ten
  languages.
- Batched: a 5-minute note in ~82 s instead of ~200 s. Short notes take ~13 s
  either way (the model always encodes a 30-second window).
- One transcription at a time: a second request waits for the first rather
  than halving both.

Configuration (environment):
  TRANSCRIBER_TOKEN     bearer token the hub sends; required
  TRANSCRIBER_HOST      address to listen on (a Tailscale address, never 0.0.0.0)
  TRANSCRIBER_PORT      default 8840
  TRANSCRIBER_MODEL     default large-v3-turbo
  TRANSCRIBER_THREADS   default 6
  TRANSCRIBER_BATCH     default 8
  TRANSCRIBER_MAX_SECONDS  default 300 (the 5-minute cap)
"""

import asyncio
import hmac
import io
import os
import time

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from faster_whisper import BatchedInferencePipeline, WhisperModel
from faster_whisper.audio import decode_audio

TOKEN = os.environ["TRANSCRIBER_TOKEN"]
MODEL_NAME = os.environ.get("TRANSCRIBER_MODEL", "large-v3-turbo")
THREADS = int(os.environ.get("TRANSCRIBER_THREADS", "6"))
BATCH = int(os.environ.get("TRANSCRIBER_BATCH", "8"))
MAX_SECONDS = float(os.environ.get("TRANSCRIBER_MAX_SECONDS", "300"))
SAMPLE_RATE = 16000

model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=THREADS)
pipeline = BatchedInferencePipeline(model=model)
lock = asyncio.Lock()
app = FastAPI(title="agentpod-transcriber")


def check_token(authorization: str | None) -> None:
    expected = f"Bearer {TOKEN}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": MODEL_NAME}


def run(audio_bytes: bytes, language: str | None) -> dict:
    audio = decode_audio(io.BytesIO(audio_bytes), sampling_rate=SAMPLE_RATE)
    duration = len(audio) / SAMPLE_RATE
    if duration > MAX_SECONDS + 1:
        raise HTTPException(status_code=413, detail=f"audio is {duration:.0f}s; the limit is {MAX_SECONDS:.0f}s")
    started = time.time()
    segments, info = pipeline.transcribe(audio, batch_size=BATCH, language=language or None)
    text = " ".join(s.text.strip() for s in segments).strip()
    return {
        "text": text,
        "language": info.language,
        "duration": round(duration, 2),
        "elapsed": round(time.time() - started, 2),
    }


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form(MODEL_NAME),
    language: str | None = Form(None),
    response_format: str = Form("json"),
    authorization: str | None = Header(None),
) -> dict:
    check_token(authorization)
    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="empty file")
    async with lock:
        try:
            return await asyncio.to_thread(run, audio_bytes, language)
        except HTTPException:
            raise
        except Exception as err:  # undecodable audio, mostly
            raise HTTPException(status_code=422, detail=f"could not transcribe: {err}") from err
