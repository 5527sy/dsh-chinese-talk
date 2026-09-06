# dsh-plugin — DSH 客户端语音通话插件

把 `dsh-plugin\` 整个复制进 deepseek-harness 源码树的
`packages\client\ui-voice-call\`，注册三处并构建后，即可在 Web 界面获得：
右侧「语音通话」侧边栏（麦克风连续聆听/按句自动发送、🔊朗读、⚡插话-排队、
🎚️音色切换）+ 隐藏的按句流式朗读监听。

桥接地址默认 `http://127.0.0.1:8765`，可用 localStorage 覆盖：`s2s.voice.bridge`。

## 组件职责

| 文件 | 职责 |
|---|---|
| `client/index.ts` | 插件入口：注册隐藏回复监听 + 侧边栏面板；`sendText`（steer/queue） |
| `client/VoiceSidebar.tsx` | 侧边栏语音通话面板（麦克风/开关/音色/状态） |
| `client/voice/recorder.ts` | 采集 + 静音端点（1.8s）+ 打断监听 |
| `client/worklets/mic-capture.ts` | 内嵌 16k/40ms/RMS/噪声门 worklet |
| `client/voice/reply-listener.tsx` | 回复按句切分 → 逐句 TTS → 打断吞剩余 |
| `client/voice/speaker.ts` | AudioContext FIFO 播放队列（可打断） |
| `client/voice/sentences.ts` / `clean.ts` | 中文句子切分 / markdown 清理 |
| `client/bridge.ts` | 桥 HTTP 客户端 + silero VAD WebSocket |
| `client/contract.ts` | 注入接口（sendText/speaker/打断） |

## 注册（三处，详见 docs/INSTALL.md 第 6 节）

1. `<HARNESS>\tsconfig.client.json` references：`{ "path": "./packages/client/ui-voice-call" }`
2. `<HARNESS>\packages\bundle\web-app\cordis.patch.yml`：
   ```yaml
   - id: ui-voice-call
     name: '@deepseek-ai/dsh-client-ui-voice-call'
   ```
3. `<HARNESS>\packages\bundle\web-app\package.json` dependencies：
   `"@deepseek-ai/dsh-client-ui-voice-call": "workspace:^"`

## 构建

```powershell
cd <HARNESS>
pnpm install
pnpm exec tsc -b packages/client/ui-voice-call/tsconfig.json
pnpm --filter @deepseek-ai/dsh-client-ui-voice-call bundle
```

重启 dsh web，控制台应输出 `[ui-voice-call] loaded, bridge = http://127.0.0.1:8765`。

> 依赖 dsh 0.1.3+（`conversation.input.left` 座位 + `useChat` 会话视图）。
