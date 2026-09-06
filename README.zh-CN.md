# dsh-chinese-talk

[English](README.md)

这是一个可通过 DeepSeek Harness 官方插件命令安装的中文语音 Web Bundle，提供浏览器录音、本地保存、FunASR 中文识别、识别文本写入当前会话、最终回答归档，以及 Edge TTS 朗读和 Windows SAPI 兜底。

## 兼容范围

- DeepSeek Harness `0.1.3-alpha.1`
- Node.js `^22.19.0` 或 `>=24`
- Python `>=3.10`
- DeepSeek Harness Web profile

Bundle 通过官方 profile overlay 新增独立的 `chinese-talk` 条目，不会复制或修改 DeepSeek Harness 的源码目录。

## 安装 Harness Bundle

从本地仓库安装：

```powershell
pnpm install
dsh plugin --profile web add .
```

发布 Release 后从 GitHub 安装：

```powershell
dsh plugin --profile web add github:5527sy/dsh-tts-edge#v0.2.0
```

Git 依赖会执行本包的 `prepare` 构建。pnpm 10 及以上版本可能要求在 profile 的 `pnpm-workspace.yaml` 中允许本包执行构建。也可以发布预构建 tarball，避免安装阶段执行脚本：

```powershell
pnpm install
pnpm run check
pnpm pack
dsh plugin --profile web add .\dsh-chinese-talk-0.2.0.tgz
```

检查配置层并重启 Web profile：

```powershell
dsh --profile web --dump-config
dsh web
```

卸载：

```powershell
dsh plugin --profile web remove dsh-chinese-talk
```

如果旧版本曾运行 `scripts/register_plugin.py`，安装新版前应删除它复制到 Harness 的 `packages/client/ui-voice-call` 目录以及对应的三处源码注册。旧版手工注入和新版 Bundle 不应同时启用。

## 启动本地语音桥

浏览器插件默认连接 `http://127.0.0.1:8766`。录音转码、FunASR、文件保存和本机播放需要独立 Python 进程完成。

Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r .\bridge\requirements.txt
.\bridge\start.ps1
```

Linux 或 macOS：

```sh
python3 -m venv .venv
./.venv/bin/python -m pip install -r ./bridge/requirements.txt
./bridge/start.sh
```

也可以把语音桥安装成 Python 命令：

```sh
python -m pip install .
dsh-chinese-talk-bridge
```

首次识别可能会从 ModelScope 下载 FunASR 模型。请把 `ffmpeg` 和 `ffplay` 加入 `PATH`，或配置 `FFMPEG_BIN` 与 `FFPLAY_BIN`。

## 配置

| 环境变量 | 用途 | 默认值 |
|---|---|---|
| `DSH_VOCAL_DIR` | 录音 MP3 目录 | `<仓库>/vocal/master` |
| `DSH_ANSWER_DIR` | 回答文本目录 | 与录音目录同级的 `answer/` |
| `FUNASR_DIR` | FunASR 本地模型目录或模型 ID | 项目模型目录，然后使用 ModelScope ID |
| `FFMPEG_BIN` | `ffmpeg` 程序 | 项目内程序，然后查找 `PATH` |
| `FFPLAY_BIN` | `ffplay` 程序 | 项目内程序，然后查找 `PATH` |
| `EDGE_TTS_BIN` | `edge-tts` 程序 | 当前 Python 环境，然后查找 `PATH` |
| `DSH_TTS_VOICE` | Edge TTS 音色 | `zh-CN-XiaoxiaoNeural` |
| `DSH_SPEAK_VOICE` | Windows SAPI 首选音色关键字 | `Huihui`，然后 `Zira` |
| `DSH_BRIDGE_ORIGINS` | 允许访问桥接服务的浏览器 Origin，逗号分隔 | Harness 本机 3080/3081 端口 |

服务默认只监听 `127.0.0.1`。录音和回答保留在本机；使用 Edge TTS 或首次下载模型时会访问对应在线服务。

## 开发和检查

```powershell
pnpm install
pnpm run check
```

检查命令会生成 Harness 所需的 Host 入口与浏览器 Bundle，并验证发布清单和产物。

## 许可证

项目采用 Apache License 2.0，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。衍生代码的原作者信息保留在 `NOTICE` 中。
