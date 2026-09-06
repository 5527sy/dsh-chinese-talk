/**
 * ui-voice-call slot contract: the injected face the plugin `apply` provides
 * to the conversation-seat components. Everything the panel needs is session
 * bound: recognized text can be filled into the composer draft (setDraft via
 * the session-scope conversation input facade), plus the shared
 * playback/abort/interrupt wiring.
 */

import type { ReplySpeaker } from './voice/speaker.ts'

/** Injected behavior face the voice components receive from the plugin apply. */
export interface VoiceInjected {
  /**
   * Fill the composer input of the bound session with `text` (the user then
   * reviews and presses Enter). No-op when the session's conversation input
   * facade is unavailable (logged to the on-screen voice log).
   */
  fillComposer: (text: string) => void
  /**
   * Send a recognized utterance into the current session as a user prompt
   * (fallback / quick-send). Rejects when no session scope is available.
   * @param text - recognized utterance text.
   */
  sendText: (text: string) => Promise<void>
  /** Plays synthesized reply audio; one shared instance per plugin fiber. */
  speaker: ReplySpeaker
  /** Abort any TTS request currently in flight (turning voice off / barge-in). */
  abortTts: () => void
  /**
   * Mic barge-in: stop playback, abort the in-flight TTS request, and ask the
   * reply listener to swallow the rest of the current reply.
   */
  interruptReply: () => void
  /** Internal wiring (plugin-private): register the current TTS AbortController. */
  _registerTtsAbort: (controller: AbortController | null) => void
  /** Internal wiring (plugin-private): register the barge-in swallow handler. */
  _registerInterruptHandler: (handler: (() => void) | null) => void
}
