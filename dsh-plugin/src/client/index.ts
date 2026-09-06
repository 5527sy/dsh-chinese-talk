/**
 * Voice recorder client plugin entry — V1/V2.1 (deepseek-harness dsh 0.1.3-alpha API).
 *
 * UI 挂载在 ui-layout 提供的 `shell.overlay`（整壳浮层，root 级、任何对话状态
 * 包括「思考/回答中」都常驻），因此录音面板不会因会话内部状态被卸载。
 *
 * 功能：点 🎙️ 开始录音 → 点击结束 → 上传 record-sink(:8766) 存 MP3（结束时刻
 * 命名）→ 自动 /api/stt 中文识别 → 文本「追加」进当前会话输入框草稿
 * （不自动发送；多条换行接着排）。
 *
 * 写草稿的权威路径（与 ui-commands 一致）：
 *   sessions.list.getSnapshot().current  → 当前会话 id
 *   sessions.scope(sid) → actx.get('conversation') → conversation.input.for(actx)
 *   → 读 state 草稿 → setDraft(旧 + 换行 + 新文本)（并校验是否生效）
 * 任一环节失败都返回中文原因给面板日志，绝不静默、绝不自动发送。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: Session Controller client augment (ctx.sessions binding/scope/list).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: locale plugin Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: ui-layout slot map merge (shell.overlay)。
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { VoiceSidebar } from './VoiceSidebar.tsx'
import { setDraftWriter } from './voice/draft.ts'
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

/** 会话作用域 ctx 的最小结构（避免依赖具体类型，运行时按真实对象取）。 */
interface AnyScope {
  get?: (key: string) => unknown
  conversation?: unknown
}

/** 输入框门面（SessionInput 的结构子集）。 */
interface DraftInput {
  setDraft?: (text: string) => void
  state?: { getSnapshot?: () => { draft?: string } | undefined }
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
    // 校验写入是否生效（回答进行中等状态若编辑器拒写，这里能暴露）。
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

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
function applyImpl(ctx: Context): void {
  console.log('[ui-voice-call] V2.1 loaded (shell.overlay; record -> MP3 :8766, ASR -> draft)')

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
