"""record-sink — DSH 录音面板 V1 的落盘服务（轻量，不加载任何模型）。

浏览器点击开始/结束录音（MediaRecorder，webm/opus）→ 结束后上传音频 →
本服务用 ffmpeg 转成 MP3，以结束那一秒的年月日时分秒命名（如
20260212103015.mp3）保存到输出目录（默认 <项目根的上一级>/vocal/master，
即本机 D:\\dsh_workspeace\\vocal\\master）。也接受 WAV（兼容调试）。

端点：
  GET  /api/health             -> {status, out_dir, ffmpeg}
  POST /api/record             body=任意 ffmpeg 可解码音频
                               header X-Record-Ms=录音时长(ms)
                               -> {ok, file, path, seconds, bytes}

配置（优先级从高到低）：
  输出目录 : 启动参数 --out-dir  >  环境变量 DSH_VOCAL_DIR  >  默认(见下)
  ffmpeg   : 环境变量 FFMPEG_BIN  >  PATH 中的 ffmpeg  >  已知默认安装路径
"""
from __future__ import annotations

import argparse
import os
import subprocess
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# 若 ffmpeg 不在 PATH，且未设置 FFMPEG_BIN，则回退到这个默认路径（可自行修改）。
FFMPEG_FALLBACKS = [
    Path(r"D:\ffmpeg\ffmpeg-master-latest-win64-gpl-shared\bin\ffmpeg.exe"),
]

ALLOW_ORIGINS = [
    "http://127.0.0.1:3080",
    "http://localhost:3080",
    "http://127.0.0.1:3081",
    "http://localhost:3081",
]

# 按 Content-Type 选临时文件扩展名（ffmpeg 实际按内容探测格式）。
EXT_BY_TYPE = {
    "audio/webm": ".webm",
    "video/webm": ".webm",
    "audio/wav": ".wav",
    "audio/wave": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
}


def default_out_dir() -> Path:
    """默认输出 = <项目根的上一级>/vocal/master。

    bridge/record_sink.py 的 parents: [bridge, 项目根, 工作区]。
    本机布局：D:\\dsh_workspeace\\dsh-voice-call\\bridge → D:\\dsh_workspeace\\vocal\\master。
    """
    return Path(__file__).resolve().parents[2] / "vocal" / "master"


def resolve_ffmpeg() -> Optional[Path]:
    env = os.environ.get("FFMPEG_BIN")
    if env and Path(env).is_file():
        return Path(env)
    for cand in FFMPEG_FALLBACKS:
        if cand.is_file():
            return cand
    return None


OUT_DIR = default_out_dir()
FFMPEG: Optional[Path] = resolve_ffmpeg()

app = FastAPI(title="dsh record-sink (V1)")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOW_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    return {"status": "ok", "out_dir": str(OUT_DIR), "ffmpeg": "ok" if FFMPEG else "missing"}


def wav_seconds(data: bytes) -> Optional[float]:
    """从 RIFF/WAVE 头解析时长（秒）；非 WAV 返回 None。"""
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None
    sr = ch = bits = 0
    audio = 0
    pos = 12
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        size = int.from_bytes(data[pos + 4:pos + 8], "little")
        body = data[pos + 8:pos + 8 + size]
        if cid == b"fmt " and len(body) >= 16:
            ch = int.from_bytes(body[2:4], "little")
            sr = int.from_bytes(body[4:8], "little")
            bits = int.from_bytes(body[14:16], "little")
        elif cid == b"data":
            audio = len(body)
        pos += 8 + size + (size & 1)
    if sr <= 0 or ch <= 0 or bits <= 0:
        return None
    return audio / (sr * ch * (bits // 8))


def unique_path(d: Path, stem: str, ext: str) -> Path:
    cand = d / f"{stem}{ext}"
    if not cand.exists():
        return cand
    i = 2
    while True:
        cand = d / f"{stem}_{i}{ext}"
        if not cand.exists():
            return cand
        i += 1


@app.post("/api/record")
async def record(request: Request) -> JSONResponse:
    body = await request.body()
    if len(body) < 256:
        return JSONResponse({"ok": False, "error": "empty or too-small payload"}, status_code=400)
    if FFMPEG is None:
        return JSONResponse(
            {"ok": False, "error": "ffmpeg not found — set FFMPEG_BIN"},
            status_code=500,
        )

    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    ext = EXT_BY_TYPE.get(content_type, ".bin")

    # 时长：WAV 从头解析；其他格式用浏览器上报的 X-Record-Ms。
    seconds = wav_seconds(body)
    if seconds is None:
        try:
            ms = int(request.headers.get("x-record-ms", "0"))
        except ValueError:
            ms = 0
        seconds = ms / 1000.0
    if seconds <= 0:
        seconds = 0.0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp_dir = OUT_DIR / ".tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    stamp = time.strftime("%Y%m%d%H%M%S")  # 文件名 = 结束那一秒（年月日时分秒）
    out = unique_path(OUT_DIR, stamp, ".mp3")
    src = tmp_dir / f"{out.stem}{ext}"
    try:
        src.write_bytes(body)
        proc = subprocess.run(
            [
                str(FFMPEG), "-y",
                "-i", str(src),
                "-ac", "1",
                "-codec:a", "libmp3lame",
                "-q:a", "4",
                str(out),
            ],
            capture_output=True,
            timeout=120,
        )
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"ffmpeg failed: {err}"}, status_code=500)
    finally:
        try:
            src.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass

    if proc.returncode != 0:
        tail = (proc.stderr or b"").decode("utf-8", "ignore")[-400:]
        return JSONResponse(
            {"ok": False, "error": f"ffmpeg exit {proc.returncode}: {tail}"},
            status_code=500,
        )

    return JSONResponse({
        "ok": True,
        "file": out.name,
        "path": str(out),
        "seconds": round(seconds, 2),
        "bytes": out.stat().st_size,
    })


def main() -> None:
    global OUT_DIR  # noqa: PLW0603
    parser = argparse.ArgumentParser(description="DSH record-sink (V1)")
    parser.add_argument("--out-dir", help="MP3 输出目录（默认 DSH_VOCAL_DIR 或 ../vocal/master）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()

    if args.out_dir:
        OUT_DIR = Path(args.out_dir)
    elif os.environ.get("DSH_VOCAL_DIR"):
        OUT_DIR = Path(os.environ["DSH_VOCAL_DIR"])

    import uvicorn

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[record-sink] out_dir={OUT_DIR}")
    print(f"[record-sink] ffmpeg={'ok: ' + str(FFMPEG) if FFMPEG else 'MISSING'}")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
