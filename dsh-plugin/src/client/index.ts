/**
 * Voice recorder client plugin entry — V1 (deepseek-harness dsh 0.1.3-alpha API).
 *
 * V1 范围：右侧栏（conversation.input.dock）一个按住说话的录音按钮，
 * 松开后把整段 16 kHz 录音以 WAV 上传到本机 record-sink(:8766)，
 * 由 sink 用 ffmpeg 转成 MP3 保存到 D:\dsh_workspeace\vocal\master。
 * 面板自带活动日志，便于无控制台验收。
 *
 * 不依赖会话服务、不做 STT/TTS/打断 —— 后续版本逐版加入。
 */
import type { Context } from '@deepseek-ai/cordis'
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
export const inject = ['slots', 'locale']

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
function applyImpl(ctx: Context): void {
  console.log('[ui-voice-call] V1 loaded (record -> MP3 sink :8766)')

  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice-call: dictionaries')
  } catch (err) {
    console.warn('[ui-voice-call] locale register skipped:', err)
  }

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'voice-call',
    order: 80,
    locale: NS,
    inject: (): VoiceInjected => ({}),
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
