import importlib
import pathlib
import sys
import types

import pytest

# The service is one flat module next to this folder, like the speech service.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


def _stub_faster_whisper() -> None:
    """server.py loads Whisper at import; these tests only need its web half."""

    class WhisperModel:
        def __init__(self, *args, **kwargs):
            pass

    class BatchedInferencePipeline:
        def __init__(self, *args, **kwargs):
            pass

    package = types.ModuleType("faster_whisper")
    package.WhisperModel = WhisperModel
    package.BatchedInferencePipeline = BatchedInferencePipeline
    audio = types.ModuleType("faster_whisper.audio")
    audio.decode_audio = lambda *args, **kwargs: []
    package.audio = audio
    sys.modules["faster_whisper"] = package
    sys.modules["faster_whisper.audio"] = audio


_stub_faster_whisper()


@pytest.fixture
def load_server(monkeypatch):
    """Import server.py afresh under the given environment; it reads it at import."""

    def load(token: str = "main-token", extra: str | None = None):
        monkeypatch.setenv("TRANSCRIBER_TOKEN", token)
        if extra is None:
            monkeypatch.delenv("TRANSCRIBER_EXTRA_TOKENS", raising=False)
        else:
            monkeypatch.setenv("TRANSCRIBER_EXTRA_TOKENS", extra)
        sys.modules.pop("server", None)
        return importlib.import_module("server")

    yield load
    sys.modules.pop("server", None)
