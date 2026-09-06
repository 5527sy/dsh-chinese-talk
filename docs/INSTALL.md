# 安装与运行指南（Windows，纯本机，无需 WSL2）

## 0. 硬件前提

| 检查项 | 要求 |
|---|---|
| 系统 | Windows 10/11 64 位 |
| 显卡 | NVIDIA 独显（CUDA），**显存建议 ≥8GB**（FunASR ~1GB + Qwen3-TTS fp16 ~3.7GB，峰值约 5~6GB） |
| 驱动 | 新装 NVIDIA 驱动（无需单独装 CUDA Toolkit，PyTorch 自带运行库） |
| 磁盘 | 模型约：FunASR 850MB + Qwen3-TTS ~7GB + venv ~5-8GB，预留 25GB+ |

验证：`nvidia-smi` 能显示显卡即可。没有 NVIDIA 显卡无法跑（推理依赖 CUDA）。

DSH 侧要求：**deepseek-harness 源码树，dsh ≥ 0.1.3**（插件用到 0.1.3 的
`useChat`/`conversation.input.left` 座位；rc.8 与 0.1.3 的差异见 docs/DESIGN.md 与参考仓库）。

## 1. Python 环境（项目根目录执行）

```powershell
python -m venv venv-speech
venv-speech\Scripts\activate
pip install -r bridge\requirements.txt
# 国内加速：  ... -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## 2. 模型

### STT：FunASR Paraformer-large（中文）
```powershell
pip install modelscope
python -c "from modelscope import snapshot_download; snapshot_download('iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch')"
xcopy /E /I %USERPROFILE%\.cache\modelscope\models\iic--speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch\snapshots\master models\funasr\speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch
```

### VAD：silero（打断用，CPU 2MB）
从 [silero-vad v4.0](https://github.com/snakers4/silero-vad/tree/v4.0) 的
`files/silero_vad.jit` 获取，放到 `models\silero-vad\silero_vad_v4.jit`（放根目录同名文件
`silero_vad.jit` 也可）。

### TTS：Qwen3-TTS-12Hz-1.7B-Base
```powershell
modelscope download --model Qwen/Qwen3-TTS-12Hz-1.7B-Base --local_dir %USERPROFILE%\models\Qwen3-TTS-12Hz-1.7B-Base
```
> 只用 **Base**（支持参考音频克隆）；VoiceDesign 变体不支持。

## 3. 音色（参考音频）

按 `voices/README.md`：在 `voices/我的声音/` 放 `ref_audio.wav`（或 mp3，3~20s 干净人声）
+ `ref_text.txt`（该音频**逐字一致**的文本）。多个音色可并存。

## 4. 配置

```powershell
copy bridge\bridge-config.example.json bridge\bridge-config.json
```
必改：
- `tts.model_name` → 你下载 Qwen3-TTS-Base 的目录（正斜杠/双反斜杠均可）
- `persona.default_voice` → `voices/` 下的音色文件夹名

## 5. 验证桥接

```powershell
bridge\start-bridge.cmd
```
浏览器打开 `http://127.0.0.1:8765/api/health` 应返回 `{"status":"ok",...}`。
然后另开终端做烟雾测试：

```powershell
venv-speech\Scripts\python.exe bridge\smoke_tts.py --text "你好，我是克隆音色的测试。"
venv-speech\Scripts\python.exe bridge\smoke_stt.py --file 某段中文录音.wav
```
`tts_out.wav` 听起来像参考音频 = TTS 链路通。首次 TTS 要等模型加载+预热 10~60s，属正常。

## 6. 把插件装进 deepseek-harness（源码树路线）

在**项目根目录**执行，把 `dsh-plugin\` 复制进你的 harness：

```powershell
xcopy /E /I dsh-plugin\* <HARNESS>\packages\client\ui-voice-call\
```

然后在 harness 里注册三处：

**① `<HARNESS>\tsconfig.client.json`** — `references` 数组加一行：
```jsonc
{ "path": "./packages/client/ui-voice-call" }
```

**② `<HARNESS>\packages\bundle\web-app\cordis.patch.yml`** — 客户端插件行区域插入：
```yaml
    # Voice call: mic -> bridge FunASR STT -> conversation.send; reply streaming TTS.
    - id: ui-voice-call
      name: '@deepseek-ai/dsh-client-ui-voice-call'
```

**③ `<HARNESS>\packages\bundle\web-app\package.json`** — dependencies 加：
```jsonc
"@deepseek-ai/dsh-client-ui-voice-call": "workspace:^",
```

**构建**（按顺序，前一步成功再下一步）：
```powershell
cd <HARNESS>
pnpm install
pnpm exec tsc -b packages/client/ui-voice-call/tsconfig.json
pnpm --filter @deepseek-ai/dsh-client-ui-voice-call bundle
```

**重启 dsh web**（新增插件必须重启进程，只刷新页面无效）。控制台应出现：

```
[ui-voice-call] loaded, bridge = http://127.0.0.1:8765
```

对话区右侧出现「语音通话」侧边栏。

> 若 tsconfig extends 报错：以 harness 内同级包（如 `packages/client/ui-plan/tsconfig.json`）为准复制其 extends 路径即可。

## 6b. 插件接入的另一种路线（dsh plugin add）

在 dsh ≥ 0.1.3 上也可以把本插件打成**独立插件包**后用
`dsh plugin --profile web add <包路径/名>` 安装（免改 harness 源码）。
两种路线契约相同；本仓库默认给源码树路线（与参考仓库一致、可完全复现）。

## 7. 使用

1. 点右侧面板「🎙️」→ 连续聆听，说一句话，停顿 ~1.8s 自动识别并发送；
   回复开始按句朗读；想打断就直接开口（插话模式）或点面板开关切「排队」。
2. 🔊 关 = 只打字不朗读；🎚️ 音色下拉即时换声音。
3. 面板右上「»」可收起为悬浮小圆钮。

## 8. 常见问题

| 现象 | 处理 |
|---|---|
| 面板显示「桥接未连接」 | 桥没启动；或 `s2s.voice.bridge` 覆盖了别的地址（F12 localStorage 查看） |
| 点麦克风无反应 | 页面需 https 或 localhost 才有麦克风权限；检查浏览器权限设置 |
| 首次 TTS 很慢（10-60s） | 模型首次加载+预热；之后每句约秒级 |
| 声音不像参考音频 | 参考音频需干净、参考文本与录音逐字一致；换 5~20s 单句人声重录 |
| 识别为空 | FunASR 对超短/纯噪声返回空被丢弃，属防护；再说长一点 |
| 没有麦克风按钮/面板 | 第 6 节三处注册漏了某处，或没重启 dsh web |
| 插件装了但朗读不响 | dsh 版本过旧（无 `conversation.input.left`/`useChat` 座位）——升级到 0.1.3+ |
