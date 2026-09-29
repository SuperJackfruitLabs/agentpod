"""Shared harness for the English TTS benchmark on foundry.

Each model adapter calls run(name, load_fn, synth_fn, sr, stream_fn=None, meta={}).
  load_fn()        -> builds the model (timed as load time)
  synth_fn(text)   -> 1-D float numpy array at `sr` (whole utterance)
  stream_fn(text)  -> iterator of 1-D float numpy chunks (native streaming);
                      if None, the harness synthesises sentence by sentence.
Usage: python run_<model>.py [bench|contention] [label]
"""
import os
import sys

THREADS = int(os.environ.get("TTS_THREADS", "12"))
for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ.setdefault(var, str(THREADS))
os.environ.setdefault("HF_HOME", "/root/tts-bench-en/hf")

import json
import re
import resource
import time

import numpy as np
import soundfile as sf

ROOT = "/root/tts-bench-en"
TEXTS = {
    "short": "The quarterly review has moved to Thursday afternoon.",
    "para": (
        "Quick update on the migration before tomorrow's standup. The staging database finished "
        "copying overnight and the row counts match, so I think we are clear to point the read "
        "replicas at it this afternoon. Two things are still open. First, the nightly export job "
        "still writes to the old bucket. Second, we have not tested a failover under real load. "
        "I suggest we flip the export first, watch it for a day, and schedule the failover drill "
        "for Friday morning."
    ),
    "tricky": (
        "Dr. Smith's API returned HTTP 503 at 3:45 p.m. on 29/09/2026 — roughly $1,250 of "
        "retries, i.e. 12.5% of the budget."
    ),
}


def split_sentences(text):
    return [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]


def patch_onnxruntime(threads=THREADS):
    """Force intra-op threads on every ORT session a library creates."""
    import onnxruntime as ort

    orig = ort.InferenceSession

    class Patched(orig):
        def __init__(self, path_or_bytes, sess_options=None, *a, **kw):
            so = sess_options or ort.SessionOptions()
            so.intra_op_num_threads = threads
            super().__init__(path_or_bytes, so, *a, **kw)

    ort.InferenceSession = Patched


def peak_rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def _as_mono(a):
    a = np.asarray(a, dtype=np.float32)
    if a.ndim > 1:
        # (channels, samples) or (samples, channels)
        a = a.mean(axis=0) if a.shape[0] < a.shape[-1] else a.mean(axis=1)
    return a.reshape(-1)


def _timed_stream(it_factory, text):
    t = time.perf_counter()
    first = None
    n = 0
    for chunk in it_factory(text):
        c = _as_mono(chunk)
        if first is None and c.size:
            first = time.perf_counter() - t
        n += c.size
    return first, time.perf_counter() - t, n


TAG = os.environ.get("RESULT_TAG", "")


def run(name, load_fn, synth_fn, sr, stream_fn=None, meta=None, warm_text="Warming up the model now."):
    mode = sys.argv[1] if len(sys.argv) > 1 else "bench"
    label = sys.argv[2] if len(sys.argv) > 2 else ""
    out = {"model": name, "threads": THREADS, "sr": sr, "meta": meta or {}}
    t = time.perf_counter()
    load_fn()
    out["load_s"] = round(time.perf_counter() - t, 2)
    if callable(sr):
        sr = sr()
    out["sr"] = sr
    synth_fn(warm_text)
    synth_fn(warm_text)

    if mode == "contention":
        # Idle runs first, then keep synthesising the paragraph while a 5-minute transcription
        # runs against the live transcriber.
        import subprocess
        idle = []
        for _ in range(2):
            t = time.perf_counter()
            a = _as_mono(synth_fn(TEXTS["para"]))
            idle.append(time.perf_counter() - t)
        stt = subprocess.Popen(["bash", f"{ROOT}/bench/stt_long.sh"], stdout=subprocess.PIPE, text=True)
        time.sleep(2)
        runs = []
        while stt.poll() is None:
            t = time.perf_counter()
            a = _as_mono(synth_fn(TEXTS["para"]))
            dt = time.perf_counter() - t
            runs.append({"synth_s": round(dt, 2), "audio_s": round(a.size / sr, 2), "rtf": round(a.size / sr / dt, 2), "overlapped": stt.poll() is None})
            print(f"[{name} contention] {runs[-1]}", flush=True)
        code, total = stt.stdout.read().split()
        full = [r for r in runs if r["overlapped"]]
        out["contention"] = {
            "idle_para_synth_s": round(min(idle), 2),
            "loaded_para_synth_s_mean": round(sum(r["synth_s"] for r in full) / max(1, len(full)), 2),
            "runs": runs,
            "stt_http": code,
            "stt_seconds": float(total),
        }
        print(f"[{name} contention] summary {({k: v for k, v in out['contention'].items() if k != 'runs'})}", flush=True)
        with open(f"{ROOT}/results/{name}_contention{('_' + label) if label else ''}.json", "w") as f:
            json.dump(out, f, indent=1)
        return

    if mode == "idle":
        # Paragraph only, best of 2 (used for thread sweeps).
        ts = []
        for _ in range(2):
            t = time.perf_counter()
            a = _as_mono(synth_fn(TEXTS["para"]))
            ts.append(time.perf_counter() - t)
        print(f"[{name} idle threads={THREADS}] para synth {min(ts):.2f}s audio {a.size / sr:.2f}s rtf {a.size / sr / min(ts):.2f}", flush=True)
        return

    for key, text in TEXTS.items():
        best = None
        for _ in range(2):
            t = time.perf_counter()
            a = _as_mono(synth_fn(text))
            dt = time.perf_counter() - t
            if best is None or dt < best[0]:
                best = (dt, a)
        dt, a = best
        peak = float(np.abs(a).max()) if a.size else 0.0
        if peak > 1.0:
            a = a / peak * 0.98
        if not TAG:  # tagged (thread-tuned) runs keep the reference WAVs untouched
            sf.write(f"{ROOT}/out/{name}_{key}.wav", a, sr, subtype="PCM_16")
        out[key] = {"audio_s": round(a.size / sr, 2), "synth_s": round(dt, 2), "rtf": round(a.size / sr / dt, 2)}
        print(f"[{name}] {key}: {out[key]}", flush=True)

    factory = stream_fn or (lambda text: (synth_fn(s) for s in split_sentences(text)))
    out["first_audio_mode"] = "native stream" if stream_fn else "sentence by sentence"
    best = None
    for _ in range(2):
        first, total, n = _timed_stream(factory, TEXTS["para"])
        if best is None or first < best[0]:
            best = (first, total, n)
    first, total, n = best
    out["stream_para"] = {"first_audio_s": round(first, 2), "total_s": round(total, 2), "audio_s": round(n / sr, 2), "rtf": round(n / sr / total, 2)}
    print(f"[{name}] para streamed ({out['first_audio_mode']}): {out['stream_para']}", flush=True)
    out["peak_rss_mb"] = round(peak_rss_mb())
    print(f"[{name}] load {out['load_s']} s, peak RSS {out['peak_rss_mb']} MB", flush=True)
    with open(f"{ROOT}/results/{name}{('_' + TAG) if TAG else ''}.json", "w") as f:
        json.dump(out, f, indent=1)
