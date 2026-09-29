"""
The real model, end to end. Slow and needs the model files, so it is not
part of the default run (see pytest.ini); on foundry:

    SPEECH_MODEL=/root/tts-bench/kokoro-v1.0.onnx \
    SPEECH_VOICES=/root/tts-bench/voices-v1.0.bin \
    .venv/bin/python -m pytest -m slow
"""

import io
import os
import pathlib

import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import server

pytestmark = pytest.mark.slow

MODEL = os.environ.get("SPEECH_MODEL", "kokoro-v1.0.onnx")
VOICES = os.environ.get("SPEECH_VOICES", "voices-v1.0.bin")


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    if not (pathlib.Path(MODEL).exists() and pathlib.Path(VOICES).exists()):
        pytest.skip("Kokoro model files not present")
    engine = server.KokoroEngine(MODEL, VOICES, threads=6)
    app = server.create_app(engine=engine, token="t", cache_dir=tmp_path_factory.mktemp("cache"))
    with TestClient(app) as c:
        yield c


def test_the_tricky_line_as_a_voice_note(client):
    text = (
        "Dr. Smith's API returned HTTP 503 at 3:45 p.m. on 29/09/2026 — roughly $1,250 of "
        "retries, i.e. 12.5% of the budget."
    )
    r = client.post("/v1/audio/speech", json={"input": text, "voice": "af_heart"}, headers={"Authorization": "Bearer t"})
    assert r.status_code == 200
    info = sf.info(io.BytesIO(r.content))
    assert (info.format, info.subtype) == ("OGG", "OPUS")
    audio, rate = sf.read(io.BytesIO(r.content))
    seconds = len(audio) / rate
    # The normalised line is ~40 words; at a speaking pace that is 10-25 s.
    assert 10 < seconds < 25
    assert abs(seconds * 1000 - int(r.headers["x-audio-duration-ms"])) < 30


def test_a_blend_differs_from_its_parts(client):
    def pcm(voice):
        r = client.post(
            "/v1/audio/speech",
            json={"input": "The quarterly review has moved.", "voice": voice, "response_format": "pcm"},
            headers={"Authorization": "Bearer t"},
        )
        assert r.status_code == 200
        return r.content

    assert pcm("af_heart:50+am_michael:50") not in (pcm("af_heart"), pcm("am_michael"))
