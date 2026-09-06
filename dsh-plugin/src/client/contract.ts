/**
 * ui-voice-call V1 slot contract.
 *
 * V1 只做「按住录音 → MP3 落盘到本机 vocal/master」，不依赖任何会话服务，
 * 因此注入 face 为空。后续版本（语音转文字填入输入框 / 克隆音色朗读 / 打断）
 * 再在 VoiceInjected 上扩展会话绑定能力。
 */
export interface VoiceInjected {
  // V1: 无注入能力。保留空接口以便后续版本在不动槽位契约的情况下扩展。
}
