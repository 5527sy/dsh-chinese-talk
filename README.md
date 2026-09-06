# DSH 语音通话插件（Voice Call for DeepSeek Harness）

给 DeepSeek Harness（DSH）加的**语音通话**能力：

- 🎙️ **语音输入**：点麦克风 → 连续聆听 → 每句自动识别并发送（参考「点开→连续听→按句自动发」交互）
- 🔊 **语音朗读**：助手回复按句子切分，**边合成边朗读**（不用等整段回复）
- ⚡ **插话 / 排队双模式**：默认插话——你开口就打断朗读并立即发送；可切排队
- 🗣️ **音色克隆**：从一段参考音频（WAV/MP3）克隆说话声音，多音色热切换
- 🧭 **侧边栏语音通话面板**：通话控制全部集中在一个右侧面板

全部推理在本机：**FunASR Paraformer（中文 ASR）+ Qwen3-TTS-12Hz-1.7B-Base（克隆）**，
不需要 WSL2、不需要云端 API。对话大脑仍是 DSH 里的 DeepSeek —— 本插件只做耳朵和嘴。

> 实现基于开源项目 [beiyege-01/dsh-voice-ai-girlfriend](https://github.com/beiyege-01/dsh-voice-ai-girlfriend)
> （Apache-2.0）裁剪与重构：去掉数字人/QQ/OmniVoice 等模块，保留并理顺
> 「麦克风→ASR→会话→按句 TTS→打断」这条语音通话链路，并把 UI 收敛为侧边栏面板。

## 结构

```
dsh-voice-call/
├── bridge/                  # Python 语音桥（独立运行，FastAPI :8765）
│   ├── voice_bridge.py      #   STT/TTS/VAD/多音色 端点（唯一入口）
│   ├── bridge-config.example.json
│   ├── requirements.txt
│   ├── start-bridge.cmd
│   └── smoke_stt.py / smoke_tts.py
├── voices/                  # 音色库：voices/<音色名>/{ref_audio.*, ref_text.txt}
├── models/                  # （自建，不入库）models/funasr/ + models/silero-vad/
├── dsh-plugin/              # DSH 客户端插件（复制进 harness 源码树构建）
└── docs/
    ├── INSTALL.md           # 安装/运行/排障
    └── DESIGN.md            # 语音交互实现细节
```

## 架构

```
浏览器（DSH Web GUI）
  ┌─────────────────────────────┐
  │ 侧边栏「语音通话」面板        │
  │  麦克风→聆听→按句自动发送    │
  │  🔊朗读 ⚡插话/排队 🎚️音色   │
  └──────────┬──────────────────┘
     采集(AudioWorklet 16k) │ 回传WAV
     STT文本 / 会话注入       │ 播放队列(FIFO)
             ▼                        ▲
  ┌──────────────────────────────────────────┐
  │  voice_bridge :8765（本机 Python/FastAPI） │
  │   /api/stt  FunASR 中文识别（~150ms/句）   │
  │   /api/tts  Qwen3-TTS-1.7B-Base 克隆朗读   │
  │   /api/vad  silero 真人语音打断            │
  │   /api/persona 音色热切换                  │
  └──────────────────────────────────────────┘
```

## 快速开始（详见 docs/INSTALL.md）

```powershell
# 1. 建 Python 环境并装依赖
python -m venv venv-speech
venv-speech\Scripts\activate
pip install -r bridge\requirements.txt

# 2. 复制配置并修改（TTS 模型路径 + 默认音色名）
copy bridge\bridge-config.example.json bridge\bridge-config.json

# 3. 放模型 + 放参考音频（见 voices/ 说明）
# 4. 启动语音桥
bridge\start-bridge.cmd          # http://127.0.0.1:8765/api/health

# 5. 把 dsh-plugin\ 装进 deepseek-harness（源码树内注册三处 + 构建）
#    —— 按 docs/INSTALL.md 第 6 节操作
```

## 许可

Apache-2.0。桥与插件核心逻辑改编自
[dsh-voice-ai-girlfriend](https://github.com/beiyege-01/dsh-voice-ai-girlfriend)（Apache-2.0，
其依赖 HuggingFace speech-to-speech，Apache-2.0；插件框架 deepseek-harness，MIT）。
素材均为自备的个人素材。
