"""
AgentPod speech: text to speech for agents' spoken replies (voice notes).

An OpenAI-compatible `POST /v1/audio/speech`, so the hub, Hermes and OpenClaw
each need only their existing OpenAI speech client pointed here. Kokoro-82M
(kokoro-onnx, fp32) on CPU, after `speech_text.to_speech` has turned the
reply's markdown, numbers and abbreviations into words.

Why these choices (benchmarked on foundry, 2026-09-29, Ryzen 5 3600, no GPU;
deploy/speech/BENCHMARK.md has the numbers):
- Kokoro, chosen by ear over Supertonic 3, Pocket TTS, Soprano, Kitten,
  MOSS-TTS-Nano and NeuTTS Air. ~3.9x realtime, ~1.45 GB.
- fp32 on 6 threads: 12 threads is slower on six physical cores, and int8 is
  3-4x slower on a CPU without VNNI.
- Normalised first (WeTextProcessing): Kokoro paused inside "p.m." and read
  dates digit by digit; spelled-out text fixed both.
- Sentence by sentence: the first sentence is ready in ~0.8 s, and a
  streaming endpoint can later send each one as it comes.
- One synthesis at a time, behind a short queue: the transcriber shares the
  CPU, and a second synthesis would only halve both.

Configuration (environment):
  SPEECH_TOKEN       bearer token clients send; required
  SPEECH_HOST        address to listen on (a Tailscale address, never 0.0.0.0)
  SPEECH_PORT        default 8841
  SPEECH_MODEL       default kokoro-v1.0.onnx (relative to the working directory)
  SPEECH_VOICES      default voices-v1.0.bin
  SPEECH_THREADS     default 6
  SPEECH_QUEUE       requests that may wait behind the running one; default 8
  SPEECH_TIMEOUT     seconds a request may take, waiting included; default 120
  SPEECH_CACHE_DIR   voice previews; default ./cache

Run with `uvicorn server:create_app --factory`; nothing loads at import.
"""

from __future__ import annotations

import asyncio
import dataclasses
import hmac
import io
import logging
import math
import os
import pathlib
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager
from typing import Protocol

import numpy as np
import soundfile as sf
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict

import speech_text

log = logging.getLogger("agentpod.speech")

SAMPLE_RATE = 24000
MAX_INPUT_CHARS = 4096  # OpenAI's limit for /v1/audio/speech
MIN_SPEED, MAX_SPEED = 0.5, 2.0  # what Kokoro accepts
SENTENCE_GAP = 0.25  # seconds of silence between sentences
PARAGRAPH_GAP = 0.5  # ... and between paragraphs (list items, table rows)
MAX_BLEND_PARTS = 4
DEFAULT_VOICE = "af_heart"
PREVIEW_TEXT = "Hi, I'm {name}. This is how I sound when I read your messages aloud."
WAVEFORM_POINTS = 60  # amplitudes in X-Audio-Waveform; clients resample to their width


# --- voices -------------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class Voice:
    id: str
    grade: str  # overall grade from hexgrad/Kokoro-82M VOICES.md

    @property
    def name(self) -> str:
        return self.id.split("_", 1)[1].capitalize()

    @property
    def accent(self) -> str:
        return "US" if self.id[0] == "a" else "UK"

    @property
    def lang(self) -> str:
        return "en-us" if self.id[0] == "a" else "en-gb"

    @property
    def gender(self) -> str:
        return "female" if self.id[1] == "f" else "male"


# The 28 English voices in voices-v1.0.bin, graded as in Kokoro's VOICES.md.
VOICES: list[Voice] = [
    Voice(id, grade)
    for id, grade in [
        ("af_heart", "A"),
        ("af_bella", "A-"),
        ("af_nicole", "B-"),
        ("af_aoede", "C+"),
        ("af_kore", "C+"),
        ("af_sarah", "C+"),
        ("af_alloy", "C"),
        ("af_nova", "C"),
        ("af_sky", "C-"),
        ("af_jessica", "D"),
        ("af_river", "D"),
        ("am_fenrir", "C+"),
        ("am_michael", "C+"),
        ("am_puck", "C+"),
        ("am_echo", "D"),
        ("am_eric", "D"),
        ("am_liam", "D"),
        ("am_onyx", "D"),
        ("am_santa", "D-"),
        ("am_adam", "F+"),
        ("bf_emma", "B-"),
        ("bf_isabella", "C"),
        ("bf_alice", "D"),
        ("bf_lily", "D"),
        ("bm_george", "C"),
        ("bm_fable", "C"),
        ("bm_lewis", "D+"),
        ("bm_daniel", "D"),
    ]
]
_BY_ID = {v.id: v for v in VOICES}

# OpenAI's voice names, so a client configured for OpenAI works unchanged.
# Kokoro has voices with some of these names, but they grade C or D; these
# are the best-graded voices of the same character instead.
OPENAI_VOICES = {
    "alloy": "af_heart",  # neutral, OpenAI's default
    "echo": "am_michael",  # male
    "fable": "bm_george",  # British male
    "onyx": "am_fenrir",  # deep male
    "nova": "af_bella",  # bright female
    "shimmer": "af_nicole",  # soft female
}


class VoiceError(ValueError):
    pass


def parse_voice(spec: str) -> tuple[list[tuple[str, float]], str]:
    """
    A voice or a blend ("af_heart:60+af_bella:40") into (voice id, weight)
    parts with weights summing to 1, and the language, taken from the first
    part. Weights are optional ("af_heart+af_bella" is an even blend).
    """
    parts = [p.strip() for p in spec.split("+")]
    if not spec.strip() or any(not p for p in parts):
        raise VoiceError(f"empty voice in {spec!r}")
    if len(parts) > MAX_BLEND_PARTS:
        raise VoiceError(f"a blend has at most {MAX_BLEND_PARTS} voices")
    weighted: list[tuple[str, float]] = []
    for part in parts:
        name, _, weight = part.partition(":")
        voice_id = OPENAI_VOICES.get(name.strip().lower(), name.strip())
        if voice_id not in _BY_ID:
            raise VoiceError(f"unknown voice {name.strip()!r}")
        try:
            w = float(weight) if weight else 1.0
        except ValueError:
            raise VoiceError(f"weight {weight!r} is not a number") from None
        if not math.isfinite(w) or w <= 0:
            raise VoiceError(f"weight {weight!r} must be above zero")
        if any(voice_id == v for v, _ in weighted):
            raise VoiceError(f"{voice_id} appears twice")
        weighted.append((voice_id, w))
    total = sum(w for _, w in weighted)
    return [(v, w / total) for v, w in weighted], _BY_ID[weighted[0][0]].lang


# --- synthesis ---------------------------------------------------------------------------------


class Engine(Protocol):
    sample_rate: int

    def style(self, voice_id: str) -> np.ndarray: ...

    def synthesise(self, text: str, style: np.ndarray, lang: str, speed: float) -> np.ndarray: ...


class KokoroEngine:
    """Kokoro-82M through kokoro-onnx, on an ONNX Runtime session we size."""

    sample_rate = SAMPLE_RATE

    def __init__(self, model_path: str, voices_path: str, threads: int = 6):
        import onnxruntime as ort
        from kokoro_onnx import Kokoro

        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(model_path, sess_options=options, providers=["CPUExecutionProvider"])
        self._kokoro = Kokoro.from_session(session, voices_path)

    def style(self, voice_id: str) -> np.ndarray:
        return self._kokoro.get_voice_style(voice_id)

    def synthesise(self, text: str, style: np.ndarray, lang: str, speed: float) -> np.ndarray:
        samples, _ = self._kokoro.create(text, voice=style, speed=speed, lang=lang)
        return np.asarray(samples, dtype=np.float32)


class DeadlineExceeded(Exception):
    pass


def speak(
    engine: Engine,
    sentences: list[tuple[str, bool]],
    parts: list[tuple[str, float]],
    lang: str,
    speed: float,
    deadline: float,
) -> Iterator[np.ndarray]:
    """
    Audio for each sentence in turn, each followed by its pause (none after
    the last). A generator so a streaming endpoint can send pieces as they
    come; the deadline is checked before every sentence.
    """
    style = sum(w * engine.style(v) for v, w in parts)
    for i, (sentence, ends_paragraph) in enumerate(sentences):
        if time.monotonic() > deadline:
            raise DeadlineExceeded
        yield engine.synthesise(sentence, style, lang, speed)
        if i < len(sentences) - 1:
            gap = PARAGRAPH_GAP if ends_paragraph else SENTENCE_GAP
            yield np.zeros(int(gap * engine.sample_rate / speed), dtype=np.float32)


# --- encoding ------------------------------------------------------------------------------------

FORMATS = {
    # name: (content type, libsndfile format, subtype)
    "opus": ("audio/ogg", "OGG", "OPUS"),  # Ogg/Opus: what Matrix voice notes are (MSC3245)
    "mp3": ("audio/mpeg", "MP3", "MPEG_LAYER_III"),  # libsndfile's LAME (LGPL); no ffmpeg
    "wav": ("audio/wav", "WAV", "PCM_16"),
    "flac": ("audio/flac", "FLAC", "PCM_16"),
    "pcm": ("audio/pcm", None, None),  # raw signed 16-bit little-endian, 24 kHz mono
}


def encode(audio: np.ndarray, sample_rate: int, fmt: str) -> bytes:
    audio = np.clip(audio, -1.0, 1.0)
    content_type, container, subtype = FORMATS[fmt]
    if container is None:
        return (audio * 32767).astype("<i2").tobytes()
    out = io.BytesIO()
    sf.write(out, audio, sample_rate, format=container, subtype=subtype)
    return out.getvalue()


def waveform(audio: np.ndarray, points: int = WAVEFORM_POINTS) -> list[int]:
    """
    The loudness of `points` equal slices of the audio, 0..1024, loudest = 1024:
    the MSC3246 `waveform` a Matrix voice message carries, so Element and
    Supermessage draw the bars without decoding Opus. RMS per slice, from the
    PCM before encoding. Silence (or no audio) is all zeros.
    """
    n = len(audio)
    if n == 0:
        return [0] * points
    edges = np.linspace(0, n, points + 1).astype(int)
    levels = []
    for i in range(points):
        start = min(edges[i], n - 1)
        seg = audio[start : max(edges[i + 1], start + 1)]
        levels.append(float(np.sqrt(np.mean(np.square(seg, dtype=np.float64)))))
    peak = max(levels)
    if peak <= 1e-6:
        return [0] * points
    return [min(1024, max(0, round(level / peak * 1024))) for level in levels]


# --- one at a time ---------------------------------------------------------------------------------


class Busy(Exception):
    pass


class Queue:
    """
    One synthesis runs; up to `max_waiting` more wait their turn, in order.
    Beyond that a request is refused at once rather than left to time out.
    """

    def __init__(self, max_waiting: int):
        self.max_waiting = max_waiting
        self.waiting = 0
        self.running = 0
        self._lock = asyncio.Lock()

    def depth(self) -> dict:
        return {"running": self.running, "waiting": self.waiting, "max_waiting": self.max_waiting}

    async def run(self, fn, deadline: float):
        if self._lock.locked() and self.waiting >= self.max_waiting:
            raise Busy
        self.waiting += 1
        try:
            await asyncio.wait_for(self._lock.acquire(), timeout=max(0.0, deadline - time.monotonic()))
        except TimeoutError:
            raise DeadlineExceeded from None
        finally:
            self.waiting -= 1
        self.running = 1
        try:
            return await asyncio.to_thread(fn)
        finally:
            self.running = 0
            self._lock.release()


# --- HTTP -------------------------------------------------------------------------------------------


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    input: str
    # Ignored: there is one model. OpenAI clients send tts-1, tts-1-hd or
    # gpt-4o-mini-tts, and refusing those would break them for nothing.
    model: str | None = None
    voice: str = DEFAULT_VOICE
    response_format: str = "opus"
    speed: float = 1.0
    # Opt-in: answer with X-Audio-Waveform (see `waveform`). The header
    # `X-Want-Waveform: 1` asks the same, for a client that cannot add fields.
    waveform: bool = False


def create_app(
    engine: Engine | None = None,
    token: str | None = None,
    cache_dir: str | os.PathLike | None = None,
    queue_size: int | None = None,
    timeout: float | None = None,
) -> FastAPI:
    """
    The app. Arguments left out come from the environment; without an engine,
    Kokoro loads at startup (not at import, so tests and tools can import this).
    """
    env = os.environ
    if not log.handlers:  # uvicorn configures only its own loggers
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s %(message)s"))
        log.addHandler(handler)
        log.setLevel(logging.INFO)
    token = token if token is not None else env.get("SPEECH_TOKEN", "")
    if not token:
        raise RuntimeError("SPEECH_TOKEN is not set")
    cache = pathlib.Path(cache_dir if cache_dir is not None else env.get("SPEECH_CACHE_DIR", "cache"))
    queue = Queue(queue_size if queue_size is not None else int(env.get("SPEECH_QUEUE", "8")))
    timeout = timeout if timeout is not None else float(env.get("SPEECH_TIMEOUT", "120"))
    state: dict = {"engine": engine}

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if state["engine"] is None:
            started = time.monotonic()
            state["engine"] = await asyncio.to_thread(
                KokoroEngine,
                env.get("SPEECH_MODEL", "kokoro-v1.0.onnx"),
                env.get("SPEECH_VOICES", "voices-v1.0.bin"),
                int(env.get("SPEECH_THREADS", "6")),
            )
            await asyncio.to_thread(speech_text.warm)
            # The first inference pays for graph set-up; pay it now.
            await asyncio.to_thread(
                lambda: list(speak(state["engine"], [("Ready.", True)], [(DEFAULT_VOICE, 1.0)], "en-us", 1.0, math.inf))
            )
            log.info("model loaded in %.1fs", time.monotonic() - started)
        yield

    app = FastAPI(title="agentpod-speech", lifespan=lifespan)

    @app.exception_handler(RequestValidationError)
    async def bad_request(_request: Request, err: RequestValidationError):
        # OpenAI answers a malformed request with 400, and so do we.
        fields = ", ".join(".".join(str(p) for p in e["loc"][1:]) or "body" for e in err.errors())
        return JSONResponse(status_code=400, content={"detail": f"invalid request: {fields}"})

    def check_token(authorization: str | None = Header(None)) -> None:
        expected = f"Bearer {token}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="unauthorized")

    async def synthesise(sentences, parts, lang, speed, fmt, deadline, want_waveform=False):
        eng = state["engine"]

        def work():
            started = time.monotonic()
            audio = np.concatenate(list(speak(eng, sentences, parts, lang, speed, deadline)))
            wave = waveform(np.clip(audio, -1.0, 1.0)) if want_waveform else None
            return encode(audio, eng.sample_rate, fmt), len(audio), time.monotonic() - started, wave

        try:
            return await queue.run(work, deadline)
        except Busy:
            raise HTTPException(status_code=503, detail="busy; try again shortly", headers={"Retry-After": "10"}) from None
        except DeadlineExceeded:
            raise HTTPException(status_code=504, detail=f"took longer than {timeout:g}s") from None
        except Exception as err:
            # Never echo the text: it is someone's message.
            log.error("synthesis failed: %s", type(err).__name__)
            raise HTTPException(status_code=500, detail="synthesis failed") from None

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "model": "kokoro-v1.0", "loaded": state["engine"] is not None, "queue": queue.depth()}

    # The token is a dependency so it is checked before the body is.
    authorised = [Depends(check_token)]

    @app.post("/v1/audio/speech", dependencies=authorised)
    async def speech(body: SpeechRequest, x_want_waveform: str | None = Header(None)) -> Response:
        received = time.monotonic()
        deadline = received + timeout
        if not body.input.strip():
            raise HTTPException(status_code=400, detail="input is empty")
        if len(body.input) > MAX_INPUT_CHARS:
            raise HTTPException(status_code=413, detail=f"input is {len(body.input)} characters; the limit is {MAX_INPUT_CHARS}")
        fmt = body.response_format.lower()
        if fmt not in FORMATS:
            raise HTTPException(status_code=400, detail=f"response_format must be one of {', '.join(FORMATS)}")
        if not MIN_SPEED <= body.speed <= MAX_SPEED:
            raise HTTPException(status_code=400, detail=f"speed must be between {MIN_SPEED} and {MAX_SPEED}")
        try:
            parts, lang = parse_voice(body.voice)
        except VoiceError as err:
            raise HTTPException(status_code=400, detail=f"{err}; GET /v1/voices lists the voices") from None
        sentences = speech_text.split_sentences(await asyncio.to_thread(speech_text.to_speech, body.input))
        if not sentences:
            raise HTTPException(status_code=400, detail="input has nothing to say aloud")
        want_waveform = body.waveform or (x_want_waveform or "").strip().lower() in ("1", "true", "yes")
        data, samples, synth_s, wave = await synthesise(
            sentences, parts, lang, body.speed, fmt, deadline, want_waveform
        )
        duration_ms = round(samples * 1000 / SAMPLE_RATE)
        log.info(
            "speech voice=%s format=%s chars=%d sentences=%d audio_ms=%d synth_ms=%d total_ms=%d",
            body.voice,
            fmt,
            len(body.input),
            len(sentences),
            duration_ms,
            round(synth_s * 1000),
            round((time.monotonic() - received) * 1000),
        )
        headers = {"X-Audio-Duration-Ms": str(duration_ms)}
        if wave is not None:
            headers["X-Audio-Waveform"] = ",".join(str(x) for x in wave)
        return Response(content=data, media_type=FORMATS[fmt][0], headers=headers)

    @app.get("/v1/voices", dependencies=authorised)
    def voices() -> dict:
        return {
            "voices": [
                {
                    "id": v.id,
                    "name": v.name,
                    "accent": v.accent,
                    "gender": v.gender,
                    "grade": v.grade,
                    "preview_url": f"/v1/voices/{v.id}/preview",
                }
                for v in VOICES
            ],
            "default": DEFAULT_VOICE,
            "aliases": OPENAI_VOICES,
        }

    @app.get("/v1/voices/{voice_id}/preview", dependencies=authorised)
    async def preview(voice_id: str) -> Response:
        voice = _BY_ID.get(voice_id)
        if voice is None:
            raise HTTPException(status_code=404, detail="unknown voice; GET /v1/voices lists the voices")
        path = cache / "previews" / f"{voice.id}.ogg"
        if not path.exists():
            text = speech_text.to_speech(PREVIEW_TEXT.format(name=voice.name))
            data, _, _, _ = await synthesise(
                speech_text.split_sentences(text), [(voice.id, 1.0)], voice.lang, 1.0, "opus", time.monotonic() + timeout
            )
            path.parent.mkdir(parents=True, exist_ok=True)
            partial = path.with_suffix(".tmp")
            partial.write_bytes(data)
            partial.replace(path)
        return Response(content=path.read_bytes(), media_type="audio/ogg")

    return app
