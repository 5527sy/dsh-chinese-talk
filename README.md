# dsh-chinese-talk

[简体中文](README.zh-CN.md)

An installable DeepSeek Harness Web bundle for Chinese voice conversations. It records microphone audio in the browser, stores recordings locally, transcribes them with FunASR, inserts recognized text into the active conversation draft, archives final answers, and reads replies aloud through Edge TTS with Windows SAPI fallback.

## Compatibility

- DeepSeek Harness `0.1.3-alpha.1`
- Node.js `^22.19.0` or `>=24`
- Python `>=3.10`
- A DeepSeek Harness Web profile

The bundle adds its own `chinese-talk` row through the supported profile overlay mechanism. It does not modify the DeepSeek Harness installation.

## Install the Harness bundle

From this checkout:

```powershell
pnpm install
dsh plugin --profile web add .
```

From GitHub after a release is published:

```powershell
dsh plugin --profile web add github:5527sy/dsh-chinese-talk#v0.2.0
```

Git dependencies run the package `prepare` script. pnpm 10+ may ask you to allow this package under the profile's `pnpm-workspace.yaml`. A release tarball avoids install-time builds:

```powershell
pnpm install
pnpm run check
pnpm pack
dsh plugin --profile web add .\dsh-chinese-talk-0.2.0.tgz
```

Verify the active layer and restart the Web profile:

```powershell
dsh --profile web --dump-config
dsh web
```

Uninstall:

```powershell
dsh plugin --profile web remove dsh-chinese-talk
```

If an older checkout used `scripts/register_plugin.py`, remove its copied `packages/client/ui-voice-call` directory and the three source-tree registrations before installing this bundle. Do not run both copies together.

## Run the local bridge

The browser plugin talks to `http://127.0.0.1:8766` by default. The bridge is a separate local Python process because microphone conversion, FunASR, local file output, and audio playback run outside the browser.

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r .\bridge\requirements.txt
.\bridge\start.ps1
```

Linux or macOS:

```sh
python3 -m venv .venv
./.venv/bin/python -m pip install -r ./bridge/requirements.txt
./bridge/start.sh
```

Install the bridge as a Python command instead:

```sh
python -m pip install .
dsh-chinese-talk-bridge
```

The first transcription may download the FunASR model from ModelScope. Install `ffmpeg` and `ffplay` on `PATH`, or set `FFMPEG_BIN` and `FFPLAY_BIN`.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `DSH_VOCAL_DIR` | Recorded MP3 directory | `<repo>/vocal/master` |
| `DSH_ANSWER_DIR` | Archived answer directory | sibling `answer/` directory |
| `FUNASR_DIR` | Local FunASR model directory or model id | bundled path, then ModelScope id |
| `FFMPEG_BIN` | `ffmpeg` executable | project-local binary, then `PATH` |
| `FFPLAY_BIN` | `ffplay` executable | project-local binary, then `PATH` |
| `EDGE_TTS_BIN` | `edge-tts` executable | active environment, then `PATH` |
| `DSH_TTS_VOICE` | Edge TTS voice | `zh-CN-XiaoxiaoNeural` |
| `DSH_SPEAK_VOICE` | Preferred Windows SAPI voice substring | `Huihui`, then `Zira` |
| `DSH_BRIDGE_ORIGINS` | Comma-separated allowed browser origins | Harness localhost ports 3080/3081 |

The bridge binds only to `127.0.0.1` by default. Recordings and answers stay local unless the configured Edge TTS service or ModelScope download is used.

## Development

```powershell
pnpm install
pnpm run check
```

`pnpm run check` creates the Host entry and the wrapped browser client bundle expected by DeepSeek Harness, then verifies the publication manifest and artifacts.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The project contains adapted work whose attribution is retained in `NOTICE`.
