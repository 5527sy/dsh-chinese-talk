/**
 * VoicePanel V1 — DSH 右侧栏录音面板（conversation.input.dock 槽位）。
 *
 * 交互：点击 🎙️ 开始录音（MediaRecorder，webm/opus）→ 再次点击停止，
 * 把整段音频上传到本机 record-sink（默认 http://127.0.0.1:8766，可用
 * localStorage `s2s.record.base` 覆盖），由它用 ffmpeg 转成 MP3，
 * 以结束那一秒的年月日时分秒命名存到 D:\dsh_workspeace\vocal\master。
 *
 * 后续版本将对最新一条录音做识别 —— 文件名即时间，天然有序。
 * 面板内置活动日志（最近 20 条），没有控制台也能看到每一步结果。
 */
import { memo, useRef, useState } from 'react'
import type { VoiceInjected } from './contract.ts'
import { PttRecorder } from './voice/ptt-recorder.ts'
import styles from './VoiceSidebar.module.css'

const RECORD_SINK_KEY = 's2s.record.base'
const DEFAULT_SINK = 'http://127.0.0.1:8766'
const PANEL_KEY = 's2s.record.panel'
/** 录音时长小于该值视为误触，丢弃。 */
const MIN_MS = 300

function sinkBase(): string {
  try {
    const v = localStorage.getItem(RECORD_SINK_KEY)
    if (v !== null && v.trim() !== '') return v.trim().replace(/\/+$/, '')
  } catch { /* ignore */ }
  return DEFAULT_SINK
}

function clock(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

type Phase = 'idle' | 'recording' | 'saving' | 'error'

interface LogLine {
  t: string
  msg: string
  bad?: boolean
}

export type VoiceSidebarProps = VoiceInjected

/**
 * @param _props - V1 无注入 face，保留参数以匹配槽位渲染契约。
 */
export const VoiceSidebar = memo(function VoiceSidebar(_props: VoiceInjected) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PANEL_KEY) === '1'
    } catch {
      return false
    }
  })
  const [log, setLog] = useState<LogLine[]>(() => [
    { t: clock(), msg: '就绪：点 🎙️ 开始录音，再点一次结束并保存 MP3' },
  ])

  const recorderRef = useRef<PttRecorder | null>(null)
  const savingRef = useRef(false)

  const pushLog = (msg: string, bad = false): void => {
    setLog(prev => [...prev.slice(-19), { t: clock(), msg, bad }])
  }

  const saveRecording = async (blob: Blob, ms: number): Promise<void> => {
    if (savingRef.current) return
    if (ms < MIN_MS) {
      pushLog(`录音太短（${ms}ms），已丢弃`)
      setPhase('idle')
      return
    }
    savingRef.current = true
    setPhase('saving')
    try {
      const res = await fetch(`${sinkBase()}/api/record`, {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'audio/webm',
          'X-Record-Ms': String(ms),
        },
        body: blob,
      })
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean
        file?: string
        seconds?: number
        bytes?: number
        error?: string
      } | null
      if (!res.ok || data === null || data.ok !== true) {
        throw new Error(data?.error ?? `HTTP ${res.status}`)
      }
      const seconds = typeof data.seconds === 'number' ? data.seconds.toFixed(1) : '?'
      const kb = typeof data.bytes === 'number' ? Math.round(data.bytes / 1024) : '?'
      pushLog(`已保存 → ${data.file}（${seconds}s / ${kb}KB）`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      pushLog(`保存失败：${msg}`, true)
      setPhase('error')
    } finally {
      savingRef.current = false
      setPhase('idle')
    }
  }

  const startRecording = async (): Promise<void> => {
    if (phase === 'recording' || phase === 'saving') return
    setPhase('recording')
    pushLog('开始录音…（再点一次结束并保存）')
    try {
      const recorder = new PttRecorder({
        onDone: (blob, ms) => {
          void saveRecording(blob, ms)
        },
      })
      recorderRef.current = recorder
      await recorder.start()
    } catch (err) {
      recorderRef.current = null
      setPhase('error')
      pushLog(`麦克风启动失败：${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  const stopRecording = (): void => {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder !== null) {
      recorder.stop()
    } else {
      setPhase('idle')
    }
  }

  const onMicClick = (): void => {
    if (phase === 'saving') return
    if (phase === 'recording') {
      stopRecording()
    } else {
      void startRecording()
    }
  }

  const toggleCollapsed = (): void => {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem(PANEL_KEY, next ? '1' : '0')
    } catch { /* ignore */ }
  }

  if (collapsed) {
    return (
      <button type="button" className={styles.rail} title="语音录音面板" onClick={toggleCollapsed}>
        🎙️
      </button>
    )
  }

  const recording = phase === 'recording'
  const saving = phase === 'saving'
  const micClass = recording
    ? `${styles.micBtn} ${styles.micOn}`
    : saving
      ? `${styles.micBtn} ${styles.micBusy}`
      : styles.micBtn

  const statusText = saving
    ? '保存中…'
    : recording
      ? '正在录音，点按钮结束并保存'
      : phase === 'error'
        ? '出错了，见下方日志'
        : '点开始录音（再点一次结束）'

  return (
    <div className={styles.root}>
      <button type="button" className={styles.collapse} onClick={toggleCollapsed} title="收起">»</button>
      <header className={styles.header}>
        <span className={styles.title}>录音面板</span>
        <span className={styles.subtitle}>V1 · 录音存 MP3</span>
      </header>

      <div className={styles.micArea}>
        <button
          type="button"
          className={micClass}
          title={recording ? '结束录音并保存' : '开始录音'}
          disabled={saving}
          onClick={onMicClick}
        >
          {saving ? '⏳' : recording ? '🔴' : '🎙️'}
        </button>
        <span className={recording ? `${styles.stateText} ${styles.stateRec}` : styles.stateText}>
          {statusText}
        </span>
      </div>

      <footer className={styles.footer}>
        <div className={styles.hint}>保存位置：D:\dsh_workspeace\vocal\master（文件名 = 结束时刻）</div>
        <div className={styles.logBox}>
          {log.map((item, i) => (
            <div key={i} className={item.bad === true ? `${styles.logLine} ${styles.logBad}` : styles.logLine}>
              <span className={styles.logT}>{item.t}</span> {item.msg}
            </div>
          ))}
        </div>
      </footer>
    </div>
  )
})
