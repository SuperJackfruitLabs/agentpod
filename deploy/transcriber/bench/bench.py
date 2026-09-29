import sys, time, json, os
from faster_whisper import WhisperModel
model_name, threads = sys.argv[1], int(sys.argv[2])
t0=time.time()
m=WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=threads)
load=time.time()-t0
refs=[l.rstrip("\n").split("\t") for l in open("refs.tsv", encoding="utf-8")]
out={"model":model_name,"threads":threads,"load_s":round(load,1),"clips":[]}
for cid,_,ref in refs:
    t=time.time()
    segs,info=m.transcribe(f"{cid}.wav", beam_size=5, vad_filter=True)
    text=" ".join(s.text.strip() for s in segs)
    out["clips"].append({"id":cid,"lang":info.language,"p":round(info.language_probability,2),"secs":round(time.time()-t,1),"text":text})
t=time.time()
segs,info=m.transcribe("long5.wav", beam_size=5, vad_filter=True)
n=sum(1 for _ in segs)
out["long5_s"]=round(time.time()-t,1)
print(json.dumps(out, ensure_ascii=False))
