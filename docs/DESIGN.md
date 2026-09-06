# 设计说明：语音交互实现细节

## 1. 目标与取舍

| 需求 | 决定 | 理由 |
|---|---|---|
| 引擎 | 本机 FunASR + Qwen3-TTS-Base（PyPI `speech-to-speech` 提供 Qwen3TTSHandler） | 纯 Windows、无 WSL2、中文优先、参考音频克隆 |
| 输入交互 | 「点开→连续聆听→按句自动发送」 | 贴近实时对话；V1 采纳参考仓库语义 |
| 打断 | V1 即支持 barge-in（插话/排队双模式） | 说话即打断朗读并立即发送 |
| UI | 侧边栏「语音通话」面板（对话区右侧固定列） | 语音控制集中；不依赖 shell 侧栏槽位版本差异 |
| 范围 | 只做语音通话（无数字人/QQ/素材窗） | 明确主线、降低部署面 |

## 2. 链路（谁调用谁）

```
AudioWorklet mic-capture（48k→16k Int16，40ms/块 + RMS）
  └ MicRecorder（主线程端点：RMS≥0.01 起说；静音 1.8s 切句；30s 硬上限；
                噪声门 -35dB 在 worklet 内）
      └ onUtterance → POST /api/stt（FunASR，~150ms/句）
          └ 文本非空 → sendText()：session.prompt(text, steer|queue)
              · 助手回复流式到来（assistant-step 节点）
                  └ ReplySpeakerMount：splitSentences 切句（。！？!?…）
                     → 串行 POST /api/tts → ReplySpeaker FIFO 顺序播放
                      （下一句合成与上一句播放重叠）
  · 朗读期间麦克风仍在采集：
      recorder.setInterruptMode(true) → 每块推 /api/vad（silero）
      → 收到 speech_start（真人说话 ≥384ms）→ interruptReply()
          · speaker.stop()（停当前句+清队列）
          · abort 在途 /api/tts 请求（桥端协作取消，立即释放 GPU）
          · 记录被中断回复的 anchor → 仅吞掉该回复剩余句子，新回复照常读
```

## 3. 关键实现点（对照源码）

### 3.1 采集（`worklets/mic-capture.ts` + `voice/recorder.ts`）
- worklet 内嵌字符串，经 Blob URL 注册（tsdown 无 `?raw`）。
- 降采样到 16k 后组 40ms Int16 LE 块，每块带 RMS；噪声门（attack/hold/release 包络）
  在 worklet 内做，`noiseGateDb` 通过 `postMessage({kind:'gate'})` 开启。
- 端点：说话开始才累计；静音 ≥ `minSilenceMs`(1.8s) flush 成一句 PCM16；
  30s 硬上限防粘连。**连续聆听由调用方（面板）保持 recorder 不停止实现。**

### 3.2 发送语义（`client/index.ts` sendText）
- 同一句子在 agent 仍在跑时用 `steer`（打断当前回合立即处理，避免「第二句卡住」），
  排队模式用 `queue`。模式读 localStorage `s2s.voice.interrupt`。

### 3.3 回复监听（`voice/reply-listener.tsx`）
- 每会话一个隐藏组件，`useChat` 订阅会话节点（`assistant-step`：anchorSeq/key/status/blocks）。
- 切分只认完整句；`partial`（未终结尾部）在节点 `settled` 时补读一次；
  纯标点碎句（流式中的「！？」等）不进 TTS。
- **历史防重播**：等第一个 settled 节点出现后把基线冻在最大 anchor，
  已存在的旧回复永不朗读；运行中的新回复不受基线影响。
- **打断防误吞**：只跳过「被中断那条回复」的精确 anchor——新出现的回复照常朗读
  （避免用「≤max 范围跳过」误吞后续新回复的 bug）。

### 3.4 播放（`voice/speaker.ts`）
- AudioContext + FIFO：一句播完立即接下一句；generation counter + `stop()`
  使「已排队未开始」的片段在打断时立即作废。
- `speaking` 状态广播给面板（「正在朗读回复…」）和麦克风回声防护
  （朗读期间把采集切成 VAD 打断监听，避免把自己的朗读识别成新句子）。

### 3.5 VAD 打断（桥 `/api/vad` + `bridge.ts VadStream`）
- 浏览器 RMS 分不清真人声与 TTS 回声 → 播放期间麦克风数据流式送到桥端 silero VAD，
  真人说话 ≥384ms 才回 `speech_start`；数据不落盘。
- 桥不可达/旧版时回退 RMS 启发式（interruptThreshold 0.06 / hold 250ms / confirm 180ms）。

### 3.6 音色克隆（桥 `/api/persona/*` + 面板下拉）
- `voices/<名>/{ref_audio.*, ref_text.txt}` 启动时扫描；默认音色取
  `persona.default_voice`，否则第一个。
- Qwen3 克隆质量依赖「参考音频与参考文本逐字一致」；切换音色 = 热改
  handler.ref_audio/ref_text，下一句合成即生效（不用重载模型）。

## 4. DSH 契约（版本适配点）

- 槽位：`conversation.input.left`（隐藏回复监听 + 右侧面板，order 88/89）。
- 注入服务：`slots`/`locale`/`sessions`；`ctx.sessions.binding(sid).session.prompt`。
- 类型依赖（编译期）：`dsh-client-ui-slots`、`dsh-client-ui-conversation/client`、
  `dsh-client-ui-chat/client`（`useChat`/`AssistantChatData`）。
- **要求 dsh 0.1.3+**。rc.8 的会话节点在 `snapshot.chat.nodes`，0.1.3 移到
  `useChat` 视图（本插件按 0.1.3 编写）。升级到 0.1.3 即满足；本机若低于此版本需先升级。

## 5. 延迟预算（参考实测量级）

| 段 | 量级 |
|---|---|
| ASR（FunASR 中文） | ~150ms/句 |
| LLM 首字 | DSH/DeepSeek 现有时延 |
| TTS 逐句合成 | Qwen3-TTS 热态 ~2s 内出音（模型已预热） |
| 首音体验 | 完整句到达后即开始合成播放，不用等整段回复 |

## 6. 未做 / 可扩展

- 数字人视频、QQ 推送（原项目有，本插件裁剪）。
- 端到端语音模型（Qwen2.5-Omni 等）做全双工：与本插件的「ASR+DeepSeek+TTS 级联」是
  两条路线；级联保留 DeepSeek 的工具/推理能力且显存占用小得多。
- 面板吸附位置、主题变量适配、VAD 灵敏度调节均可在 `VoiceSidebar.module.css` /
  `bridge-config.json` 调整。
