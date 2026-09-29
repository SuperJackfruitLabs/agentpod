import pathlib
import sys
import threading

import numpy as np
import pytest

# The service is two flat modules next to this folder, like the transcriber.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

SAMPLE_RATE = 24000


class FakeEngine:
    """
    Stands in for Kokoro: no model, no ONNX Runtime. Every voice has a style
    array whose value is its position in the catalogue, so a blend can be
    checked by arithmetic, and a sentence becomes 10 ms of tone per character,
    so the output length says what was synthesised.
    """

    sample_rate = SAMPLE_RATE

    def __init__(self, delay: float = 0.0, gate: threading.Event | None = None, fail: bool = False):
        self.calls: list[tuple[str, np.ndarray, str, float]] = []
        self.delay = delay
        self.gate = gate
        self.fail = fail
        self.started = threading.Event()

    def style(self, voice_id: str) -> np.ndarray:
        from server import VOICES

        index = [v.id for v in VOICES].index(voice_id)
        return np.full((510, 1, 256), float(index + 1), dtype=np.float32)

    def synthesise(self, text: str, style: np.ndarray, lang: str, speed: float) -> np.ndarray:
        self.started.set()
        if self.gate is not None:
            self.gate.wait(10)
        if self.delay:
            threading.Event().wait(self.delay)
        if self.fail:
            raise RuntimeError("onnx exploded")
        self.calls.append((text, style, lang, speed))
        n = int(len(text) * SAMPLE_RATE / 100 / speed)
        t = np.arange(n) / SAMPLE_RATE
        return (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


@pytest.fixture
def engine():
    return FakeEngine()
