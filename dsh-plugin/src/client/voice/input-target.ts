/**
 * 语音识别结果的“落点”：
 * 1) 优先填进用户最后聚焦过的文本输入框（提问卡片、设置项、任意 textarea/input）——
 *    用原生 setter + input 事件，保证 React 受控组件也能收到。
 * 2) 没有可用输入框时，回退给插件主写入器 appendDraftText（主对话输入框草稿）。
 */
import { appendDraftText } from './draft.ts'

type Editable = HTMLInputElement | HTMLTextAreaElement

export interface InsertResult {
  ok: boolean
  /** 'input' = 已填入页面输入框 / 'composer' = 已追加到主输入框 / 其他=失败原因 */
  where: string
  message?: string
}

let lastEditable: Editable | null = null
let tracking = false

function isUsableEditable(el: EventTarget | null): el is Editable {
  if (el instanceof HTMLTextAreaElement) {
    return !el.disabled && !el.readOnly
  }
  if (el instanceof HTMLInputElement) {
    const t = (el.type || 'text').toLowerCase()
    return !el.disabled && !el.readOnly && !['checkbox', 'radio', 'button', 'submit', 'range', 'file', 'hidden', 'color'].includes(t)
  }
  return false
}

/** 绑定一次全局 focusin：记住用户最近聚焦的可输入框（点我们自己的按钮不算）。 */
export function ensureFocusTargetTracking(): void {
  if (tracking || typeof window === 'undefined') return
  tracking = true
  window.addEventListener('focusin', (e) => {
    if (isUsableEditable(e.target)) lastEditable = e.target
  }, true)
}

function setNativeValue(el: Editable, value: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
  if (descriptor !== undefined && typeof descriptor.set === 'function') {
    descriptor.set.call(el, value)
  } else {
    el.value = value
  }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

/** 把识别文本放进目标落点。 */
export function insertRecognizedText(text: string): InsertResult {
  ensureFocusTargetTracking()
  const el = lastEditable
  if (el !== null && el.isConnected && isUsableEditable(el)) {
    const current = el.value ?? ''
    const separator = current === '' ? '' : current.endsWith('\n') ? '' : '\n'
    const next = `${current}${separator}${text}`
    setNativeValue(el, next)
    try {
      el.focus({ preventScroll: false })
      el.scrollTop = el.scrollHeight
      el.setSelectionRange(next.length, next.length)
    } catch { /* ignore */ }
    return { ok: true, where: 'input', message: '已填入页面输入框' }
  }
  // 回退：主对话输入框草稿
  const err = appendDraftText(text)
  if (err === null || err === undefined) {
    return { ok: true, where: 'composer', message: '已追加到主输入框' }
  }
  return { ok: false, where: 'failed', message: err }
}
