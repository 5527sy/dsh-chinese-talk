#!/usr/bin/env python
"""smoke_tts — 冒烟：让桥用当前默认音色合成一句中文并保存为 tts_out.wav。

用法（项目根目录、venv 激活状态下）：
  venv-speech\\Scripts\\python.exe bridge\\smoke_tts.py --text "你好，我是克隆音色的测试。"

首次调用会懒加载 Qwen3-TTS 并预热，等待 10~60s 属正常；之后约秒级。
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

DEFAULT_BRIDGE = "http://127.0.0.1:8765"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bridge", default=DEFAULT_BRIDGE)
    ap.add_argument("--out", default="tts_out.wav")
    ap.add_argument("--text", default="你好，我是克隆音色的测试。")
    args = ap.parse_args()

    req = urllib.request.Request(
        f"{args.bridge}/api/tts",
        data=json.dumps({"text": args.text}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=900) as resp:
            wav = resp.read()
    except urllib.error.HTTPError as exc:
        print(f"[ERROR] {exc.code}: {exc.read().decode('utf-8', 'ignore')}")
        return 1
    with open(args.out, "wb") as f:
        f.write(wav)
    print(f"已保存 {args.out}（{len(wav)} bytes）—— 播放它确认音色像参考音频。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
