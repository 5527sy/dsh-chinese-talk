#!/usr/bin/env python
"""try_roundtrip — 端到端冒烟：TTS 合成 → 把产物回送 STT 识别。"""
import json
import math
import sys
import urllib.request

BRIDGE = "http://127.0.0.1:8765"


def tts(text, out):
    req = urllib.request.Request(
        BRIDGE + "/api/tts",
        data=json.dumps({"text": text}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=900) as resp:
        wav = resp.read()
    with open(out, "wb") as f:
        f.write(wav)
    print(f"TTS-OK: saved {out} ({len(wav)} bytes)")
    return out


def stt(path):
    import soundfile as sf

    data, sr = sf.read(path, dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != 16000:
        from scipy.signal import resample_poly

        g = math.gcd(int(sr), 16000)
        data = resample_poly(data, up=16000 // g, down=sr // g)
    pcm = (data * 32767.0).astype("<i2").tobytes()
    req = urllib.request.Request(
        BRIDGE + "/api/stt",
        data=pcm,
        headers={"Content-Type": "application/octet-stream", "X-Max-Audio-Sec": "60"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    text = (body.get("text") or "").strip()
    print("STT-OK:", repr(text))
    return text


def main():
    text = "你好，我是用你的声音克隆出来的测试朗读，现在验证一遍声音桥的合成与识别回路。"
    wav = tts(text, "try_roundtrip.wav")
    hyp = stt(wav)
    print("ROUNDTRIP-VERIFIED" if hyp else "UNDERSTOOD-NOTHING")


if __name__ == "__main__":
    sys.exit(main())
