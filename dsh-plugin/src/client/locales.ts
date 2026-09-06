/** `voice` namespace dictionaries (registered when dsh-client-locale is up). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.title': '语音通话',
  'panel.subtitle': '本地语音桥 · Qwen3-TTS 克隆',
  'mic.idle': '开始聆听',
  'mic.listening': '聆听中…再点一次停止',
  'mic.transcribing': '识别中…',
  'mic.speaking': '正在朗读回复…',
  'mic.error': '语音输入不可用',
  'voice.onHint': '开启语音朗读',
  'voice.offHint': '关闭语音朗读',
  'interrupt.onHint': '插话模式：说话打断当前回复并立即发送',
  'interrupt.offHint': '排队模式：当前回复读完后再自动接上',
  'persona.voiceHint': 'TTS 音色（说话的声音）',
  'bridge.ok': '桥接正常',
  'bridge.off': '桥接未连接',
  'bridge.ttsWarm': 'TTS 未加载（首次合成时加载）',
  'bridge.sttWarm': 'ASR 未加载（首次识别时加载）',
} satisfies Record<string, string>

/** The voice namespace key union. */
export type VoiceKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'panel.title': 'Voice call',
  'panel.subtitle': 'Local voice bridge · Qwen3-TTS clone',
  'mic.idle': 'Start listening',
  'mic.listening': 'Listening… click again to stop',
  'mic.transcribing': 'Transcribing…',
  'mic.speaking': 'Speaking the reply…',
  'mic.error': 'Voice input unavailable',
  'voice.onHint': 'Turn on voice reading',
  'voice.offHint': 'Turn off voice reading',
  'interrupt.onHint': 'Interrupt mode: speaking cuts the reply and sends immediately',
  'interrupt.offHint': 'Queue mode: waits for the current reply to finish',
  'persona.voiceHint': 'TTS voice (the speaking voice)',
  'bridge.ok': 'Bridge OK',
  'bridge.off': 'Bridge offline',
  'bridge.ttsWarm': 'TTS not loaded (loads on first synthesis)',
  'bridge.sttWarm': 'ASR not loaded (loads on first recognition)',
} satisfies Record<VoiceKey, string>
