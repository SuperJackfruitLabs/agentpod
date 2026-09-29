import asyncio
import sys
import time

from kokoro_onnx import Kokoro

PARA = (
    "Quick update on the migration before tomorrow's standup. The staging database finished "
    "copying overnight and the row counts match, so I think we are clear to point the read "
    "replicas at it this afternoon. Two things are still open. First, the nightly export job "
    "still writes to the old bucket. Second, we have not tested a failover under real load. "
    "I suggest we flip the export first, watch it for a day, and schedule the failover drill "
    "for Friday morning."
)
label = sys.argv[1] if len(sys.argv) > 1 else "idle"
k = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
k.create("warm up.", voice="af_heart", lang="en-us")


async def main():
    t = time.time()
    first = None
    audio = 0.0
    import re
    for sentence in re.split(r"(?<=[.!?])\s+", PARA):
        samples, sr = k.create(sentence, voice="af_heart", speed=1.0, lang="en-us")
        if first is None:
            first = time.time() - t
        audio += len(samples) / sr
    total = time.time() - t
    print(f"[{label}] sentence by sentence: first audio after {first:.2f}s, whole {audio:.1f}s of audio in {total:.2f}s (x{audio / total:.1f})", flush=True)


asyncio.run(main())
