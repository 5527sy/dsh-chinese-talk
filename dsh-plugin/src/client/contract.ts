/**
 * ui-voice-call 槽位契约。
 *
 * V1: 录音存 MP3。V2.1: 识别文本追加进输入框草稿（不自动发送）。
 * face 由插件 apply 按会话注入（conversation.input.dock 为 session 作用域）。
 */
export interface VoiceInjected {
  /**
   * 把一段识别文本「追加」到当前会话输入框草稿末尾（换行分隔），不发送。
   * @returns 成功返回 null；失败返回面向面板的中文错误说明。
   */
  appendDraft?: (text: string) => string | null
}
