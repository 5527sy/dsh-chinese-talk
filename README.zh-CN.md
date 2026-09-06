# dsh-chinese-talk

[English](README.md)

**为 DeepSeek Harness 增加中文语音对话能力。** `dsh-chinese-talk` 是一个可通过 DeepSeek Harness 官方插件命令安装的 Web 插件 Bundle，在 Harness 界面右侧加入语音面板：浏览器录音、MP3 本地保存、FunASR 转成中文文字并填入输入框，同时把助手的最终回答归档成文本并朗读出来 —— 优先 Edge TTS，Windows 下失败时回退到本机 SAPI 离线语音。

项目由两部分组成：

- **浏览器插件**（Harness Bundle）：在 Web 界面挂载一个可折叠的语音面板，并监听当前会话。
- **本地 Python 桥**（`record-sink`）：在浏览器之外完成转码、中文识别、回答归档和语音播放，以一个小型 HTTP 服务的形式运行在 `127.0.0.1:8766`。

Bundle 通过官方 `dsh plugin` 命令以 profile overlay 方式安装，不会复制或修改 DeepSeek Harness 安装目录中的任何代码。

## 总览

```
浏览器 —— DeepSeek Harness Web + dsh-chinese-talk 插件
┌──────────────────────────────────────────────────────────┐
│  🎙️ 语音面板（界面右缘，可折叠）                          │
│                                                          │
│  录音 ──► /api/record ──► MP3 本地保存                    │
│  /api/stt 识别 ──► 中文文本 ──► 输入框                     │
│  最终回答 ──► 归档 .txt + 朗读                            │
└──────────────────────────┬───────────────────────────────┘
                           │ 本机 HTTP（仅 localhost，CORS 受限）
┌──────────────────────────▼───────────────────────────────┐
│  本地 Python 桥 —— record-sink（127.0.0.1:8766）           │
│  ffmpeg · FunASR Paraformer-large（中文 16k）·            │
│  Edge TTS → ffplay，Windows SAPI（speak.ps1）兜底         │
└──────────────────────────────────────────────────────────┘
```

### 功能特性

- **录音并保留**：用浏览器 `MediaRecorder`（webm/opus）录音，上传到桥后用 ffmpeg 转成单声道 MP3 存到本机。文件名取录音结束那一秒（`YYYYMMDDHHMMSS.mp3`），天然按时间排序。不足约 1 秒的录音会被丢弃。
- **语音转文字**：每次保存后自动调用 FunASR（`Paraformer-large`，中文，16k）识别。模型首次请求时懒加载，之后复用。
- **文字落到正确的位置**：识别文本追加到你最后点过的输入框（任意 `input`/`textarea`，如对话输入框或提问卡片），否则回退到当前会话的主输入框草稿。文本**不会自动发送** —— 确认后再按回车。
- **回答归档**：一个回合结束后，助手最终回答会写成 UTF-8 `.txt`（同样以结束时刻命名）存入回答目录，形成轻量、可检索的问答记录。
- **回答朗读**：每次最终回答会用 Edge TTS（默认音色 `zh-CN-XiaoxiaoNeural`）合成并在本机通过 ffplay 播放；Edge TTS 失败时回退到 Windows SAPI 离线语音（优先 `Huihui`，其次 `Zira`）。朗读默认开启，可在面板开关，关闭页面或开始说话时会自动停止。
- **随时可用**：面板挂在整壳层，助手思考/回答进行中也可以录音、填字。面板内置活动日志（最近约 20 条），不开控制台也能看到每一步结果。
- **不改 Harness 代码**：安装就是标准的 `dsh plugin --profile web add ...`，卸载即全部移除。

## 兼容范围

| 要求 | 版本 / 说明 |
|---|---|
| DeepSeek Harness | `0.1.3-alpha.1`，需 `web` profile 与 `dsh` 命令 |
| Node.js | `^22.19.0` 或 `>=24`（构建插件需要 pnpm） |
| pnpm | `11.7.0`（仓库 `packageManager`） |
| Python | 本地桥需要 `>=3.10`（CI 使用 3.11） |
| ffmpeg / ffplay | 加入 `PATH`，或设置 `FFMPEG_BIN` / `FFPLAY_BIN`；`ffplay` 负责播放语音 |
| 浏览器 | 支持 `MediaRecorder` 且允许麦克风的现代浏览器 |
| 操作系统 | 桥支持 Windows / Linux / macOS；SAPI **离线**兜底仅限 Windows |

Bundle 通过官方 profile overlay 机制（`cordis.patch.yml`）在 Web profile 中新增独立的 `chinese-talk` 条目，不修改 DeepSeek Harness 安装。

## 安装 Harness Bundle

### 从本地仓库安装

```powershell
pnpm install
dsh plugin --profile web add .
```

`pnpm install` 会触发包的 `prepare` 构建，生成插件加载所需的 `lib/` 产物。

### 从 GitHub Release 安装

```powershell
dsh plugin --profile web add github:5527sy/dsh-chinese-talk#v0.2.0
```

Git 依赖在安装时会执行本包的 `prepare` 构建脚本。pnpm 10+ 可能要求你在 profile 的 `pnpm-workspace.yaml` 中允许本包执行构建。如果不希望在安装阶段构建，请改用下面的 tarball 方式。

### 从发布 tarball 安装（无安装期构建）

```powershell
pnpm install
pnpm run check
pnpm pack                # 生成 dsh-chinese-talk-0.2.0.tgz
dsh plugin --profile web add .\dsh-chinese-talk-0.2.0.tgz
```

### 检查、重启、卸载

```powershell
dsh --profile web --dump-config   # 应能看到 chinese-talk 条目
dsh web                           # 重启 Web profile
```

卸载：

```powershell
dsh plugin --profile web remove dsh-chinese-talk
```

### 从旧版（0.1）手动注入迁移

旧版本通过 `scripts/register_plugin.py` 把 `packages/client/ui-voice-call` 复制进 Harness 源码树并注册三处。安装本 Bundle 前，请删除那个被复制的目录及旧版源码注册。旧版手工注入与本 Bundle 不要同时启用。

## 启动本地语音桥

浏览器插件默认连接 `http://127.0.0.1:8766`。录音转码、FunASR、文件保存和本机播放都在浏览器之外，需要一个独立的本地 Python 进程。

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

也可以把桥安装成 Python 命令，随处运行：

```sh
python -m pip install .
dsh-chinese-talk-bridge
```

常用参数：`--host`（默认 `127.0.0.1`）、`--port`（默认 `8766`）、`--out-dir`（覆盖录音目录）。

注意事项：

- 首次识别会从 ModelScope 懒加载 FunASR Paraformer-large 模型。想避免联网下载，可放置本地模型并用 `FUNASR_DIR` 指向它（桥也会探测 `<启动目录>/models/funasr/...`）。
- 请把 `ffmpeg`、`ffplay` 加入 `PATH`，或配置 `FFMPEG_BIN` 与 `FFPLAY_BIN`。
- 用 `http://127.0.0.1:8766/api/health` 确认桥已就绪 —— 它会报告状态、输出目录、ffmpeg、STT 是否就绪以及朗读链路（Edge TTS / ffplay / SAPI）。

## 使用方法

1. 启动 Web profile（`dsh web`）并打开一个对话。若面板已折叠，点击界面右缘的 🎙️ 展开。
2. 点击面板上的 🎙️ 开始录音，再点一次结束。不足约 1 秒的录音会弹出提示并丢弃。
3. 桥保存 MP3 并自动识别；识别文本以草稿行追加到你最后点过的输入框 —— 没有就追加到主输入框。确认、编辑后发送。
4. 助手回答完一个回合后，最终回答会保存为 `.txt`；若朗读已开启（🔊，默认开启），还会自动朗读出来。

助手思考或回答期间，录音和文字填入仍可正常使用。面板会显示最近的活动日志和保存目录提示（`GET /api/health` 返回实际目录）。

## 配置

环境变量（同时存在时优先级从高到低）：

| 环境变量 | 用途 | 默认值 |
|---|---|---|
| `DSH_VOCAL_DIR` | 录音 MP3 保存目录 | `<桥启动目录>/vocal/master` |
| `DSH_ANSWER_DIR` | 回答 `.txt` 归档目录 | 录音目录的同级 `answer/` |
| `FUNASR_DIR` | FunASR 本地模型目录**或**模型 ID | 先探测本地模型，再使用 ModelScope ID |
| `FFMPEG_BIN` | `ffmpeg` 程序 | `<桥启动目录>/ffmpeg/bin`，然后查找 `PATH` |
| `FFPLAY_BIN` | `ffplay` 程序 | `<桥启动目录>/ffmpeg/bin`，然后查找 `PATH` |
| `EDGE_TTS_BIN` | `edge-tts` 程序 | 先查找 `PATH`，再使用当前 Python 环境中的 `edge_tts` 模块 |
| `DSH_TTS_VOICE` | Edge TTS 音色 | `zh-CN-XiaoxiaoNeural` |
| `DSH_SPEAK_VOICE` | Windows SAPI 首选音色名关键字 | 优先 `Huihui`，其次 `Zira` |
| `DSH_BRIDGE_ORIGINS` | 允许调用桥的浏览器 Origin，逗号分隔 | Harness 本机 3080 / 3081 端口 |

通过仓库根目录的 `bridge/start.ps1` 或 `bridge/start.sh` 启动时，工作目录即仓库，因此默认录音落在 `<仓库>/vocal/master`、回答落在 `<仓库>/vocal/answer`（`vocal/` 已被 git 忽略）。

浏览器侧可用 `localStorage` 覆盖（需要时在浏览器开发者工具中设置）：

| Key | 含义 |
|---|---|
| `s2s.record.base` | 桥的基地址，如 `http://127.0.0.1:8766` |
| `s2s.record.panel` | 面板是否折叠（`1` 为折叠） |
| `s2s.voice.read` | 是否开启朗读（`0` 关闭） |

### 隐私说明

桥默认只监听 `127.0.0.1`，CORS 默认只允许 Harness 本机端口调用。录音与回答均保存在本机。仅两处会访问网络：首次从 ModelScope 下载 FunASR 模型，以及 Edge TTS 把回答文本发送到微软 Edge TTS 服务合成语音。如需完全离线，可在 Windows 使用 SAPI 兜底，或改用本地 TTS。

## 桥 HTTP API

| 端点 | 用途 |
|---|---|
| `GET /api/health` | 状态：输出目录、ffmpeg、STT 冷/热、朗读链路 |
| `POST /api/record` | 音频 → 本地保存 MP3（文件名=结束时刻）；`X-Record-Ms` 头携带时长 |
| `POST /api/stt` | 音频 → `{ ok, text, language: "zh", seconds }`（FunASR，模型懒加载） |
| `POST /api/answer` | `{ text }` → 最终回答归档为 `.txt` |
| `POST /api/speak` | `{ text }` → 排队朗读（Edge TTS，SAPI 兜底） |
| `POST /api/speech/stop` | 停止当前朗读并清空队列 |
| `GET /api/speech/status` | 朗读状态、队列长度、最近错误 |

## 常见问题

| 现象 | 可能原因 / 解决办法 |
|---|---|
| 面板日志报「保存失败 / HTTP ...」 | 桥未启动 —— 先启动桥并访问 `/api/health`；桥地址不对可改 `s2s.record.base`。 |
| 提示「ffmpeg not found」 | 安装 ffmpeg/ffplay，或把 `FFMPEG_BIN` / `FFPLAY_BIN` 指向它们。 |
| 首次识别非常慢 | FunASR 模型正在下载/加载；之后的请求只需毫秒到秒级。 |
| 朗读没有声音 | `ffplay` 缺失、Edge TTS 连不上、系统音量；Windows 下 SAPI 兜底需要安装含 `Huihui`/`Zira` 的语音。 |
| 含代码/表情的回答朗读异常 | 朗读前会清洗文本：去 emoji、代码块替换为「（代码省略）」、URL 替换为「链接」。 |
| 识别后没有填入文字 | 先点一下目标输入框（文本填入最近聚焦的输入框）；确认已打开会话，否则走主输入框回退。 |

## 开发与检查

```powershell
pnpm install
pnpm run check
```

`pnpm run check` 依次执行类型检查、用 tsdown 构建 `lib/index.js`（Node 半侧）与 `lib/client.js`（浏览器客户端 Bundle），并用 `scripts/verify-package.mjs` 校验发布清单与产物。CI（GitHub Actions，Ubuntu）还会对桥做语法编译并构建 Python wheel。

目录结构：

- `dsh-plugin/src/` —— 插件源码：`client/` 挂载语音面板（`VoiceSidebar.tsx`）并监听会话事件；Node 半侧（`index.ts`）刻意留空，功能全部在 Web 端。
- `bridge/` —— Python 桥（`record_sink.py`）、SAPI 辅助脚本（`speak.ps1`）与启动脚本。
- `cordis.patch.yml` —— 安装器应用的 profile overlay 条目。
- `scripts/` —— 清理与构建后校验脚本。

提交 Pull Request 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

Apache License 2.0，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。项目衍生自 `dsh-voice-ai-girlfriend`（Apache-2.0），并改编了 HuggingFace speech-to-speech 与 `deepseek-harness` 的部分代码；运行时集成了 FunASR Paraformer（MIT）与基于 `edge-tts` 的微软 Edge TTS（LGPL-3.0）。原作者信息保留在 `NOTICE` 中。
