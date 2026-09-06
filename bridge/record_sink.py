"""record-sink — DSH 录音面板的落盘 + 中文识别服务（轻量，模型懒加载）。

浏览器点击开始/结束录音（MediaRecorder，webm/opus）→ 结束后上传音频 →
本服务用 ffmpeg 转成 MP3，以结束那一秒的年月日时分秒命名（如
20260212103015.mp3）保存到输出目录（默认 <项目根的上一级>/vocal/master，
即本机 D:\\dsh_workspeace\\vocal\\master）。也接受 WAV（兼容调试）。

V2.1 起同时提供中文语音识别：
  POST /api/stt  上传任意音频（webm/mp3/wav…）→ ffmpeg 转 16k PCM →
                  FunASR Paraformer-large（中文，16k）→ { ok, text }
模型首次调用时懒加载（GPU 上约 10~60s），之后每次毫秒~秒级。

端点：
  GET  /api/health             -> {status, out_dir, ffmpeg, stt}
  POST /api/record             body=任意 ffmpeg 可解码音频
                               header X-Record-Ms=录音时长(ms)
                               -> {ok, file, path, seconds, bytes}
  POST /api/stt                body=任意 ffmpeg 可解码音频（同 record）
                               -> {ok, text, language, seconds}

配置（优先级从高到低）：
  输出目录 : 启动参数 --out-dir  >  环境变量 DSH_VOCAL_DIR  >  默认(见下)
  ffmpeg   : 环境变量 FFMPEG_BIN  >  PATH 中的 ffmpeg  >  已知默认安装路径
  ASR 模型 : 环境变量 FUNASR_DIR  >  已知本地路径  >  ModelScope 模型 id
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

# 若 ffmpeg 不在 PATH，且未设置 FFMPEG_BIN，则回退到这个默认路径（可自行修改）。
FFMPEG_FALLBACKS = [
    Path(r"D:\ffmpeg\ffmpeg-master-latest-win64-gpl-shared\bin\ffmpeg.exe"),
]

# FunASR Paraformer-large 中文 ASR（16k）本地路径；不存在则退回 ModelScope id。
FUNASR_DEFAULT = Path(
    r"D:\models\funasr\speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
)
FUNASR_MODELSCOPE_ID = "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"

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
    return {
        "status": "ok",
        "out_dir": str(OUT_DIR),
        "ffmpeg": "ok" if FFMPEG else "missing",
        "stt": "ready" if _STT_MODEL is not None else "cold",
        "tts": "ready" if _TTS_HANDLER is not None else "cold",
    }


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


def answer_dir() -> Path:
    """回答 txt 落盘目录：环境 DSH_ANSWER_DIR，否则 OUT_DIR 的兄弟 answer/。"""
    env = os.environ.get("DSH_ANSWER_DIR")
    if env:
        return Path(env)
    return OUT_DIR.parent / "answer"


@app.post("/api/answer")
async def save_answer(request: Request) -> JSONResponse:
    """保存一次正式回答：{ text } -> vocal/answer/YYYYMMDDHHMMSS.txt（结束时刻命名）。"""
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
    text = str(payload.get("text") or "").strip()
    if not text:
        return JSONResponse({"ok": False, "error": "empty text"}, status_code=400)
    out_dir = answer_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d%H%M%S")
    out = unique_path(out_dir, stamp, ".txt")
    out.write_text(text, encoding="utf-8")
    return JSONResponse({
        "ok": True,
        "file": out.name,
        "path": str(out),
        "bytes": out.stat().st_size,
    })


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


# ──────────────────────────────── 中文识别 (V2.1) ──────────────────────────────
_STT_MODEL = None
_STT_LOCK = threading.Lock()


def stt_model_name() -> str:
    env = os.environ.get("FUNASR_DIR")
    if env:
        return env
    if FUNASR_DEFAULT.is_dir():
        return str(FUNASR_DEFAULT)
    return FUNASR_MODELSCOPE_ID


def _load_stt_model():
    """懒加载 FunASR Paraformer-large（中文 16k）。线程安全，只加载一次。"""
    global _STT_MODEL  # noqa: PLW0603
    if _STT_MODEL is not None:
        return _STT_MODEL
    with _STT_LOCK:
        if _STT_MODEL is not None:
            return _STT_MODEL
        import torch
        from funasr import AutoModel

        cuda = torch.cuda.is_available()
        print(f"[record-sink] STT 加载模型: {stt_model_name()} (cuda={cuda})", flush=True)
        _STT_MODEL = AutoModel(
            model=stt_model_name(),
            trust_remote_code=True,
            device="cuda" if cuda else "cpu",
            dtype="float16" if cuda else "float32",
        )
    return _STT_MODEL


def _transcribe(model, pcm16: bytes) -> str:
    """16k 单声道小端 PCM16 → 文本。空/异常一律返回空串。"""
    audio = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
    audio = np.ascontiguousarray(audio, dtype=np.float32)
    result = model.generate(input=audio, cache={})
    return (result[0].get("text") or "").strip() if result else ""


def _run_stt(body: bytes, content_type: str, record_ms: int) -> dict:
    """同步执行 STT：转 16k PCM → 懒加载模型 → 转写。"""
    if FFMPEG is None:
        raise RuntimeError("ffmpeg not found — set FFMPEG_BIN")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp_dir = OUT_DIR / ".tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    ext = EXT_BY_TYPE.get(content_type, ".bin")
    token = uuid.uuid4().hex[:12]
    src = tmp_dir / f"_stt_{token}{ext}"
    pcm = tmp_dir / f"_stt_{token}.pcm"
    try:
        src.write_bytes(body)
        proc = subprocess.run(
            [
                str(FFMPEG), "-y",
                "-i", str(src),
                "-ar", "16000",
                "-ac", "1",
                "-f", "s16le",
                str(pcm),
            ],
            capture_output=True,
            timeout=120,
        )
        if proc.returncode != 0:
            tail = (proc.stderr or b"").decode("utf-8", "ignore")[-300:]
            raise RuntimeError(f"ffmpeg decode failed: {tail}")
        pcm_bytes = pcm.read_bytes()
        if len(pcm_bytes) < 3200:  # < 0.1s
            return {"ok": True, "text": "", "language": "zh", "seconds": record_ms / 1000.0}
        model = _load_stt_model()
        text = _transcribe(model, pcm_bytes)
        return {"ok": True, "text": text, "language": "zh", "seconds": record_ms / 1000.0}
    finally:
        try:
            src.unlink(missing_ok=True)
            pcm.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass


@app.post("/api/stt")
async def stt(request: Request) -> JSONResponse:
    """中文语音识别：任意 ffmpeg 可解码音频 -> { ok, text }。首次调用加载模型较慢。"""
    body = await request.body()
    if len(body) < 256:
        return JSONResponse({"ok": False, "error": "empty or too-small payload"}, status_code=400)
    try:
        ms = int(request.headers.get("x-record-ms", "0"))
    except ValueError:
        ms = 0
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    try:
        result = await asyncio.to_thread(_run_stt, body, content_type, ms)
        return JSONResponse(result)
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"stt failed: {err}"}, status_code=500)


# ──────────────────────────── 克隆朗读 + 服务端播放 (V3) ───────────────────────
import queue as _queue
import tempfile as _tempfile

QWEN3_TTS_DEFAULT = Path(r"D:\models\Qwen3-TTS-12Hz-1.7B-Base")
VOICE_DIR_DEFAULT = Path(__file__).resolve().parents[1] / "voices" / "我的声音"
FFPLAY_DEFAULT = Path(r"D:\ffmpeg\ffmpeg-master-latest-win64-gpl-shared\bin\ffplay.exe")
# 单段合成字数上限（服务端再按句切小段，串行合成+播放）。
TTS_CHUNK_MAX = 400

_TTS_HANDLER = None
_TTS_LOCK = threading.Lock()

_SPEECH_QUEUE = _queue.Queue()
_SPEECH_THREAD = None
_SPEECH_THREAD_LOCK = threading.Lock()
_SPEECH_STOP = threading.Event()
_SPEECH_CURRENT = None  # 当前正在播放的 ffplay Popen
_SPEECH_STATE_LOCK = threading.Lock()
_SPEECH_STATE = {"speaking": False, "queue": 0}
_SPEECH_ERROR = ""


def _voice_dir() -> Path:
    env = os.environ.get("DSH_VOICE_DIR")
    return Path(env) if env else VOICE_DIR_DEFAULT


def _load_tts_handler():
    """懒加载 Qwen3TTSHandler（克隆音色；参考音频/文本在加载时读入）。"""
    global _TTS_HANDLER  # noqa: PLW0603
    if _TTS_HANDLER is not None:
        return _TTS_HANDLER
    with _TTS_LOCK:
        if _TTS_HANDLER is not None:
            return _TTS_HANDLER
        from queue import Queue
        from threading import Event as ThreadEvent

        from speech_to_speech.TTS.qwen3_tts_handler import Qwen3TTSHandler

        model_dir = os.environ.get("QWEN3_TTS_DIR") or str(QWEN3_TTS_DEFAULT)
        vdir = _voice_dir()
        ref_audio = vdir / "ref_audio.wav"
        ref_text = ""
        if (vdir / "ref_text.txt").is_file():
            ref_text = (vdir / "ref_text.txt").read_text(encoding="utf-8").strip()
        cfg = {
            "model_name": model_dir,
            "device": "cuda",
            "dtype": "auto",
            "attn_implementation": "eager",
            "language": "zh",
            "non_streaming_mode": False,  # 流式产出，边合成边播放
            "max_new_tokens": 1536,
            "blocksize": 512,
            "ref_audio": str(ref_audio),
            "ref_text": ref_text,
        }
        if not ref_audio.is_file():
            raise RuntimeError(
                f"音色参考音频不存在: {ref_audio}（可用 DSH_VOICE_DIR 指定音色目录）"
            )
        print(f"[record-sink] TTS 加载模型: {model_dir} voice={vdir}", flush=True)
        _TTS_HANDLER = Qwen3TTSHandler(
            ThreadEvent(),
            queue_in=Queue(),
            queue_out=Queue(),
            setup_args=(ThreadEvent(),),  # should_listen
            setup_kwargs=cfg,
        )
    return _TTS_HANDLER


def _synthesize_text(handler, text: str) -> bytes:
    """一段中文文本 -> 16k 单声道 PCM16 WAV。"""
    from speech_to_speech.pipeline.messages import TTSInput

    chunks = []
    for chunk in handler.process(TTSInput(text=text, language_code="zh")):
        if isinstance(chunk, bytes):
            chunks.append(np.frombuffer(chunk, dtype=np.int16))
        else:
            chunks.append(np.asarray(chunk, dtype=np.int16))
    if not chunks:
        raise RuntimeError("TTS 未产出音频")
    samples = np.concatenate(chunks).astype(np.int16, copy=False)

    import io
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(samples.tobytes())
    return buf.getvalue()


def _split_speech(text: str, max_len: int = 280, min_pause: int = 40) -> list:
    """攒句成段：句子到 min_pause 字以上或到 max_len 才切（减少句间合成停顿）。"""
    out = []
    buf = ""
    for ch in text:
        buf += ch
        if len(buf) >= max_len or (len(buf) >= min_pause and ch in "。！？!?…；;\n"):
            out.append(buf.strip())
            buf = ""
    if buf.strip():
        out.append(buf.strip())
    return out


# 会令 GBK 输出/合成失败的 emoji、装饰符号等。
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U0001F1E6-\U0001F1FF"
    "\U00002600-\U000027BF\U0000FE00-\U0000FE0F"
    "\U0000200D\u20E3]"
)


def _sanitize_tts_text(text: str) -> str:
    """去掉不适合朗读/导致编码失败的内容（emoji、控制符等）。"""
    s = _EMOJI_RE.sub("", text)
    s = re.sub(r"[\uE000-\uF8FF\uFFF0-\uFFFF]", "", s)  # 私用区/占位
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _piper_paths():
    """开源离线 Piper(内置)：返回 (exe, model, config) 或 None。"""
    root = Path(__file__).resolve().parent / "piper"
    exe = root / "bin" / "piper.exe"
    model = root / "voices" / "zh_CN-huayan-medium.onnx"
    cfg = root / "voices" / "zh_CN-huayan-medium.onnx.json"
    if exe.is_file() and model.is_file() and cfg.is_file():
        return exe, model, cfg
    return None


def _speak_sapi_piece(text: str) -> None:
    """系统 SAPI 兜底（默认语音）。"""
    engine = Path(__file__).resolve().parent / "speak.ps1"
    proc = subprocess.Popen(
        [
            "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(engine), "-Text", text,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    with _SPEECH_STATE_LOCK:
        _SPEECH_CURRENT = proc
    try:
        proc.wait(timeout=900)
    finally:
        with _SPEECH_STATE_LOCK:
            if _SPEECH_CURRENT is proc:
                _SPEECH_CURRENT = None


def _speak_piper_piece(exe: Path, model: Path, cfg: Path, text: str) -> None:
    """Piper(huayan) 合成一段 -> 临时 wav -> ffplay 播放。"""
    fd, path = _tempfile.mkstemp(suffix=".wav", prefix="dsh_piper_")
    os.close(fd)
    try:
        synth = subprocess.Popen(
            [str(exe), "-m", str(model), "-c", str(cfg), "--output_file", str(path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        with _SPEECH_STATE_LOCK:
            _SPEECH_CURRENT = synth
        try:
            assert synth.stdin is not None
            synth.stdin.write(text.encode("utf-8"))
            synth.stdin.close()
            synth.wait(timeout=900)
        finally:
            with _SPEECH_STATE_LOCK:
                if _SPEECH_CURRENT is synth:
                    _SPEECH_CURRENT = None
        if synth.returncode == 0 and Path(path).exists() and Path(path).stat().st_size > 1000:
            play = subprocess.Popen(
                [str(_resolve_ffplay()), "-nodisp", "-autoexit", "-loglevel", "quiet", str(path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            with _SPEECH_STATE_LOCK:
                _SPEECH_CURRENT = play
            try:
                play.wait(timeout=900)
            finally:
                with _SPEECH_STATE_LOCK:
                    if _SPEECH_CURRENT is play:
                        _SPEECH_CURRENT = None
        else:
            raise RuntimeError(f"piper 合成失败 rc={synth.returncode}")
    finally:
        try:
            os.unlink(path)
        except Exception:  # noqa: BLE001
            pass


def _speech_worker() -> None:
    global _SPEECH_CURRENT, _SPEECH_ERROR  # noqa: PLW0603
    while True:
        text = _SPEECH_QUEUE.get()
        if text is None:
            return
        with _SPEECH_STATE_LOCK:
            _SPEECH_STATE["speaking"] = True
            _SPEECH_STATE["queue"] = max(0, _SPEECH_QUEUE.qsize())
        try:
            piper = _piper_paths()
            for piece in _split_speech(text, max_len=280, min_pause=50):
                if _SPEECH_STOP.is_set():
                    break
                if piper is not None:
                    _speak_piper_piece(*piper, text=piece)
                else:
                    _speak_sapi_piece(piece)
        except Exception as err:  # noqa: BLE001
            print(f"[record-sink] speak error: {err}", flush=True)
            with _SPEECH_STATE_LOCK:
                _SPEECH_ERROR = str(err)
        finally:
            with _SPEECH_STATE_LOCK:
                _SPEECH_STATE["speaking"] = False
                _SPEECH_STATE["queue"] = max(0, _SPEECH_QUEUE.qsize())


def _resolve_ffplay() -> Path:
    env = os.environ.get("FFPLAY_BIN")
    if env and Path(env).is_file():
        return Path(env)
    return FFPLAY_DEFAULT


def _ensure_speech_worker() -> None:
    global _SPEECH_THREAD  # noqa: PLW0603
    with _SPEECH_THREAD_LOCK:
        if _SPEECH_THREAD is None or not _SPEECH_THREAD.is_alive():
            _SPEECH_THREAD = threading.Thread(target=_speech_worker, daemon=True)
            _SPEECH_THREAD.start()


@app.post("/api/speak")
async def speak(request: Request) -> JSONResponse:
    """整段文本入队朗读（克隆音色，服务端 ffplay 出声，串行）。"""
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
    text = _sanitize_tts_text(str(payload.get("text") or ""))
    if not text:
        return JSONResponse({"ok": False, "error": "empty text"}, status_code=400)
    if not _resolve_ffplay().is_file():
        return JSONResponse({"ok": False, "error": f"ffplay 不存在: {_resolve_ffplay()}"}, status_code=500)
    try:
        _ensure_speech_worker()
        with _SPEECH_STATE_LOCK:
            _SPEECH_ERROR = ""
        _SPEECH_STOP.clear()
        _SPEECH_QUEUE.put(text)
        with _SPEECH_STATE_LOCK:
            queue_len = _SPEECH_QUEUE.qsize() + (1 if _SPEECH_STATE["speaking"] else 0)
        return JSONResponse({"ok": True, "queue": queue_len, "chars": len(text)})
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"speak failed: {err}"}, status_code=500)


@app.post("/api/speech/stop")
async def speech_stop() -> JSONResponse:
    """停掉当前播放并清空队列。"""
    global _SPEECH_CURRENT  # noqa: PLW0603
    _SPEECH_STOP.set()
    with _SPEECH_STATE_LOCK:
        proc = _SPEECH_CURRENT
        _SPEECH_CURRENT = None
    if proc is not None:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
    while True:
        try:
            _SPEECH_QUEUE.get_nowait()
        except _queue.Empty:
            break
    return JSONResponse({"ok": True})


@app.get("/api/speech/status")
def speech_status() -> dict:
    with _SPEECH_STATE_LOCK:
        return {
            "speaking": _SPEECH_STATE["speaking"],
            "queue": _SPEECH_STATE["queue"],
            "error": _SPEECH_ERROR,
        }


@app.post("/api/tts")
async def tts(request: Request) -> Response:
    """文字转语音：{ text } -> 16k PCM16 WAV（单段 ≤400 字，供测试/前端自播）。"""
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
    text = str(payload.get("text") or "").strip()
    if not text:
        return JSONResponse({"ok": False, "error": "empty text"}, status_code=400)
    text = text[:TTS_CHUNK_MAX]

    def _run() -> bytes:
        handler = _load_tts_handler()
        return _synthesize_text(handler, text)

    try:
        wav = await asyncio.to_thread(_run)
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": f"tts failed: {err}"}, status_code=500)
    return Response(content=wav, media_type="audio/wav")


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
