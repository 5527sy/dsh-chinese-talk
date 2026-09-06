/**
 * 全局草稿写入器：面板组件不依赖槽位注入，而是通过这里调用插件 apply
 * 里注册的实现（apply 持有 ctx，可实时解析“当前会话”再写输入框）。
 */
export type DraftWriter = (text: string) => string | null

let writer: DraftWriter | null = null

export function setDraftWriter(next: DraftWriter | null): void {
  writer = next
}

/**
 * 把识别文本追加进当前会话输入框草稿。
 * @returns null 成功；否则返回面向面板的中文错误说明。
 */
export function appendDraftText(text: string): string | null {
  if (writer === null) return '录音功能未就绪'
  return writer(text)
}
