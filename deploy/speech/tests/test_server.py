"""
The HTTP service, with Kokoro replaced by FakeEngine (conftest.py). The
normaliser is the real one: what reaches the engine is what Kokoro would get.
"""

import asyncio
import io
import logging
import threading

import httpx
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import server
import speech_text
from conftest import SAMPLE_RATE, FakeEngine

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def make_app(engine, tmp_path, **kw):
    return server.create_app(engine=engine, token=TOKEN, cache_dir=tmp_path, **kw)


@pytest.fixture
def client(engine, tmp_path):
    with TestClient(make_app(engine, tmp_path)) as c:
        yield c


def speak(client, **body):
    body.setdefault("input", "Hello there.")
    return client.post("/v1/audio/speech", json=body, headers=AUTH)


def expected_samples(engine: FakeEngine, paragraph_ends: list[bool], speed: float = 1.0) -> int:
    """What the service should return: every sentence, a gap between each."""
    audio = sum(int(len(text) * SAMPLE_RATE / 100 / speed) for text, *_ in engine.calls)
    gaps = 0
    for end in paragraph_ends[:-1]:
        gaps += int((server.PARAGRAPH_GAP if end else server.SENTENCE_GAP) * SAMPLE_RATE / speed)
    return audio + gaps


# --- health and auth ---------------------------------------------------------------


def test_health_needs_no_token(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["loaded"] is True
    assert body["queue"] == {"running": 0, "waiting": 0, "max_waiting": 8}


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": TOKEN}])
def test_speech_needs_the_token(client, headers):
    r = client.post("/v1/audio/speech", json={"input": "Hi.", "voice": "af_heart"}, headers=headers)
    assert r.status_code == 401


@pytest.mark.parametrize("path", ["/v1/voices", "/v1/voices/af_heart/preview"])
def test_voice_endpoints_need_the_token(client, path):
    assert client.get(path).status_code == 401


def test_the_token_is_checked_before_the_body(client):
    assert client.post("/v1/audio/speech", json={"nonsense": 1}).status_code == 401


def test_the_service_refuses_to_start_without_a_token(monkeypatch):
    monkeypatch.delenv("SPEECH_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="SPEECH_TOKEN"):
        server.create_app(engine=FakeEngine())


# --- formats ---------------------------------------------------------------------------


def test_default_is_ogg_opus(client, engine):
    r = speak(client, voice="af_heart")
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/ogg"
    data = r.content
    assert data[:4] == b"OggS"
    assert b"OpusHead" in data[:100]
    info = sf.info(io.BytesIO(data))
    assert (info.format, info.subtype) == ("OGG", "OPUS")
    samples = expected_samples(engine, [True])
    assert int(r.headers["x-audio-duration-ms"]) == round(samples * 1000 / SAMPLE_RATE)
    decoded, rate = sf.read(io.BytesIO(data))
    assert abs(len(decoded) / rate - samples / SAMPLE_RATE) < 0.03


@pytest.mark.parametrize(
    "fmt,content_type,magic",
    [
        ("wav", "audio/wav", b"RIFF"),
        ("flac", "audio/flac", b"fLaC"),
        ("mp3", "audio/mpeg", None),
    ],
)
def test_container_formats(client, engine, fmt, content_type, magic):
    r = speak(client, voice="af_heart", response_format=fmt)
    assert r.status_code == 200
    assert r.headers["content-type"] == content_type
    if magic:
        assert r.content[:4] == magic
    decoded, rate = sf.read(io.BytesIO(r.content))
    samples = expected_samples(engine, [True])
    assert int(r.headers["x-audio-duration-ms"]) == round(samples * 1000 / SAMPLE_RATE)
    assert abs(len(decoded) / rate - samples / SAMPLE_RATE) < 0.08  # mp3 pads a frame


# --- waveform (MSC3246), opt-in -----------------------------------------------------


def waveform_of(r) -> list[int]:
    return [int(x) for x in r.headers["x-audio-waveform"].split(",")]


def test_no_waveform_unless_asked(client):
    r = speak(client)
    assert r.status_code == 200
    assert "x-audio-waveform" not in r.headers


@pytest.mark.parametrize("how", ["body", "header"])
def test_waveform_when_asked(client, how):
    if how == "body":
        r = speak(client, input="Hello there. How are you today?", waveform=True)
    else:
        r = client.post(
            "/v1/audio/speech",
            json={"input": "Hello there. How are you today?"},
            headers={**AUTH, "X-Want-Waveform": "1"},
        )
    assert r.status_code == 200
    w = waveform_of(r)
    assert len(w) == server.WAVEFORM_POINTS
    assert all(0 <= x <= 1024 for x in w)
    # Normalised: the loudest bucket is full scale.
    assert max(w) == 1024
    # The gap between the two sentences is silence, and shows as a dip.
    assert min(w) < 100


def test_waveform_shape_follows_the_audio():
    rate = 1000
    loud = np.full(rate, 0.8, dtype=np.float32)
    quiet = np.full(rate, 0.2, dtype=np.float32)
    w = server.waveform(np.concatenate([loud, quiet]), points=10)
    assert len(w) == 10
    assert w[:5] == [1024] * 5
    assert all(200 <= x <= 300 for x in w[5:])


def test_waveform_of_silence_or_very_short_audio():
    assert server.waveform(np.zeros(10_000, dtype=np.float32), points=60) == [0] * 60
    short = server.waveform(np.full(7, 0.5, dtype=np.float32), points=60)
    assert len(short) == 60 and all(0 <= x <= 1024 for x in short)
    assert server.waveform(np.zeros(0, dtype=np.float32), points=60) == [0] * 60


def test_pcm_is_raw_16_bit_little_endian_at_24_khz(client, engine):
    r = speak(client, voice="af_heart", response_format="pcm")
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/pcm"
    samples = expected_samples(engine, [True])
    assert len(r.content) == 2 * samples
    pcm = np.frombuffer(r.content, dtype="<i2")
    assert 0.25 < np.abs(pcm).max() / 32767 < 0.35  # the fake's 0.3 amplitude, not rescaled


def test_unsupported_format(client):
    r = speak(client, voice="af_heart", response_format="aac")
    assert r.status_code == 400
    assert "opus" in r.json()["detail"]


# --- request validation ------------------------------------------------------------------


def test_empty_input(client):
    assert speak(client, input="").status_code == 400


def test_input_with_nothing_to_say(client):
    r = speak(client, input="🚀 👍")
    assert r.status_code == 400
    assert "nothing" in r.json()["detail"]


def test_input_limit(client):
    assert speak(client, input="a" * 4096).status_code == 200
    r = speak(client, input="a" * 4097)
    assert r.status_code == 413
    assert "4096" in r.json()["detail"]


def test_missing_input_is_a_400_not_a_422(client):
    r = client.post("/v1/audio/speech", json={"voice": "af_heart"}, headers=AUTH)
    assert r.status_code == 400


@pytest.mark.parametrize("speed", [0.4, 2.1])
def test_speed_out_of_range(client, speed):
    r = speak(client, speed=speed)
    assert r.status_code == 400
    assert "0.5" in r.json()["detail"]


def test_speed_reaches_the_engine_and_scales_the_gaps(client, engine):
    r = speak(client, input="One. Two.", speed=2.0, response_format="pcm")
    assert r.status_code == 200
    assert [c[3] for c in engine.calls] == [2.0, 2.0]
    assert len(r.content) == 2 * expected_samples(engine, [False, True], speed=2.0)


def test_any_model_name_is_accepted(client):
    # OpenAI clients send tts-1, tts-1-hd or gpt-4o-mini-tts; there is one model here.
    for model in ("kokoro", "tts-1", "gpt-4o-mini-tts", "anything"):
        assert speak(client, model=model).status_code == 200


# --- voices --------------------------------------------------------------------------------


def test_unknown_voice_names_the_list(client):
    r = speak(client, voice="af_nobody")
    assert r.status_code == 400
    assert "/v1/voices" in r.json()["detail"]


def test_default_voice(client, engine):
    assert speak(client).status_code == 200
    _, style, lang, _ = engine.calls[0]
    assert np.allclose(style, engine.style("af_heart"))
    assert lang == "en-us"


def test_british_voice_speaks_british_english(client, engine):
    speak(client, voice="bf_emma")
    assert engine.calls[0][2] == "en-gb"


@pytest.mark.parametrize("openai,kokoro", sorted(server.OPENAI_VOICES.items()))
def test_openai_voice_names(client, engine, openai, kokoro):
    assert speak(client, voice=openai).status_code == 200
    assert np.allclose(engine.calls[0][1], engine.style(kokoro))


def test_openai_voices_cover_the_six_originals():
    assert set(server.OPENAI_VOICES) >= {"alloy", "echo", "fable", "onyx", "nova", "shimmer"}
    assert all(v in {x.id for x in server.VOICES} for v in server.OPENAI_VOICES.values())


def test_blend(client, engine):
    assert speak(client, voice="af_heart:60+af_bella:40").status_code == 200
    expected = 0.6 * engine.style("af_heart") + 0.4 * engine.style("af_bella")
    assert np.allclose(engine.calls[0][1], expected)


def test_blend_weights_are_normalised(client, engine):
    speak(client, voice="af_heart:3+af_bella:1")
    expected = 0.75 * engine.style("af_heart") + 0.25 * engine.style("af_bella")
    assert np.allclose(engine.calls[0][1], expected)


def test_blend_without_weights_is_even(client, engine):
    speak(client, voice="af_heart+am_michael")
    expected = 0.5 * engine.style("af_heart") + 0.5 * engine.style("am_michael")
    assert np.allclose(engine.calls[0][1], expected)


def test_blend_takes_its_accent_from_the_first_voice(client, engine):
    speak(client, voice="bf_emma:50+af_heart:50")
    assert engine.calls[0][2] == "en-gb"


@pytest.mark.parametrize(
    "voice",
    [
        "af_heart+af_bella+af_nicole+af_sarah+af_kore",  # five parts
        "af_heart:0+af_bella:10",
        "af_heart:-1+af_bella:2",
        "af_heart:x+af_bella:1",
        "af_heart+af_heart",
        "af_heart+",
        "af_heart+af_nobody",
    ],
)
def test_bad_blends(client, voice):
    assert speak(client, voice=voice).status_code == 400


def test_voice_list(client):
    r = client.get("/v1/voices", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    voices = {v["id"]: v for v in body["voices"]}
    assert len(voices) == 28
    assert voices["af_heart"] == {
        "id": "af_heart",
        "name": "Heart",
        "accent": "US",
        "gender": "female",
        "grade": "A",
        "preview_url": "/v1/voices/af_heart/preview",
    }
    assert voices["bm_george"]["accent"] == "UK"
    assert voices["bm_george"]["gender"] == "male"
    assert voices["am_adam"]["grade"] == "F+"
    assert body["default"] == "af_heart"
    assert body["aliases"] == server.OPENAI_VOICES


def test_every_voice_has_a_grade():
    grades = {"A", "A-", "B-", "C+", "C", "C-", "D+", "D", "D-", "F+"}
    assert all(v.grade in grades for v in server.VOICES)
    assert sorted(v.id[:2] for v in server.VOICES).count("af") == 11


def test_preview_is_generated_once_and_cached(client, engine, tmp_path):
    r = client.get("/v1/voices/bf_emma/preview", headers=AUTH)
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/ogg"
    assert r.content[:4] == b"OggS"
    calls = len(engine.calls)
    assert calls > 0
    again = client.get("/v1/voices/bf_emma/preview", headers=AUTH)
    assert again.content == r.content
    assert len(engine.calls) == calls
    assert (tmp_path / "previews" / "bf_emma.ogg").exists()


def test_preview_of_an_unknown_voice(client):
    assert client.get("/v1/voices/af_nobody/preview", headers=AUTH).status_code == 404


# --- what reaches the engine ---------------------------------------------------------------


def test_text_is_normalised_then_spoken_sentence_by_sentence(client, engine):
    r = speak(client, input="**Done.** It cost $5.\n\n- one more thing", response_format="pcm")
    assert r.status_code == 200
    assert [c[0] for c in engine.calls] == ["Done.", "It cost five dollars.", "one more thing."]
    assert len(r.content) == 2 * expected_samples(engine, [False, True, True])


# --- one at a time, a bounded queue, a deadline ------------------------------------------------


def test_queue_full_is_a_503_with_retry_after(tmp_path):
    gate = threading.Event()
    engine = FakeEngine(gate=gate)
    app = make_app(engine, tmp_path, queue_size=1)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://speech") as c:
            body = {"input": "Hello there.", "voice": "af_heart"}
            running = asyncio.create_task(c.post("/v1/audio/speech", json=body, headers=AUTH))
            await asyncio.to_thread(engine.started.wait, 5)
            waiting = asyncio.create_task(c.post("/v1/audio/speech", json=body, headers=AUTH))
            await asyncio.sleep(0.05)
            health = (await c.get("/health")).json()
            refused = await c.post("/v1/audio/speech", json=body, headers=AUTH)
            gate.set()
            return health, refused, await running, await waiting

    health, refused, first, second = asyncio.run(scenario())
    assert health["queue"] == {"running": 1, "waiting": 1, "max_waiting": 1}
    assert refused.status_code == 503
    assert int(refused.headers["retry-after"]) > 0
    assert first.status_code == 200
    assert second.status_code == 200


def test_requests_never_synthesise_at_the_same_time(tmp_path):
    engine = FakeEngine(delay=0.02)
    active = []
    overlap = []
    original = engine.synthesise

    def tracking(*a):
        active.append(1)
        overlap.append(len(active))
        try:
            return original(*a)
        finally:
            active.pop()

    engine.synthesise = tracking
    app = make_app(engine, tmp_path)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://speech") as c:
            body = {"input": "One. Two. Three.", "voice": "af_heart"}
            return await asyncio.gather(*[c.post("/v1/audio/speech", json=body, headers=AUTH) for _ in range(4)])

    results = asyncio.run(scenario())
    assert [r.status_code for r in results] == [200] * 4
    assert max(overlap) == 1


def test_deadline(tmp_path):
    speech_text.warm()  # so the deadline is spent synthesising, not loading grammars
    engine = FakeEngine(delay=0.2)
    with TestClient(make_app(engine, tmp_path, timeout=0.5)) as c:
        r = speak(c, input="One. Two. Three. Four. Five.")
    assert r.status_code == 504
    # It stopped between sentences, not before starting or after finishing.
    assert 0 < len(engine.calls) < 5


def test_engine_failure_is_a_500_without_the_text(tmp_path):
    engine = FakeEngine(fail=True)
    with TestClient(make_app(engine, tmp_path)) as c:
        r = speak(c, input="Secret plans for Friday.")
    assert r.status_code == 500
    assert "Secret" not in r.text


# --- logging --------------------------------------------------------------------------------------


def test_input_text_is_never_logged(client, caplog):
    caplog.set_level(logging.DEBUG)
    r = speak(client, input="The launch code is tangerine.", voice="bf_emma")
    assert r.status_code == 200
    everything = "\n".join(rec.getMessage() for rec in caplog.records)
    assert "tangerine" not in everything
    spoken = [rec.getMessage() for rec in caplog.records if rec.name == "agentpod.speech"]
    assert any("voice=bf_emma" in m and "chars=29" in m for m in spoken)
