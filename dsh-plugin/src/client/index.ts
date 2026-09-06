/**
 * Voice recorder client plugin entry — V1~V3 (deepseek-harness dsh 0.1.3-alpha API).
 *
 * UI 挂在 ui-layout `shell.overlay`（整壳浮层，root 级常驻）。
 * 功能：
 *  - 点 🎙️ 开始录音 → 点击结束 → record-sink(:8766) 存 MP3（结束时刻命名）
 *  - 自动 /api/stt 中文识别 → 文本智能填入「最后点过的输入框」，否则追加主输入框
 *  - V3.1：当前会话「正式回答」→ txt 存到 vocal/answer
 *  - V3：正式回答用克隆音色朗读（服务端合成+ffplay 播放，参考 dsh-speak 思路）
 *
 * 事件流契约：binding.eventSource（SessionEventWindow）。
 * 回答判定：以 append 里的 `turn/end`（回合结束）为准 → 反扫窗口取该回合最后
 * 一条 assistant/message 的完整文本；无 turn/end 时以 running=false 兜底。
 * message 真实结构：{ role, content:[{type:'text',text}] , id }。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: Session Controller client augment (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: locale plugin Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: ui-layout slot map merge (shell.overlay)。
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { VoiceSidebar } from './VoiceSidebar.tsx'
import { setDraftWriter } from './voice/draft.ts'
import { log } from './voice/log-bus.ts'
import { reader } from './voice/read-aloud.ts'
import { en, zh, type VoiceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The voice panel's copy. */
    voice: VoiceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'voice'

/** Required services. */
export const inject = ['slots', 'locale', 'sessions']

/** 会话作用域 ctx 的最小结构（避免依赖具体类型）。 */
interface AnyScope {
  get?: (key: string) => unknown
  conversation?: unknown
}

/** 输入框门面（SessionInput 的结构子集）。 */
interface DraftInput {
  setDraft?: (text: string) => void
  state?: { getSnapshot?: () => { draft?: string } | undefined }
}

/** 事件窗口条目/快照最小结构。 */
interface WinEntry {
  type?: string
  event?: {
    type?: string
    data?: { turn?: number; message?: unknown; interrupted?: boolean }
  }
}

interface EventWindow {
  entries?: readonly WinEntry[]
  change?: {
    kind?: string
    entries?: readonly WinEntry[]
    entry?: WinEntry
  }
}

/** 取当前会话的输入框门面。 */
function resolveInput(
  ctx: Context,
): { input: DraftInput | undefined; reason?: string } {
  const sessionsAny = ctx.sessions as unknown as {
    list?: { getSnapshot?: () => { current?: SessionId } | undefined }
    scope?: (id: SessionId) => AnyScope | undefined
  }
  const current = sessionsAny.list?.getSnapshot?.()?.current
  if (current === undefined) {
    return { input: undefined, reason: '无当前会话（请先打开一个对话）' }
  }
  let actx = sessionsAny.scope?.(current)
  if (actx === undefined) {
    return { input: undefined, reason: '未取到会话作用域' }
  }
  const conversation = (actx.get?.('conversation') ?? actx.conversation) as
    | { input?: { for?: (scope: unknown) => unknown } }
    | undefined
  if (conversation === undefined) {
    return { input: undefined, reason: '会话上无 conversation 服务' }
  }
  const input = conversation.input?.for?.(actx) as DraftInput | undefined
  if (input === undefined) return { input: undefined, reason: '无输入框门面(input.for)' }
  if (typeof input.setDraft !== 'function') return { input: undefined, reason: '输入框无 setDraft' }
  return { input }
}

/** 追加进当前会话输入框草稿（换行分隔，不发送），成功 null / 失败中文原因。 */
function appendToCurrentDraft(ctx: Context, text: string): string | null {
  if (text === '') return '空文本'
  const { input, reason } = resolveInput(ctx)
  if (input === undefined) return reason ?? '输入框不可用'
  if (typeof input.setDraft !== 'function') return '输入框无 setDraft'
  try {
    const current = (input.state?.getSnapshot?.()?.draft as string | undefined) ?? ''
    const prefix = current === '' ? '' : '\n'
    const next = `${current}${prefix}${text}`
    input.setDraft(next)
    const after = (input.state?.getSnapshot?.()?.draft as string | undefined) ?? ''
    if (after !== next && !after.includes(text)) {
      return `写入未生效（当前草稿 ${after.length} 字，疑似编辑器忙碌中）`
    }
    console.log(`[ui-voice-call] draft appended: +${text.length} 字（共 ${next.length} 字）`)
    return null
  } catch (err) {
    console.warn('[ui-voice-call] appendDraft failed:', err)
    return `写入失败：${err instanceof Error ? err.message : String(err)}`
  }
}

/** sink 基址。 */
function sinkBase(): string {
  try {
    const v = localStorage.getItem('s2s.record.base')
    if (v !== null && v.trim() !== '') return v.trim().replace(/\/+$/, '')
  } catch { /* ignore */ }
  return 'http://127.0.0.1:8766'
}

/** 把一次正式回答保存为 txt（sink /api/answer -> vocal/answer）。返回中文说明。 */
async function saveAnswerText(text: string): Promise<string | null> {
  const clean = text.trim()
  if (clean === '') return '回答为空，未保存'
  try {
    const res = await fetch(`${sinkBase()}/api/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean }),
    })
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean
      file?: string
      bytes?: number
      error?: string
    } | null
    if (!res.ok || data === null || data.ok !== true) {
      return `保存失败：${data?.error ?? `HTTP ${res.status}`}`
    }
    const kb = typeof data.bytes === 'number' ? Math.round(data.bytes / 1024) : '?'
    log(`已保存回答 → ${data.file}（${clean.length} 字 / ${kb}KB）`)
    return null
  } catch (err) {
    return `保存失败：${err instanceof Error ? err.message : String(err)}`
  }
}

/** 从 assistant message 里取文本（支持 blocks/content 数组里的 text 块）。 */
function extractMessageText(message: unknown): string {
  if (typeof message === 'string') return message
  if (message === null || typeof message !== 'object') return ''
  const obj = message as Record<string, unknown>
  const parts: string[] = []
  for (const key of ['blocks', 'content']) {
    const arr = obj[key]
    if (!Array.isArray(arr)) continue
    for (const item of arr) {
      if (item === null || typeof item !== 'object') continue
      const blk = item as Record<string, unknown>
      const kind = blk.kind ?? blk.type
      if (kind !== undefined && kind !== 'text') continue
      const text = blk.text ?? blk.content
      if (typeof text === 'string') parts.push(text)
    }
  }
  if (parts.length > 0) return parts.join('\n')
  if (typeof obj.content === 'string') return obj.content
  if (typeof obj.text === 'string') return obj.text
  return ''
}

/** 反扫窗口取最后一个 assistant/message 文本（= 当前回合最终回答）。 */
function scanLatestAnswer(win: EventWindow | undefined): { turn: number; text: string } | null {
  const entries = win?.entries
  if (entries === undefined) return null
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry === null || typeof entry !== 'object' || entry.type !== 'event') continue
    const evt = entry.event
    if (evt === null || typeof evt !== 'object' || evt.type !== 'assistant/message') continue
    if (evt.data?.interrupted === true) continue
    const text = extractMessageText(evt.data?.message).trim()
    const turn = typeof evt.data?.turn === 'number' ? evt.data.turn : 0
    if (text !== '') return { turn, text }
  }
  return null
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
function applyImpl(ctx: Context): void {
  console.log('[ui-voice-call] V3 loaded (shell.overlay; record/STT/answer/speak via :8766)')

  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice-call: dictionaries')
  } catch (err) {
    console.warn('[ui-voice-call] locale register skipped:', err)
  }

  ctx.effect(() => {
    setDraftWriter((text: string) => appendToCurrentDraft(ctx, text))
    return () => setDraftWriter(null)
  }, 'ui-voice-call: draft writer')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'voice-call',
    order: 20,
    locale: NS,
  }, VoiceSidebar))

  // ── 当前会话正式回答 → 存 txt + 朗读 ────────────────────────────────────────
  ctx.effect(() => {
    const sessionsAny = ctx.sessions as unknown as {
      list?: { subscribe?: (fn: () => void) => () => void; getSnapshot?: () => { current?: SessionId } | undefined }
      binding?: (id: SessionId) => unknown
    }
    let offList: (() => void) | null = null
    let offSource: (() => void) | null = null
    let watchingSid: SessionId | null = null
    let attached = false
    let sourceRef: unknown = null
    let disposed = false
    const savedTurns = new Set<number>()

    const stopSource = (): void => {
      offSource?.()
      offSource = null
      attached = false
      sourceRef = null
    }

    const handleFinal = async (turn: number, text: string): Promise<void> => {
      if (disposed || savedTurns.has(turn) || text.trim() === '') return
      savedTurns.add(turn)
      log(`收到正式回答（turn ${turn}，${text.length} 字）`)
      const err = await saveAnswerText(text)
      if (err !== null && err !== undefined) log(err, true)
      // V3: 服务端合成+播放克隆音色朗读。
      if (reader.enabled) {
        void reader.speak(text)
      }
    }

    const onWindow = (sid: SessionId): void => {
      const binding = sessionsAny.binding?.(sid) as unknown as {
        session?: { getSnapshot?: () => { running?: boolean } }
        eventSource?: { subscribe?: (l: () => void) => () => void; getSnapshot?: () => unknown }
      } | undefined
      const session = binding?.session
      const src = binding?.eventSource
      if (src === undefined) return
      const win = src.getSnapshot?.() as EventWindow | undefined
      const c = win?.change
      if (win === undefined) return
      if (c === undefined) return

      const entries = c.kind === 'append'
        ? (c.entries ?? [])
        : c.kind === 'settle-assistant'
          ? (c.entry !== undefined ? [c.entry] : [])
          : []
      let sawTurnEnd = false
      let sawAssistant = false
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object' || entry.type !== 'event') continue
        const evt = entry.event
        if (evt === null || typeof evt !== 'object' || typeof evt.type !== 'string') continue
        if (evt.type === 'assistant/message') {
          if (evt.data?.interrupted === true) continue
          const msg = extractMessageText(evt.data?.message)
          if (msg.trim() !== '') sawAssistant = true
        } else if (evt.type === 'user/message') {
          savedTurns.clear() // 新一轮提问后允许再读/再存
        } else if (evt.type === 'turn/end') {
          sawTurnEnd = true
        }
      }
      // 正式回答 = 回合结束（或 running=false）时反扫窗口取最后一条助手消息。
      const running = session?.getSnapshot?.()?.running === true
      if (sawTurnEnd || (c.kind === 'append' && sawAssistant && !running)) {
        const found = scanLatestAnswer(win)
        if (found !== null) void handleFinal(found.turn, found.text)
      }
    }

    const follow = (): void => {
      if (disposed) return
      const sid = sessionsAny.list?.getSnapshot?.()?.current
      if (sid === undefined) {
        if (watchingSid !== null) {
          stopSource()
          watchingSid = null
        }
        return
      }
      if (sid !== watchingSid) {
        stopSource()
        watchingSid = sid
        log(`监听当前会话（${String(sid).slice(0, 8)}…）`)
      }
      const binding = sessionsAny.binding?.(sid) as unknown as { eventSource?: unknown } | undefined
      const currentSrc = binding?.eventSource
      if (attached && currentSrc !== sourceRef) stopSource()
      if (attached) return
      const src = currentSrc as
        | { subscribe?: (l: () => void) => () => void; getSnapshot?: () => unknown }
        | undefined
      if (src?.subscribe === undefined) return // binding 未就绪，下轮重试
      offSource = src.subscribe(() => onWindow(sid))
      attached = true
      sourceRef = currentSrc
      log(`已订阅会话回答事件（${String(sid).slice(0, 8)}…）`)
      onWindow(sid)
    }

    offList = sessionsAny.list?.subscribe?.(follow) ?? null
    follow()
    const timer = setInterval(follow, 1200) // binding 懒加载/重建兜底
    return () => {
      disposed = true
      clearInterval(timer)
      offList?.()
      stopSource()
    }
  }, 'ui-voice-call: final answer -> txt + speak')
}

/**
 * Public client entry with a crash banner: if anything in apply throws, paint
 * a readable red bar on screen (and log) so issues are visible without a
 * console walk.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  try {
    applyImpl(ctx)
    console.log('[ui-voice-call] boot OK')
  } catch (err) {
    const text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
    console.error('[ui-voice-call] apply failed:', err)
    try {
      setTimeout(() => {
        const el = document.createElement('div')
        el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#c0392b;color:#fff;' +
          'padding:10px 12px;font:12px/1.5 sans-serif;white-space:pre-wrap;word-break:break-all;'
        el.textContent = '[ui-voice-call 启动失败] ' + text
        document.body?.appendChild(el)
      }, 1200)
    } catch { /* banner best-effort */ }
  }
}
