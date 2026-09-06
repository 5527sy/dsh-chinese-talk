#!/usr/bin/env python
"""smoke_stt — 冒烟：把一段音频 POST 到本地桥 /api/stt，打印识别文本。

用法（项目根目录、venv 激活状态下）：
  venv-speech\\Scripts\\python.exe bridge\\smoke_stt.py --file 你的中文录音.wav
  venv-speech\\Scripts\\python.exe bridge\\smoke_stt.py --text "对着麦克风说一句" --record 5
"""
import argparse
import sys
import urllib.error
import urllib.request

DEFAULT_BRIDGE = "http://127.0.0.1:8765"


def read_audio(path: str) -> tuple[bytes, str]:
    import soundfile as sf
    import io

    data, sr = sf.read(path, dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != 16000:
        from scipy.signal import resample_poly
        import math

        g = math.gcd(int(sr), 16000)
        data = resample_poly(data, up=16000 // g, down=sr // g)
    pcm = (data * 32767.0).astype("<i2").tobytes()
    return pcm, "application/octet-stream"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bridge", default=DEFAULT_BRIDGE)
    ap.add_argument("--file", default=None, help="音频文件（wav/mp3 等 soundfile 可读格式）")
    args = ap.parse_args()
    if not args.file:
        ap.error("需要 --file")
    pcm, ctype = read_audio(args.file)
    req = urllib.request.Request(
        f"{args.bridge}/api/stt",
        data=pcm,
        headers={"Content-Type": ctype, "X-Max-Audio-Sec": "60"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        print(f"[ERROR] {exc.code}: {exc.read().decode('utf-8', 'ignore')}")
        return 1
    import json

    result = json.loads(body)
    text = (result.get("text") or "").strip()
    print(f"识别结果: {text!r}" if text else "(空，未识别到语音)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
