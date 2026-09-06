/**
 * ReadAloud（V3，服务端播放版）—— 参考 dsh-speak 架构：
 * 插件只负责在事件流里挑「最终回复」，把整段文本交给本机 record-sink(:8766)；
 * sink 用 Qwen3 克隆音色合成，并 ffplay 在本机出声（串行队列、可停止），
 * 不依赖浏览器 autoplay。
 */
import { log } from './log-bus.ts'

const READ_KEY = 's2s.voice.read'
const RECORD_SINK_KEY = 's2s.record.base'
const DEFAULT_SINK = 'http://127.0.0.1:8766'
const POLL_MS = 600

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return raw !== '0'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch { /* ignore */ }
}

function sinkBase(): string {
  try {
    const v = localStorage.getItem(RECORD_SINK_KEY)
    if (v !== null && v.trim() !== '') return v.trim().replace(/\/+$/, '')
  } catch { /* ignore */ }
  return DEFAULT_SINK
}

/** 去掉明显不适合朗读的 Markdown/符号噪音。 */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/```[\s\S]*?```/g, '（代码省略）')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/\s+/g, ' ')
    .trim()
}

class ReadAloud {
  private _enabled: boolean
  private _speaking = false
  private listeners = new Set<() => void>()
  private pollTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this._enabled = readFlag(READ_KEY, true)
  }

  get reading(): boolean {
    return this._speaking
  }

  get enabled(): boolean {
    return this._enabled
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  setEnabled(value: boolean): void {
    if (this._enabled === value) return
    this._enabled = value
    writeFlag(READ_KEY, value)
    if (!value) void this.stop()
    this.emit()
  }

  /** 把一段最终回复交给 sink 串行朗读（自动清文本；服务端切段+播放）。 */
  async speak(text: string): Promise<void> {
    const clean = cleanForSpeech(text)
    if (clean === '') return
    if (!this._enabled) return
    if (this._speaking) await this.stop()
    try {
      const res = await fetch(`${sinkBase()}/api/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean }),
      })
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean
        queue?: number
        error?: string
      } | null
      if (!res.ok || data === null || data.ok !== true) {
        log(`朗读入队失败：${data?.error ?? `HTTP ${res.status}`}`, true)
        return
      }
      log(`开始朗读（${clean.length} 字，队列 ${data.queue ?? 0}）`)
      this._speaking = true
      this.emit()
      this.startPolling()
    } catch (err) {
      log(`朗读入队失败：${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  /** 停止当前朗读并清空队列。 */
  async stop(): Promise<void> {
    try {
      await fetch(`${sinkBase()}/api/speech/stop`, { method: 'POST' })
    } catch { /* ignore */ }
    this.stopPolling()
    if (this._speaking) {
      this._speaking = false
      this.emit()
      log('已停止朗读')
    }
  }

  private startPolling(): void {
    this.stopPolling()
    this.pollTimer = setInterval(() => {
      void fetch(`${sinkBase()}/api/speech/status`)
        .then(r => r.json().catch(() => null))
        .then((st: { speaking?: boolean; queue?: number; error?: string } | null) => {
          const speaking = st?.speaking === true
          const queue = typeof st?.queue === 'number' ? st.queue : 0
          if (!speaking && queue === 0 && this.pollTimer !== null) {
            this.stopPolling()
            if (this._speaking) {
              this._speaking = false
              this.emit()
              if (st?.error) {
                log(`朗读失败：${st.error}`, true)
              } else {
                log('朗读完成')
              }
            }
          }
        })
        .catch(() => { /* 服务瞬断忽略 */ })
    }, POLL_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }
}

export const reader = new ReadAloud()
