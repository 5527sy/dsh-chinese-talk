/**
 * Voice recorder client plugin entry — V1/V2.1 (deepseek-harness dsh 0.1.3-alpha API).
 *
 * 右侧栏（conversation.input.dock）：点击开始录音 → 点击结束，把整段音频
 * 上传到本机 record-sink(:8766) 存成 MP3（结束时刻命名）；
 * V2.1 存完后自动请求 sink /api/stt 做中文识别，识别文本「追加」进当前
 * 会话输入框草稿（appendDraft，换行分隔，不自动发送）。
 *
 * 填入输入框的权威路径（与 ui-commands 一致）：
 *   sessions.scope(sid) → actx.get('conversation') → conversation.input.for(actx)
 *   → 读 state 当前草稿 → setDraft(旧草稿 + 换行 + 新文本)
 * 任一环节失败都把原因返回给面板日志，绝不静默跳过、绝不自动发送。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: Session Controller client augment (ctx.sessions binding/scope).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: locale plugin Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: conversation service merge + `conversation.input.dock` slot map.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { VoiceSidebar } from './VoiceSidebar.tsx'
import type { VoiceInjected } from './contract.ts'
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

function resolveInput(
  ctx: Context,
  sessionId: SessionId,
): { input: DraftInput | undefined; reason?: string } {
  const sessionsAny = ctx.sessions as unknown as {
    scope?: (id: SessionId) => AnyScope | undefined
    binding?: (id: SessionId) => { ctx?: AnyScope } | undefined
  }
  // 权威路径：sessions.scope(id)（ui-commands 同款）。
  let actx = sessionsAny.scope?.(sessionId)
  if (actx === undefined) {
    // 兜底：binding.ctx。
    const binding = sessionsAny.binding?.(sessionId)
    actx = binding?.ctx
  }
  if (actx === undefined) return { input: undefined, reason: '未取到会话作用域' }
  const conversation = (actx.get?.('conversation') ?? actx.conversation) as
    | { input?: { for?: (scope: unknown) => unknown } }
    | undefined
  if (conversation === undefined) return { input: undefined, reason: '会话上无 conversation 服务' }
  const input = conversation.input?.for?.(actx) as DraftInput | undefined
  if (input === undefined) return { input: undefined, reason: '无输入框门面(input.for)' }
  if (typeof input.setDraft !== 'function') return { input: undefined, reason: '输入框无 setDraft' }
  return { input }
}

/**
 * 识别文本追加进该会话输入框草稿（读当前草稿 → 换行分隔 → setDraft）。
 * 只填不发送。返回 null 成功 / 中文错误说明（供面板日志展示）。
 */
function appendToDraft(ctx: Context, sessionId: SessionId, text: string): string | null {
  if (sessionId === undefined || text === '') return '无会话或空文本'
  const { input, reason } = resolveInput(ctx, sessionId)
  if (input === undefined) return reason ?? '输入框不可用'
  if (typeof input.setDraft !== 'function') return '输入框无 setDraft'
  try {
    const current = (input.state?.getSnapshot?.()?.draft as string | undefined) ?? ''
    const prefix = current === '' ? '' : '\n'
    const next = `${current}${prefix}${text}`
    input.setDraft(next)
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
  console.log('[ui-voice-call] V2.1 loaded (record -> MP3 :8766, ASR -> draft)')

  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice-call: dictionaries')
  } catch (err) {
    console.warn('[ui-voice-call] locale register skipped:', err)
  }

  const injectFace = (sessionId: SessionId | undefined): VoiceInjected => ({
    appendDraft: (text: string) => {
      if (sessionId === undefined) return '无会话（请在对话页操作）'
      return appendToDraft(ctx, sessionId, text)
    },
  })

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'voice-call',
    order: 80,
    locale: NS,
    inject: injectFace,
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
