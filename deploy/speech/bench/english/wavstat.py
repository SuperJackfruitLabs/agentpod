import sys, glob, numpy as np, soundfile as sf
for p in sorted(glob.glob(sys.argv[1])):
    a, sr = sf.read(p)
    if a.ndim > 1: a = a.mean(1)
    fr = int(sr * 0.02)
    n = len(a) // fr
    e = np.sqrt((a[: n * fr].reshape(n, fr) ** 2).mean(1))
    thr = max(e.max() * 0.03, 1e-4)
    voiced = (e > thr).sum() * 0.02
    nz = np.nonzero(e > thr)[0]
    lead = nz[0] * 0.02 if len(nz) else 0; trail = (n - 1 - nz[-1]) * 0.02 if len(nz) else 0
    print(f"{p.split('/')[-1]:32s} sr={sr} dur={len(a)/sr:6.2f}s voiced={voiced:6.2f}s lead={lead:.2f} trail={trail:.2f} peak={np.abs(a).max():.2f}")
