/**
 * VoicePanel — DSH 全壳右侧录音面板（挂 ui-layout `shell.overlay`，常驻不随
 * 会话状态卸载，思考/回答进行中也一直可用）。
 *
 * 布局：固定贴窗口右缘中间、竖排；右侧中间的 🎙️/✕ 图标做「展开 / 隐藏」。
 * V1：点 🎙️ 开始录音（MediaRecorder，webm/opus）→ 再点结束，上传 record-sink(:8766)
 *     存 MP3（结束时刻命名）。
 * V2：时长 <1s 弹出「哎呀，录音太短了」，不保存。
 * V2.1：保存后自动调 /api/stt 中文识别，文本通过 draft writer 追加进
 *       「当前会话」输入框草稿（不自动发送；多条自动接着排，回答中也可用）。
 *
 * 面板内置活动日志（最近 20 条），没有控制台也能看到每一步结果。
 */
import { memo, useEffect, useRef, useState } from 'react'
import { insertRecognizedText } from './voice/input-target.ts'
import { bindLog } from './voice/log-bus.ts'
import { reader } from './voice/read-aloud.ts'
import { PttRecorder } from './voice/ptt-recorder.ts'
import styles from './VoiceSidebar.module.css'

const RECORD_SINK_KEY = 's2s.record.base'
const DEFAULT_SINK = 'http://127.0.0.1:8766'
const PANEL_KEY = 's2s.record.panel'
/** 录音时长小于 1 秒视为无效，弹出提示并不保存。 */
const MIN_MS = 1000

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

function readHidden(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === '1'
  } catch {
    return false
  }
}

function writeHidden(hidden: boolean): void {
  try {
    localStorage.setItem(PANEL_KEY, hidden ? '1' : '0')
  } catch { /* ignore */ }
}

type Phase = 'idle' | 'recording' | 'saving' | 'recognizing' | 'error'

interface LogLine {
  t: string
  msg: string
  bad?: boolean
}

/**
 * 面板本身不接收槽位注入 props：识别文本通过全局 draft writer 写入
 * “当前会话”的输入框（插件 apply 负责解析当前会话）。
 */
export const VoiceSidebar = memo(function VoiceSidebar() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [hidden, setHidden] = useState<boolean>(() => readHidden())
  const [log, setLog] = useState<LogLine[]>(() => [
    { t: clock(), msg: '就绪：先点要填的输入框，再 🎙️ 录音；文字自动填入' },
  ])
  const [toast, setToast] = useState<string | null>(null)
  const [readOn, setReadOn] = useState<boolean>(reader.enabled)
  const [speaking, setSpeaking] = useState<boolean>(reader.reading)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const recorderRef = useRef<PttRecorder | null>(null)
  const busyRef = useRef(false)

  const pushLog = (msg: string, bad = false): void => {
    setLog(prev => [...prev.slice(-19), { t: clock(), msg, bad }])
  }

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
    }
  }, [])

  // 全局日志总线 + 朗读器状态镜像。
  useEffect(() => {
    const unsubReader = reader.subscribe(() => {
      setReadOn(reader.enabled)
      setSpeaking(reader.reading)
    })
    bindLog((msg, bad = false) => pushLog(msg, bad))
    return () => {
      unsubReader()
      bindLog(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const showToast = (msg: string, durationMs = 2600): void => {
    setToast(msg)
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), durationMs)
  }

  /** 识别音频并追加进输入框（失败只记日志，不影响已保存的录音）。 */
  const transcribeAndAppend = async (blob: Blob, ms: number): Promise<void> => {
    const base = sinkBase()
    try {
      setPhase('recognizing')
      pushLog('识别中…（首次加载模型需 10~60s，之后很快）')
      const res = await fetch(`${base}/api/stt`, {
        method: 'POST',
        headers: {
          'Content-Type': blob.type || 'audio/webm',
          'X-Record-Ms': String(ms),
        },
        body: blob,
      })
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean
        text?: string
        error?: string
      } | null
      if (!res.ok || data === null || data.ok !== true) {
        pushLog(`识别失败：${data?.error ?? `HTTP ${res.status}`}`, true)
        return
      }
      const text = (data.text ?? '').trim()
      if (text === '') {
        pushLog('识别完成，未识别到文字')
        return
      }
      const snippet = text.length > 18 ? `${text.slice(0, 18)}…` : text
      const result = insertRecognizedText(text)
      if (result.ok) {
        pushLog(`识别 ${text.length} 字：「${snippet}」→ ${result.message ?? '已填入'}`)
      } else {
        pushLog(`识别 ${text.length} 字，但填入失败：${result.message ?? '未知原因'}`, true)
      }
    } catch (err) {
      pushLog(`识别失败：${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  const saveRecording = async (blob: Blob, ms: number): Promise<void> => {
    if (busyRef.current) return
    if (ms < MIN_MS) {
      pushLog(`录音太短（${ms}ms），未保存`)
      showToast('哎呀，录音太短了')
      setPhase('idle')
      return
    }
    busyRef.current = true
    setPhase('saving')
    try {
      const base = sinkBase()
      const res = await fetch(`${base}/api/record`, {
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
      await transcribeAndAppend(blob, ms)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      pushLog(`保存失败：${msg}`, true)
      setPhase('error')
    } finally {
      busyRef.current = false
      setPhase('idle')
    }
  }

  const startRecording = async (): Promise<void> => {
    if (phase === 'recording' || phase === 'saving' || phase === 'recognizing') return
    // 要开口问了：先停掉正在朗读的回复。
    void reader.stop()
    setPhase('recording')
    pushLog('开始录音…（再点一次结束）')
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
    if (phase === 'saving' || phase === 'recognizing') return
    if (phase === 'recording') {
      stopRecording()
    } else {
      void startRecording()
    }
  }

  /** 右上角图标：展开 / 隐藏。录音进行中不允许隐藏，避免失去停止入口。 */
  const toggleHidden = (): void => {
    if (phase === 'recording' || phase === 'saving' || phase === 'recognizing') {
      showToast('请先结束当前录音')
      return
    }
    const next = !hidden
    setHidden(next)
    writeHidden(next)
  }

  const recording = phase === 'recording'
  const busy = phase === 'saving' || phase === 'recognizing'
  const micClass = recording
    ? `${styles.micBtn} ${styles.micOn}`
    : busy
      ? `${styles.micBtn} ${styles.micBusy}`
      : styles.micBtn

  const statusText = phase === 'saving'
    ? '保存中…'
    : phase === 'recognizing'
      ? '识别中…（首次较慢）'
      : recording
        ? '正在录音，点按钮结束'
        : phase === 'error'
          ? '出错了，见下方日志'
          : '点开始录音（结束自动识别填入输入框）'

  return (
    <>
      {/* 右上角常驻图标：展开 / 隐藏 */}
      <button
        type="button"
        className={styles.toggle}
        title={hidden ? '展开录音面板' : '隐藏录音面板'}
        onClick={toggleHidden}
      >
        {hidden ? '🎙️' : '✕'}
      </button>

      {!hidden && (
        <div className={styles.root}>
          <header className={styles.header}>
            <span className={styles.title}>录音面板</span>
            <span className={styles.subtitle}>录音 → 存 MP3 → 识别入输入框</span>
          </header>

          <div className={styles.micArea}>
            <button
              type="button"
              className={micClass}
              title={recording ? '结束录音并保存' : '开始录音'}
              disabled={busy}
              onClick={onMicClick}
            >
              {phase === 'saving' ? '⏳' : phase === 'recognizing' ? '✍️' : recording ? '🔴' : '🎙️'}
            </button>
            <span className={recording ? `${styles.stateText} ${styles.stateRec}` : styles.stateText}>
              {statusText}
            </span>
          </div>

          <div className={styles.controls}>
            <button
              type="button"
              className={readOn ? `${styles.ctrlBtn} ${styles.ctrlOn}` : styles.ctrlBtn}
              title={readOn ? '关闭自动朗读回答' : '开启自动朗读回答'}
              onClick={() => reader.setEnabled(!readOn)}
            >
              {readOn ? '🔊 朗读开' : '🔇 朗读关'}
            </button>
            {speaking && <span className={styles.speaking}>📢 朗读中…</span>}
          </div>

          <footer className={styles.footer}>
            <div className={styles.hint}>保存：vocal/master（文件名=结束时刻，实际目录见服务端 /api/health）</div>
            <div className={styles.logBox}>
              {log.map((item, i) => (
                <div key={i} className={item.bad === true ? `${styles.logLine} ${styles.logBad}` : styles.logLine}>
                  <span className={styles.logT}>{item.t}</span> {item.msg}
                </div>
              ))}
            </div>
          </footer>

          {toast !== null && (
            <div className={styles.toast} role="alert" onClick={() => setToast(null)}>
              {toast}
            </div>
          )}
        </div>
      )}
    </>
  )
})
