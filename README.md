# dsh-chinese-talk

[简体中文](README.zh-CN.md)

**Voice-enabled Chinese conversations for DeepSeek Harness.** `dsh-chinese-talk` is an installable DeepSeek Harness Web plugin bundle that adds a voice panel to the Harness shell: record from the browser microphone, store the MP3 locally, transcribe it into Chinese text with FunASR, insert the text into your message box, and have the assistant's final answer archived and read back to you — Edge TTS first, with a Windows SAPI offline fallback.

Two components work together:

- **A browser plugin** (the Harness bundle) that mounts a collapsible voice panel inside the Web shell and watches the active conversation.
- **A local Python bridge** (`record-sink`) that does the heavy lifting outside the browser — audio conversion, speech recognition, answer archiving, and speech playback — exposed as a small HTTP service on `127.0.0.1:8766`.

The bundle installs through the official `dsh plugin` command with a profile overlay and never copies or modifies the DeepSeek Harness installation.

## Overview

```
Browser — DeepSeek Harness Web + dsh-chinese-talk plugin
┌──────────────────────────────────────────────────────────┐
│  🎙️ Voice panel (right edge of the shell, collapsible)   │
│                                                          │
│  record ──► /api/record ──► MP3 saved locally            │
│  transcribe via /api/stt ──► Chinese text ──► input box  │
│  final answer ──► archived to .txt + read aloud          │
└──────────────────────────┬───────────────────────────────┘
                           │ local HTTP (localhost only, CORS-restricted)
┌──────────────────────────▼───────────────────────────────┐
│  Local Python bridge — record-sink (127.0.0.1:8766)      │
│  ffmpeg · FunASR Paraformer-large (zh, 16k) ·            │
│  Edge TTS → ffplay, Windows SAPI (speak.ps1) fallback    │
└──────────────────────────────────────────────────────────┘
```

### Features

- **Record & keep**: microphone audio is recorded with the browser `MediaRecorder` (webm/opus), uploaded to the bridge, converted to a mono MP3 with ffmpeg, and saved locally. The file name is the wall-clock second at which recording stopped (`YYYYMMDDHHMMSS.mp3`), so recordings are naturally ordered. Recordings shorter than ~1 second are discarded.
- **Speech → text**: after each recording is saved, the audio is transcribed automatically with FunASR (`Paraformer-large`, Chinese, 16 kHz). The model is loaded lazily on the first request and reused afterwards.
- **Text lands where you expect**: recognized text is appended to the last text input you focused (any `input`/`textarea`, e.g. the composer or a prompt field), falling back to the main composer draft of the current session. Text is **not sent automatically** — review it, then press Enter.
- **Answers archived**: when a conversation turn completes, the final assistant message is written to a UTF-8 `.txt` file (again named by end time) in the answers directory — a lightweight, searchable transcript of what the assistant said.
- **Replies read aloud**: each final answer is synthesized with Edge TTS (default voice `zh-CN-XiaoxiaoNeural`) and played on this machine via ffplay. If Edge TTS fails, the bridge falls back to the Windows SAPI offline voices (`Huihui`, then `Zira`). Read-aloud is on by default, can be toggled in the panel, and playback stops when you close the tab or start speaking.
- **Always available**: the panel is mounted at shell level, so you can record and insert text even while the assistant is still thinking or answering. A built-in activity log (last ~20 events) shows every step without opening the developer console.
- **No code changes to Harness**: installation is a standard `dsh plugin --profile web add ...`; uninstalling removes everything.

## Requirements

| Requirement | Version / notes |
|---|---|
| DeepSeek Harness | `0.1.3-alpha.1`, with a `web` profile and the `dsh` CLI |
| Node.js | `^22.19.0` or `>=24` (pnpm is used for the plugin build) |
| pnpm | `11.7.0` (the repo's `packageManager`) |
| Python | `>=3.10` for the local bridge (Python 3.11 is used in CI) |
| ffmpeg / ffplay | on `PATH`, or set `FFMPEG_BIN` / `FFPLAY_BIN`; `ffplay` plays speech |
| Browser | a modern browser with `MediaRecorder` and microphone permission |
| OS | Windows, Linux, or macOS for the bridge; the SAPI **offline** fallback is Windows-only |

The bundle adds its own `chinese-talk` row to the Web profile through the supported profile-overlay mechanism (`cordis.patch.yml`). It does not alter the DeepSeek Harness installation.

## Install the Harness bundle

### From this checkout

```powershell
pnpm install
dsh plugin --profile web add .
```

`pnpm install` runs the package `prepare` build, which produces the `lib/` artifacts the plugin loader needs.

### From a GitHub release

```powershell
dsh plugin --profile web add github:5527sy/dsh-chinese-talk#v0.2.0
```

Git dependencies run the package `prepare` script at install time. pnpm 10+ may ask you to allow this package to run build scripts in the profile's `pnpm-workspace.yaml`. If you prefer to avoid install-time builds, use the tarball instead.

### From a release tarball (no install-time build)

```powershell
pnpm install
pnpm run check
pnpm pack                # produces dsh-chinese-talk-0.2.0.tgz
dsh plugin --profile web add .\dsh-chinese-talk-0.2.0.tgz
```

### Verify, restart, uninstall

```powershell
dsh --profile web --dump-config   # the chinese-talk row should appear
dsh web                           # restart the Web profile
```

Uninstall:

```powershell
dsh plugin --profile web remove dsh-chinese-talk
```

### Migrating from the legacy (0.1) manual install

Older versions used `scripts/register_plugin.py` to copy `packages/client/ui-voice-call` into the Harness source tree and register it three times. Before installing this bundle, remove that copied directory and the legacy source-tree registrations. Do **not** run the legacy copy and this bundle at the same time.

## Run the local bridge

The browser plugin talks to `http://127.0.0.1:8766` by default. The bridge is a separate local Python process because microphone conversion, FunASR, local file output, and audio playback all run outside the browser.

### Windows one-click start (recommended)

Double-click `一键启动.cmd` in the repository root. On first run it creates `.venv`, installs `bridge/requirements.txt`, installs CPU `torch`/`torchaudio` when PyTorch is missing (required by FunASR STT), and starts `python -m bridge.record_sink`.

Or run it manually:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-bridge.ps1
```

For CUDA PyTorch, install the matching wheels yourself, or run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-bridge.ps1 -TorchIndexUrl https://download.pytorch.org/whl/cu126
```

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r .\bridge\requirements.txt
.\.venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
.\bridge\start.ps1
```

Linux or macOS:

```sh
python3 -m venv .venv
./.venv/bin/python -m pip install -r ./bridge/requirements.txt
./bridge/start.sh
```

Or install the bridge as a Python command and run it from anywhere:

```sh
python -m pip install .
dsh-chinese-talk-bridge
```

Useful options: `--host` (default `127.0.0.1`), `--port` (default `8766`), `--out-dir` (recording directory override).

Notes:

- The first transcription lazily downloads the FunASR Paraformer-large model from ModelScope. To avoid that, place a local model copy and point `FUNASR_DIR` at it (the bridge also probes `<working-directory>/models/funasr/...`).
- Put `ffmpeg` and `ffplay` on `PATH`, or configure `FFMPEG_BIN` and `FFPLAY_BIN`.
- Check the bridge is up with `http://127.0.0.1:8766/api/health` — it reports status, the output directory, ffmpeg, STT readiness, and the speech stack (Edge TTS / ffplay / SAPI).

## Use it

1. Start the Web profile (`dsh web`) and open a conversation. Open a voice panel if it is collapsed (🎙️ toggle on the right edge).
2. Click the 🎙️ button to start recording, then click it again to stop. Audio shorter than ~1 second is rejected with a toast.
3. The bridge saves the MP3 and transcribes it. Recognized text is appended to the input you last focused — or the main composer if none — as a draft line. Edit and send it.
4. When the assistant finishes a turn, its final answer is saved as a `.txt` and, if read-aloud is on (🔊, the default), read aloud.

Recording and text insertion keep working while the assistant is thinking or answering. The panel shows the recent activity log and the target folders (`GET /api/health` reports the exact directories).

## Configuration

Environment variables (highest precedence first where both exist):

| Variable | Purpose | Default |
|---|---|---|
| `DSH_VOCAL_DIR` | Directory for recorded MP3s | `<bridge working dir>/vocal/master` |
| `DSH_ANSWER_DIR` | Directory for archived answer `.txt` files | sibling `answer/` of the recording dir |
| `FUNASR_DIR` | Local FunASR model directory **or** a model id | local model probe, then the ModelScope id |
| `FFMPEG_BIN` | `ffmpeg` executable | `<bridge working dir>/ffmpeg/bin`, then `PATH` |
| `FFPLAY_BIN` | `ffplay` executable | `<bridge working dir>/ffmpeg/bin`, then `PATH` |
| `EDGE_TTS_BIN` | `edge-tts` executable | `PATH`, then the `edge_tts` module in the active Python environment |
| `DSH_TTS_VOICE` | Edge TTS voice | `zh-CN-XiaoxiaoNeural` |
| `DSH_SPEAK_VOICE` | Preferred Windows SAPI voice name substring | `Huihui`, then `Zira` |
| `DSH_BRIDGE_ORIGINS` | Comma-separated browser origins allowed to call the bridge | Harness local ports 3080 / 3081 |

When started through `bridge/start.ps1` or `bridge/start.sh` from the repo root, the working directory is the repo, so recordings land in `<repo>/vocal/master` and answers in `<repo>/vocal/answer` by default (`vocal/` is git-ignored).

Browser-side overrides are kept in `localStorage` (set them in the browser devtools if needed):

| Key | Meaning |
|---|---|
| `s2s.record.base` | Bridge base URL, e.g. `http://127.0.0.1:8766` |
| `s2s.record.panel` | Whether the panel is collapsed (`1`) |
| `s2s.voice.read` | Whether read-aloud is enabled (`0` disables) |

### Privacy

The bridge binds to `127.0.0.1` only, and CORS restricts callers to the Harness local origins by default. Recordings and answers never leave your machine. Two exceptions: the first FunASR model download reaches ModelScope, and Edge TTS sends answer text to Microsoft's Edge TTS service for synthesis. Use the SAPI fallback (Windows) or a local TTS to avoid the online service.

## Bridge HTTP API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Status: out dir, ffmpeg, STT cold/ready, speaker stack |
| `POST /api/record` | Audio body → MP3 saved locally (name = end second); `X-Record-Ms` header carries duration |
| `POST /api/stt` | Audio body → `{ ok, text, language: "zh", seconds }` (FunASR, lazy model load) |
| `POST /api/answer` | `{ text }` → final answer archived as `.txt` |
| `POST /api/speak` | `{ text }` → queue for read-aloud (Edge TTS, SAPI fallback) |
| `POST /api/speech/stop` | Stop current playback and clear the queue |
| `GET /api/speech/status` | Speaking state, queue length, last error |

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "保存失败 / HTTP ..." in the panel log | Bridge is not running — start it, then check `/api/health`. Wrong bridge URL → set `s2s.record.base`. |
| "ffmpeg not found" | Install ffmpeg/ffplay or point `FFMPEG_BIN` / `FFPLAY_BIN` at them. |
| First transcription is very slow | The FunASR model is downloading/loading. Later requests take milliseconds to seconds. |
| No sound when reading answers | `ffplay` missing; Edge TTS unreachable; system volume; on Windows the SAPI fallback needs a `Huihui`/`Zira` voice installed. |
| Speech fails for code/emoji-heavy answers | Text is cleaned before synthesis: emoji removed, code blocks collapsed to a short placeholder, URLs to a placeholder word. |
| Nothing is inserted after recognition | Click into the target input first (the plugin inserts into the last input you focused). Ensure a conversation is open; otherwise the composer fallback is used. |

## Development

```powershell
pnpm install
pnpm run check
```

`pnpm run check` runs the type check, builds `lib/index.js` (node half) and `lib/client.js` (browser client bundle) with tsdown, and verifies the publication manifest and artifacts (`scripts/verify-package.mjs`). CI (GitHub Actions, Ubuntu) also byte-compiles the bridge and builds a Python wheel.

Layout:

- `dsh-plugin/src/` — plugin source: `client/` mounts the voice panel (`VoiceSidebar.tsx`) and watches conversation events; the node half (`index.ts`) is intentionally empty, everything is web-side.
- `bridge/` — Python bridge (`record_sink.py`), the SAPI helper (`speak.ps1`), and launch scripts.
- `cordis.patch.yml` — the profile-overlay row the installer applies.
- `scripts/` — clean-up and post-build verification helpers.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The project derives from `dsh-voice-ai-girlfriend` (Apache-2.0) and adapts parts of HuggingFace speech-to-speech and `deepseek-harness`; runtime integrations include FunASR Paraformer (MIT) and Microsoft Edge TTS via `edge-tts` (LGPL-3.0). Attribution is retained in `NOTICE`.
