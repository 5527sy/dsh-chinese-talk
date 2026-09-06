"""
voice_bridge — 本地语音桥（Windows 原生 / 自用精简版）。

裁剪自 beiyege-01/dsh-voice-ai-girlfriend（Apache-2.0）的 voice_bridge.py：
只保留 DSH 语音通话链路所需端点 —— STT（FunASR 中文 ASR）+ TTS（Qwen3-TTS
参考音频克隆）+ silero VAD（打断检测）+ 多音色管理；去掉数字人(DUIX)、QQ、
余额、OmniVoice、media 素材等与本项目无关的功能。

职责：
  DSH 浏览器插件 <--HTTP/WS--> 本服务 <--> 本地模型（同一块 GPU）
  本服务只做「耳朵和嘴」，对话大脑仍是 DSH/DeepSeek。

运行：
  venv\\Scripts\\python.exe -m uvicorn voice_bridge:app --host 127.0.0.1 --port 8765
  （或直接运行 start-bridge.cmd）

端点：
  GET  /api/health                状态（模型懒加载就绪标志）
  POST /api/stt                   16k PCM16（raw 或 wav）-> { text, language }
  POST /api/tts                   { text } -> 16k PCM16 WAV（当前音色克隆朗读）
  WS   /api/vad                   播放期间麦克风流式 silero VAD（说话即打断）
  GET  /api/voices                音色清单（voices/<名称>/ref_audio.* + ref_text.txt）
  GET  /api/persona/list          音色列表 + 当前选择
  POST /api/persona/set           { voice } 热切换音色

模型（首次调用懒加载，TTS 预热 ~10-60s 属正常）：
  STT: FunASR Paraformer-large（中文，16k），~1GB 显存
  TTS: Qwen3-TTS-12Hz-1.7B-Base（fp16 ~3.7GB），克隆参考音频
  VAD: silero-vad v4（CPU，~2MB），models/silero-vad/ 下
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import math
import threading
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
CONFIG_PATH = HERE / "bridge-config.json"
VOICES_DIR = PROJECT_ROOT / "voices"
# silero-vad 模型目录（与参考一致：<项目根>/models/silero-vad/，不入库）
VAD_MODELS_DIR = PROJECT_ROOT / "models" / "silero-vad"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("voice_bridge")


def load_config() -> dict:
    # utf-8-sig 容忍 BOM（PowerShell 5.1 Set-Content 会写 BOM）
    with open(CONFIG_PATH, encoding="utf-8-sig") as f:
        return json.load(f)


CONFIG = load_config()
PERSONA_CFG = CONFIG.get("persona", {})

app = FastAPI(title="voice-bridge")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CONFIG.get("cors_origins", ["http://127.0.0.1:3080", "http://localhost:3080"]),
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── 音色预设（voices/<名称>/ 子文件夹 = 一个音色）───────────────────────────
# 每个音色子文件夹：
#   ref_audio.wav|.mp3|.flac|.ogg|.m4a|.aac   —— 参考音频（3-20s 干净人声）
#   ref_text.txt                               —— 该音频实际朗读的文本（逐字一致）
# Qwen3-TTS Base 用「参考音频 + 参考文本」做零样本克隆，文本一致性决定相似度。
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"}


def _scan_voices() -> dict[str, dict]:
    voices: dict[str, dict] = {}
    if VOICES_DIR.is_dir():
        for entry in sorted(VOICES_DIR.iterdir()):
            if not entry.is_dir():
                continue
            name = entry.name
            audio = next((f for f in entry.iterdir() if f.suffix.lower() in AUDIO_EXTS), None)
            text = next(
                (f for f in entry.iterdir() if f.name.lower() in ("ref_text.txt", "ref_text.text")),
                None,
            )
            if audio is None:
                continue
            ref_text = text.read_text(encoding="utf-8", errors="ignore").strip() if text is not None else ""
            voices[name] = {
                "label": name,
                "engine": "qwen3",
                "ref_audio": str(audio.resolve()),
                "ref_text": ref_text,
            }
    return voices


PERSONAS: dict[str, dict] = _scan_voices()
# 默认音色：配置 persona.default_voice -> 否则第一个 -> 否则空
_default_cfg = str(PERSONA_CFG.get("default_voice", "") or "")
if _default_cfg in PERSONAS:
    _default_voice = _default_cfg
else:
    _default_voice = next(iter(PERSONAS), "")
_current_persona: str = _default_voice


class ModelManager:
    """两个懒加载模型句柄（STT/TTS），首次调用才加载。

    共享一把 infer_lock：STT 与 TTS 共用同一块 GPU，个人本机服务串行即可。
    """

    def __init__(self) -> None:
        self._stt = None
        self._tts = None
        self._stt_error: str | None = None
        self._tts_error: str | None = None
        self._load_lock = asyncio.Lock()
        self.infer_lock = asyncio.Lock()

    @property
    def stt_ready(self) -> bool:
        return self._stt is not None

    @property
    def tts_ready(self) -> bool:
        return self._tts is not None

    @property
    def stt_error(self) -> str | None:
        return self._stt_error

    @property
    def tts_error(self) -> str | None:
        return self._tts_error

    async def ensure_stt(self):
        async with self._load_lock:
            if self._stt is not None:
                return self._stt
            if self._stt_error is not None:
                raise HTTPException(status_code=503, detail=f"STT 模型加载失败: {self._stt_error}")
            try:
                self._stt = await asyncio.to_thread(_load_stt_handler)
            except Exception as exc:  # noqa: BLE001
                logger.exception("STT 模型加载失败")
                self._stt_error = f"{type(exc).__name__}: {exc}"
                raise HTTPException(status_code=503, detail=f"STT 模型加载失败: {self._stt_error}") from exc
        return self._stt

    async def ensure_tts(self):
        async with self._load_lock:
            if self._tts is not None:
                return self._tts
            if self._tts_error is not None:
                raise HTTPException(status_code=503, detail=f"TTS 模型加载失败: {self._tts_error}")
            try:
                self._tts = await asyncio.to_thread(_load_tts_handler)
            except Exception as exc:  # noqa: BLE001
                logger.exception("TTS 模型加载失败")
                self._tts_error = f"{type(exc).__name__}: {exc}"
                raise HTTPException(status_code=503, detail=f"TTS 模型加载失败: {self._tts_error}") from exc
        return self._tts


def _load_stt_handler():
    """FunASR Paraformer-large 中文 ASR（16k）。"""
    from funasr import AutoModel

    model_name = CONFIG["stt"].get(
        "model_name",
        "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    )
    device = CONFIG["stt"].get("device", "cuda")
    dtype = CONFIG["stt"].get("torch_dtype", "float16")
    return AutoModel(model=model_name, trust_remote_code=True, device=device, dtype=dtype)


def _load_tts_handler():
    """Qwen3TTSHandler（PyPI speech-to-speech==0.2.10），配置来自 [tts]。

    参考音频/文本在加载时与「当前音色」对齐；此后切音色走热切换
    （_apply_current_voice 在每个合成前同步 handler 属性，见 /api/tts）。
    """
    from queue import Queue
    from threading import Event

    from speech_to_speech.TTS.qwen3_tts_handler import Qwen3TTSHandler

    cfg = dict(CONFIG["tts"])
    persona = PERSONAS.get(_current_persona)
    if persona is not None:
        cfg["ref_audio"] = persona.get("ref_audio") or cfg.get("ref_audio", "")
        cfg["ref_text"] = persona.get("ref_text") or cfg.get("ref_text", "")
    # 配置里没有音色信息时也保证这两个键存在（Qwen3TTSHandler 依赖）
    cfg.setdefault("ref_audio", "")
    cfg.setdefault("ref_text", "")
    return Qwen3TTSHandler(
        Event(),
        queue_in=Queue(),
        queue_out=Queue(),
        setup_args=(Event(),),  # should_listen
        setup_kwargs=cfg,
    )


def _apply_current_voice(handler) -> None:
    """把当前音色的参考音频/文本同步到已加载的 Qwen3 handler（热切换）。"""
    persona = PERSONAS.get(_current_persona)
    if persona is None or persona.get("engine", "qwen3") != "qwen3":
        return
    handler.ref_audio = persona.get("ref_audio")
    handler.ref_text = persona.get("ref_text", "")


models = ModelManager()


def decode_audio(body: bytes, content_type: str) -> np.ndarray:
    """把请求音频解码为 16kHz 单声道 float32。

    接受 WAV（soundfile 可读的任意采样率/声道）或裸 16-bit PCM16 16kHz
    （mic-capture worklet 输出）。MP3 等其它格式需 libsndfile 支持。
    """
    if content_type == "audio/wav" or body[:4] == b"RIFF":
        import soundfile as sf

        data, sr = sf.read(io.BytesIO(body), dtype="float32", always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)
    else:
        raw = np.frombuffer(body, dtype="<i2")
        data = raw.astype(np.float32) / 32768.0
        sr = 16000
    if sr != 16000:
        from scipy.signal import resample_poly

        g = math.gcd(int(sr), 16000)
        data = resample_poly(data, up=16000 // g, down=sr // g)
    return np.ascontiguousarray(data, dtype=np.float32)


def _transcribe_funasr(model, audio: np.ndarray) -> tuple[str, str | None]:
    """FunASR 转写：返回 (text, 'zh')；空/异常一律安全返回空文本。"""
    try:
        result = model.generate(input=audio, cache={})
        text = (result[0].get("text") or "").strip() if result else ""
        if not text:
            logger.info("STT: funasr 返回空结果，按空处理")
        return text, "zh"
    except Exception:  # noqa: BLE001
        logger.exception("STT: funasr 转写失败")
        return "", None


@app.get("/api/health")
async def health() -> dict:
    """状态页。stt/tts 反映懒加载就绪情况（首次调用前为 false）。"""
    return {
        "status": "ok",
        "stt": models.stt_ready,
        "tts": models.tts_ready,
        "stt_error": models.stt_error,
        "tts_error": models.tts_error,
        "vad": (VAD_MODELS_DIR / "silero_vad_v4.jit").is_file()
        or (VAD_MODELS_DIR / "silero_vad.jit").is_file(),
        "voice": _current_persona,
        "voices": list(PERSONAS),
    }


@app.post("/api/stt")
async def stt(request: Request) -> dict:
    """语音转文字：16k PCM16（raw 或 wav）-> { text, language }。"""
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")
    audio = await asyncio.to_thread(decode_audio, body, request.headers.get("content-type", ""))
    duration = len(audio) / 16000.0
    max_sec = float(request.headers.get("X-Max-Audio-Sec", "30") or "30")
    if duration > max_sec:
        raise HTTPException(
            status_code=422,
            detail=f"音频过长: {duration:.1f}s 超过 X-Max-Audio-Sec {max_sec}s",
        )
    async with models.infer_lock:
        handler = await models.ensure_stt()
        text, language = await asyncio.to_thread(_transcribe_funasr, handler, audio)
    return {"text": text, "language": language}


class TTSRequest(BaseModel):
    text: str


@app.post("/api/tts")
async def tts(req: TTSRequest, request: Request) -> Response:
    """文字转语音：{ text } -> 16k PCM16 WAV（当前音色克隆朗读）。

    协作式取消：客户端 abort（关朗读/打断）时本请求断开，看门狗置线程事件，
    合成循环在块间停下，立即释放 GPU。
    """
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")
    if len(text) > 512:
        logger.warning("TTS 文本从 %d 截断到 512 字", len(text))
        text = text[:512]

    cancel = threading.Event()

    async def watch_disconnect() -> None:
        while True:
            if await request.is_disconnected():
                cancel.set()
                return
            await asyncio.sleep(0.2)

    watcher = asyncio.create_task(watch_disconnect())
    try:
        async with models.infer_lock:
            handler = await models.ensure_tts()
            await asyncio.to_thread(_apply_current_voice, handler)
            samples = await asyncio.to_thread(_synthesize, handler, text, cancel)
    finally:
        watcher.cancel()

    if cancel.is_set():
        logger.info("TTS 被客户端取消")
        raise HTTPException(status_code=499, detail="TTS cancelled by client")
    wav = _pcm16_to_wav(samples)
    logger.info("TTS OK: %d 字 -> %.2fs wav (%d bytes)", len(text), len(samples) / 16000.0, len(wav))
    return Response(content=wav, media_type="audio/wav")


def _synthesize(handler, text: str, cancel: threading.Event | None = None) -> np.ndarray:
    """一段文本 -> 拼接后的 int16 采样（Qwen3TTSHandler 逐块产出）。

    客户端断开时在块间提前退出，避免 GPU 空转把队列跑完。
    """
    from speech_to_speech.pipeline.messages import TTSInput

    chunks = []
    for chunk in handler.process(TTSInput(text=text, language_code="zh")):
        if cancel is not None and cancel.is_set():
            logger.info("TTS: 合成中途取消")
            break
        if isinstance(chunk, bytes):
            chunks.append(np.frombuffer(chunk, dtype=np.int16))
        else:
            chunks.append(np.asarray(chunk, dtype=np.int16))
    if not chunks:
        raise HTTPException(status_code=500, detail="TTS 未产出音频")
    return np.concatenate(chunks)


def _pcm16_to_wav(samples: np.ndarray) -> bytes:
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(samples.astype("<i2").tobytes())
    return buf.getvalue()


# ── Silero VAD（打断检测）──────────────────────────────────────────────────
# 浏览器侧 RMS 噪声门分不清「真人说话」与「TTS 回声/环境声」；播放回复期间，
# 插件把麦克风 PCM16 流式推到 /api/vad，由 silero VAD 判定真人语音，
# 只在听到真人说话时回 { event: 'speech_start' }。数据不落盘。


class VADSession:
    """每个 WebSocket 连接一个 silero VAD 会话（状态独立）。"""

    def __init__(self) -> None:
        import torch
        from speech_to_speech.VAD.vad_iterator import VADIterator

        model_path = VAD_MODELS_DIR / "silero_vad_v4.jit"
        if not model_path.is_file():
            model_path = VAD_MODELS_DIR / "silero_vad.jit"
        if not model_path.is_file():
            raise RuntimeError(f"silero-vad 模型不存在: {VAD_MODELS_DIR}（放 silero_vad_v4.jit 或 silero_vad.jit）")

        self.model = torch.jit.load(str(model_path), map_location="cpu")
        self.model.eval()
        self.iterator = VADIterator(
            self.model,
            threshold=0.6,
            sampling_rate=16000,
            min_silence_duration_ms=64,
            speech_pad_ms=30,
        )
        self.min_speech_ms = 384
        self.speech_started = False
        self._buf = b""

    def feed(self, pcm16: bytes) -> list[dict]:
        """喂入任意长度的 16k PCM16 块；返回要发给客户端的 JSON 事件列表。

        silero 需要固定 512 采样窗口；块被缓冲切窗，保证音频流连续。
        累积说话 >=384ms 触发 speech_start（打断），整句结束后发 speech_end。
        """
        import numpy as np
        import torch

        self._buf += pcm16
        out: list[dict] = []
        while len(self._buf) >= 1024:  # 512 int16 = 1024 bytes
            window = self._buf[:1024]
            self._buf = self._buf[1024:]
            x = np.frombuffer(window, dtype=np.int16).astype(np.float32) / 32768.0
            utterance = self.iterator(torch.from_numpy(x))
            if self.iterator.triggered and not self.speech_started:
                active_ms = self.iterator.active_speech_samples / 16.0
                if active_ms >= self.min_speech_ms:
                    self.speech_started = True
                    out.append({"event": "speech_start"})
            if utterance is not None:
                self.speech_started = False
                out.append({"event": "speech_end"})
        return out


@app.websocket("/api/vad")
async def vad_endpoint(ws: WebSocket) -> None:
    """流式打断 VAD。客户端推 16k PCM16 块（~40ms），真人语音时回事件。"""
    await ws.accept()
    session = VADSession()
    try:
        while True:
            data = await ws.receive_bytes()
            if not data:
                continue
            for msg in session.feed(data):
                await ws.send_json(msg)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        logger.exception("VAD websocket 异常")
        try:
            await ws.close()
        except Exception:
            pass


# ── 音色查询与切换 ─────────────────────────────────────────────────────────


@app.get("/api/voices")
async def voices() -> dict:
    return {"voices": list(PERSONAS), "current": _current_persona}


def _voice_entry(name: str) -> dict:
    p = PERSONAS.get(name, {})
    return {"name": name, "label": p.get("label", name), "current": name == _current_persona}


@app.get("/api/persona/list")
async def persona_list() -> dict:
    return {
        "voices": [_voice_entry(n) for n in PERSONAS],
        "current": {"voice": _current_persona},
    }


class PersonaSetRequest(BaseModel):
    voice: str | None = None


@app.post("/api/persona/set")
async def persona_set(req: PersonaSetRequest) -> dict:
    """热切换音色：改 handler.ref_audio/ref_text，下一句合成即生效。

    若 TTS 尚未加载则**不触发加载**（切音色不应带来 10~60s 的等待）——
    首次合成时 _load_tts_handler 会按当时的 _current_persona 加载正确的音色。
    """
    global _current_persona
    if req.voice is None:
        raise HTTPException(status_code=400, detail="Nothing to set")
    name = req.voice.strip()
    if name not in PERSONAS:
        raise HTTPException(status_code=404, detail=f"未知音色: {name}")
    if models.tts_ready:
        handler = await models.ensure_tts()
        handler.ref_audio = PERSONAS[name].get("ref_audio") or None
        handler.ref_text = PERSONAS[name].get("ref_text", "")
    _current_persona = name
    logger.info("音色切换为 %s", name)
    return {"ok": True, "voice": name}
