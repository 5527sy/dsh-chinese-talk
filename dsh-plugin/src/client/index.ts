/**
 * Voice-call client plugin entry (deepseek-harness dsh 0.1.3-alpha API).
 *
 * Panel (conversation.input.dock): push-to-talk mic — hold to record, release
 * to transcribe and FILL the composer draft (setDraft via the session-scope
 * conversation input facade) for manual review / Enter-to-send.
 *
 * Reply reading: per-session subscription to `binding.session.eventSource`
 * (the browser-side session event window). Finalized `assistant/message`
 * events are cleaned, split into sentences and spoken sentence-by-sentence
 * through the shared ReplySpeaker; barge-in stops playback and swallows the
 * rest of the interrupted reply.
 *
 * Bridge: http://127.0.0.1:8765 (override: localStorage `s2s.voice.bridge`).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: Session Controller client augment (ctx.sessions binding/SessionFace).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: locale plugin Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: conversation service merge + `conversation.input.dock` slot map.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { VoiceSidebar } from './VoiceSidebar.tsx'
import { ReplySpeaker } from './voice/speaker.ts'
import { tts } from './bridge.ts'
import { cleanReplyText } from './voice/clean.ts'
import { splitSentences } from './voice/sentences.ts'
import { bridgeBase } from './bridge.ts'
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
export const inject = ['slots', 'sessions', 'locale']

const VOICE_ENABLED_KEY = 's2s.voice.enabled'

function voiceEnabled(): boolean {
  try {
    return localStorage.getItem(VOICE_ENABLED_KEY) !== '0'
  } catch {
    return true
  }
}

/** Loose structural views of the session event window types (browser feed). */
type LiveEntry = { type?: string; event?: unknown }
type LiveWindow = { change?: unknown; entries?: readonly LiveEntry[] }

/** Pick the incremental entries worth reacting to (never history pages). */
function liveEntriesOf(change: unknown): readonly LiveEntry[] {
  if (change === null || typeof change !== 'object') return []
  const c = change as { kind?: string; entries?: readonly LiveEntry[]; entry?: LiveEntry }
  if (c.kind === 'append') return c.entries ?? []
  if (c.kind === 'settle-assistant') return c.entry !== undefined ? [c.entry] : []
  // 'replace' / 'prepend' = history loads: never replay spoken content.
  return []
}

function extractMessageText(message: unknown): string {
  if (message === null || message === undefined) return ''
  if (typeof message === 'string') return message
  const obj = message as Record<string, unknown>
  const blockList = (obj as { blocks?: unknown }).blocks
  if (Array.isArray(blockList)) {
    const parts: string[] = []
    for (const block of blockList) {
      if (block === null || block === undefined) continue
      if (typeof block === 'string') {
        parts.push(block)
      } else if (typeof block === 'object') {
        const b = block as Record<string, unknown>
        const kind = b.kind ?? b.type
        const text = b.text ?? b.content
        if (kind !== undefined && kind !== 'text') continue
        if (typeof text === 'string') parts.push(text)
      }
    }
    return parts.join('\n')
  }
  if (typeof obj.content === 'string') return obj.content
  if (typeof obj.text === 'string') return obj.text
  return ''
}

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
function applyImpl(ctx: Context): void {
  console.log('[ui-voice-call] loaded, bridge =', bridgeBase())

  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice-call: dictionaries')
  } catch (err) {
    console.warn('[ui-voice-call] locale register skipped:', err)
  }

  const speaker = new ReplySpeaker()

  // ── shared on-screen activity log (visible in the panel footer) ───────────
  const g = (window as unknown as { __voiceLog?: string[] }).__voiceLog ??= []
  const vlog = (msg: string): void => {
    g.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`)
    if (g.length > 50) g.splice(0, g.length - 50)
  }
  vlog('插件启动')

  // ── shared TTS abort / barge-in wiring ────────────────────────────────────
  let activeTtsController: AbortController | null = null
  let interruptHandler: (() => void) | null = null
  const registerTtsAbort = (c: AbortController | null): void => { activeTtsController = c }
  const registerInterruptHandler = (h: (() => void) | null): void => { interruptHandler = h }

  // ── per-session reply speaking over the browser event window ──────────────
  const sessionSubs = new Map<string, { off: (() => void) | undefined; tail: Promise<void>; lastTurn: number }>()
  /** Swallow the interrupted reply (set by mic barge-in, cleared by a user message). */
  let swallowCurrent = false

  const speakSessions = (sessionId: SessionId, window: LiveWindow): void => {
    const key = String(sessionId)
    const state = sessionSubs.get(key)
    if (state === undefined) return
    for (const entry of liveEntriesOf(window.change)) {
      if (entry.type !== 'event') continue
      const evt = entry.event as { type?: string; data?: { turn?: number; interrupted?: boolean; message?: unknown } }
      if (evt === null || typeof evt !== 'object' || typeof evt.type !== 'string') continue
      const data = evt.data ?? {}
      if (evt.type === 'user/message') {
        swallowCurrent = false
        continue
      }
      if (evt.type !== 'assistant/message') continue
      if (!voiceEnabled()) return
      if (data.interrupted === true) continue
      const turn = typeof data.turn === 'number' ? data.turn : 0
      if (swallowCurrent) {
        if (turn <= state.lastTurn) continue // swallow the interrupted reply's remainder
        swallowCurrent = false
      }
      const clean = cleanReplyText(extractMessageText(data.message), 100000)
      vlog(`收到助手消息(turn=${turn}, ${clean.length}字)`)
      if (clean.trim().length < 2) continue
      state.lastTurn = turn
      const { sentences, partial } = splitSentences(clean)
      const speakable = partial !== null ? [...sentences, partial] : sentences
      if (speakable.length === 0) continue
      vlog(`将朗读 ${speakable.length} 句`)
      state.tail = speakable.reduce(
        (chain, sentence) => chain.then(() => {
          if (!voiceEnabled() || swallowCurrent) return
          const controller = new AbortController()
          registerTtsAbort(controller)
          return tts(sentence, controller.signal)
            .then((wav) => {
              if (voiceEnabled() && !swallowCurrent) speaker.speak(wav)
            })
            .catch((err: unknown) => {
              const name = (err as Error | undefined)?.name
              if (name !== 'AbortError') console.error('[ui-voice-call] reply TTS failed:', err)
            })
            .finally(() => registerTtsAbort(null))
        }),
        state.tail,
      )
    }
  }

  const ensureSessionVoice = (sessionId: SessionId): void => {
    const key = String(sessionId)
    if (sessionSubs.has(key)) return
    const binding = ctx.sessions.binding(sessionId)
    const source = (binding?.session as unknown as {
      eventSource?: { subscribe: (l: () => void) => () => void; getSnapshot: () => unknown }
    } | undefined)?.eventSource
    if (source === undefined) return
    const state: { off: (() => void) | undefined; tail: Promise<void>; lastTurn: number } = {
      off: undefined,
      tail: Promise.resolve(),
      lastTurn: 0,
    }
    sessionSubs.set(key, state)
    state.off = source.subscribe(() => {
      const window = source.getSnapshot() as LiveWindow
      speakSessions(sessionId, window)
    })
  }

  ctx.effect(() => {
    registerInterruptHandler(() => { swallowCurrent = true })
    return () => registerInterruptHandler(null)
  }, 'ui-voice-call: swallow arm')
  ctx.effect(() => () => {
    registerInterruptHandler(null)
    for (const state of sessionSubs.values()) state.off?.()
    sessionSubs.clear()
    speaker.dispose()
  }, 'ui-voice-call: teardown')

  const injectFace = (sessionId: SessionId | undefined): VoiceInjected => {
    if (sessionId !== undefined) ensureSessionVoice(sessionId)

    const fillComposer = (text: string): void => {
      if (sessionId === undefined) return
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return
      // Session-scope conversation input facade: setDraft replaces the whole
      // composer draft (manual review, then Enter sends it).
      const actx = (binding as unknown as { ctx?: unknown }).ctx
      const conv = (actx as unknown as {
        conversation?: { input?: { for?: (scope: unknown) => unknown } }
      })?.conversation
      const input = conv?.input?.for?.(actx) as { setDraft?: (t: string) => void } | undefined
      if (input?.setDraft !== undefined) {
        input.setDraft(text)
      } else {
        console.warn('[ui-voice-call] conversation input facade unavailable; falling back to send')
        void sendText(text).catch(err => console.error('[ui-voice-call] fallback send failed:', err))
      }
    }

    const sendText = async (text: string): Promise<void> => {
      if (sessionId === undefined) throw new Error('[ui-voice-call] no session scope for sendText')
      const binding = ctx.sessions.binding(sessionId)
      const session = binding?.session
      if (session === undefined) throw new Error('[ui-voice-call] session unavailable for sendText')
      const running = session.getSnapshot()?.running === true
      let interrupt = true
      try {
        interrupt = localStorage.getItem('s2s.voice.interrupt') !== '0'
      } catch {
        interrupt = true
      }
      const mode = running && interrupt ? 'steer' : 'queue'
      const result = await session.prompt([{ type: 'text', text }], mode)
      if (!result.ok) {
        throw new Error(`[ui-voice-call] prompt failed: ${result.error.code}: ${result.error.message}`)
      }
    }

    return {
      fillComposer,
      sendText,
      speaker,
      abortTts: () => {
        activeTtsController?.abort()
        activeTtsController = null
      },
      interruptReply: () => {
        speaker.stop()
        activeTtsController?.abort()
        activeTtsController = null
        interruptHandler?.()
      },
      _registerTtsAbort: registerTtsAbort,
      _registerInterruptHandler: registerInterruptHandler,
    }
  }

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
