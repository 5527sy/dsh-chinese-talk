/**
 * Root-level reply listener (deepseek-harness dsh 0.1.3-alpha).
 *
 * Speaks finalized assistant text through the shared ReplySpeaker. It
 * subscribes to `ctx.on('session/event')` and acts on committed
 * `assistant/message` events — no chat-view seat hooks involved, so the
 * plugin keeps working across conversation-UI refactors.
 *
 * Behaviour mirrors the original design: markdown is cleaned, the text is
 * split into Chinese/English sentences and each sentence is synthesized in a
 * serial chain and played back through a FIFO (pipelined synthesis).
 * Barge-in swallows only the remainder of the reply that was talking.
 */
import type { Context } from '@deepseek-ai/cordis'
import { tts } from '../bridge.ts'
import { cleanReplyText } from './clean.ts'
import { splitSentences } from './sentences.ts'
import type { ReplySpeaker } from './speaker.ts'

const VOICE_ENABLED_KEY = 's2s.voice.enabled'

function voiceEnabled(): boolean {
  try {
    return localStorage.getItem(VOICE_ENABLED_KEY) !== '0'
  } catch {
    return true
  }
}

/** Host wiring shared with the plugin apply (speaker/abort/interrupt). */
export interface ReplyListenerHost {
  speaker: ReplySpeaker
  registerTtsAbort: (controller: AbortController | null) => void
  registerInterruptHandler: (handler: (() => void) | null) => void
}

/** Extract plain text from an `assistant/message` message payload (resilient). */
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

/** Loose structural view of the session/event tuple we subscribe to. */
interface RoughEvent {
  type?: string
  seq?: number
  time?: number
  data?: {
    turn?: number
    interrupted?: boolean
    message?: unknown
  }
}

/**
 * Subscribe the reply listener. Returns a disposer.
 * @param ctx - client root context (must expose `session/event`).
 * @param host - shared speaker/abort/interrupt wiring.
 */
export function mountReplyListener(ctx: Context, host: ReplyListenerHost): { dispose: () => void } {
  const mountTime = Date.now()
  /** Last spoken assistant turn per session id (string key). */
  const lastTurn = new Map<string, number>()
  /** Set by a mic barge-in: swallow the interrupted reply's remaining messages. */
  let swallowNext = false
  /** Serial synthesis chain (order preserved; playback pipelines via the FIFO). */
  let tail: Promise<void> = Promise.resolve()

  host.registerInterruptHandler(() => {
    swallowNext = true
  })

  const onEvent = (_session: unknown, raw: unknown): void => {
    const event = raw as RoughEvent
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return
    const session = _session as { sessionId?: unknown } | null
    const sid = session?.sessionId
    if (sid === undefined) return
    const key = String(sid)
    // History replay guard: events older than plugin mount never speak.
    if (typeof event.time === 'number' && event.time < mountTime) return
    const data = event.data ?? {}

    // A new user utterance clears the swallow flag so the NEXT reply speaks.
    if (event.type === 'user/message') {
      swallowNext = false
      return
    }
    if (event.type !== 'assistant/message') return
    if (!voiceEnabled()) return
    if (data.interrupted === true) return

    const turn = typeof data.turn === 'number' ? data.turn : 0
    if (swallowNext) {
      const last = lastTurn.get(key) ?? 0
      if (turn <= last) return // swallow the interrupted reply's remainder
      swallowNext = false
    }

    const clean = cleanReplyText(extractMessageText(data.message), 100000)
    if (clean.trim().length < 2) return
    lastTurn.set(key, turn)

    const { sentences, partial } = splitSentences(clean)
    const speakable = partial !== null ? [...sentences, partial] : sentences
    if (speakable.length === 0) return

    // Serial sentence synthesis; each step re-checks the voice gate / swallow.
    tail = speakable.reduce(
      (chain, sentence) => chain.then(() => {
        if (!voiceEnabled()) return
        const controller = new AbortController()
        host.registerTtsAbort(controller)
        return tts(sentence, controller.signal)
          .then((wav) => {
            if (voiceEnabled()) host.speaker.speak(wav)
          })
          .catch((err: unknown) => {
            const name = (err as Error | undefined)?.name
            if (name !== 'AbortError') console.error('[ui-voice-call] reply TTS failed:', err)
          })
          .finally(() => host.registerTtsAbort(null))
      }),
      tail,
    )
  }

  // Runtime `session/event` is routed by the client connection transport; the
  // Events key augmentation lives in that package, so bridge the typed surface
  // rather than importing it here (keeps this file dependency-light).
  const emit = (ctx as unknown as {
    on: (event: string, handler: (session: unknown, event: unknown) => void) => (() => void) | void
  }).on

  const off = emit('session/event', onEvent)
  return {
    dispose: () => {
      swallowNext = false
      if (typeof off === 'function') off()
      host.registerInterruptHandler(null)
    },
  }
}
