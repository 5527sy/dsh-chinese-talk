/**
 * VoicePanel — 语音通话面板（conversation.input.dock）。
 *
 * PTT 交互：按住 🎙️ 说话 → 松开 → 自动转文字填入输入框（可改后回车发送）。
 * 另含：🔊 朗读开关 / ⚡ 插话-排队 / 🎚️ 音色热切换 / 桥接状态与朗读指示。
 * 按住所遇正在朗读的回复立即打断（interruptReply）。
 */
import { memo, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { health, setVoice, stt, voiceList } from './bridge.ts'
import type { VoiceInjected } from './contract.ts'
import { MicRecorder } from './voice/recorder.ts'
import styles from './VoiceSidebar.module.css'

const VOICE_ENABLED_KEY = 's2s.voice.enabled'
const INTERRUPT_KEY = 's2s.voice.interrupt'
const VOICE_NAME_KEY = 's2s.voice.persona'
const PANEL_KEY = 's2s.voice.panel'

type MicState = 'off' | 'recording' | 'busy'

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
  } catch {
    // persistence unavailable
  }
}

export type VoiceSidebarProps = VoiceInjected

/**
 * @param props - injected face (fillComposer/sendText/speaker/interrupt wiring).
 */
export const VoiceSidebar = memo(function VoiceSidebar(props: VoiceInjected) {
  const { speaker } = props

  const [mic, setMic] = useState<MicState>('off')
  const [reading, setReading] = useState(false)
  const [voiceOn, setVoiceOn] = useState<boolean>(() => readFlag(VOICE_ENABLED_KEY, true))
  const [interrupt, setInterrupt] = useState<boolean>(() => readFlag(INTERRUPT_KEY, true))
  const [collapsed, setCollapsed] = useState<boolean>(() => readFlag(PANEL_KEY, false))
  const [bridge, setBridge] = useState<{ online: boolean; stt: boolean; tts: boolean; voice: string }>({
    online: false,
    stt: false,
    tts: false,
    voice: '',
  })
  const [voices, setVoices] = useState<{ name: string; label: string }[]>([])
  const [currentVoice, setCurrentVoice] = useState('')
  const [lastText, setLastText] = useState('')

  const recorderRef = useRef<MicRecorder | null>(null)
  const pressingRef = useRef(false)
  const busyRef = useRef(false)
  const voiceRestoredRef = useRef(false)

  // ── speaker 朗读状态（订阅一次）───────────────────────────────────────────
  useEffect(() => {
    const unsub = speaker.subscribe(() => setReading(speaker.speaking))
    return unsub
  }, [speaker])

  // ── 桥接健康与音色清单轮询 ────────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    const tick = async () => {
      const h = await health()
      if (!alive) return
      if (h === null) {
        setBridge({ online: false, stt: false, tts: false, voice: '' })
        return
      }
      setBridge({ online: h.status === 'ok', stt: h.stt === true, tts: h.tts === true, voice: h.voice ?? '' })
      if (Array.isArray(h.voices) && h.voices.length > 0) {
        setVoices(prev => {
          const next = h.voices!.map(name => ({ name, label: name }))
          const same = prev.length === next.length && prev.every((v, i) => v.name === next[i]!.name)
          return same ? prev : next
        })
        setCurrentVoice(prev => prev || h.voice || '')
      }
    }
    void tick()
    const id = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  // ── 音色热切换 + 启动时恢复上次选择 ────────────────────────────────────────
  useEffect(() => {
    if (voices.length === 0 || voiceRestoredRef.current) return
    voiceRestoredRef.current = true
    let stored = ''
    try {
      stored = localStorage.getItem(VOICE_NAME_KEY) ?? ''
    } catch { /* ignore */ }
    if (stored && voices.some(v => v.name === stored) && stored !== bridge.voice) {
      void setVoice(stored).then(ok => { if (ok) setCurrentVoice(stored) })
    }
    void voiceList().then(list => {
      if (list !== null && list.voices.length > 0) {
        setVoices(list.voices.map(v => ({ name: v.name, label: v.label })))
        setCurrentVoice(list.current.voice)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voices])

  const handleVoiceChange = (name: string): void => {
    setCurrentVoice(name)
    try {
      localStorage.setItem(VOICE_NAME_KEY, name)
    } catch { /* ignore */ }
    void setVoice(name)
  }

  // ── PTT：按住录音 → 松开转文字 → 填输入框 ────────────────────────────────
  const runTranscribe = async (pcm: ArrayBuffer): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setMic('busy')
    try {
      const result = await stt(pcm)
      const text = (result.text || '').trim()
      if (text) {
        setLastText(text)
        props.fillComposer(text)
      } else {
        setLastText('')
      }
    } catch (err) {
      console.error('[ui-voice-call] stt failed:', err)
      setLastText('')
    } finally {
      busyRef.current = false
      setMic('off')
    }
  }

  const pressStart = async (e: ReactPointerEvent<HTMLButtonElement>): Promise<void> => {
    e.preventDefault()
    if (pressingRef.current || busyRef.current) return
    try {
      // 按住即打断当前朗读并吞掉本回复剩余句子
      props.interruptReply()
      const recorder = new MicRecorder({
        ptt: true,
        noiseGateDb: -35,
        onUtterance: (pcm) => {
          void runTranscribe(pcm)
        },
      })
      recorderRef.current = recorder
      pressingRef.current = true
      setMic('recording')
      await recorder.start()
    } catch (err) {
      console.error('[ui-voice-call] mic start failed:', err)
      pressingRef.current = false
      recorderRef.current = null
      setMic('off')
    }
  }

  const pressEnd = (): void => {
    if (!pressingRef.current) return
    pressingRef.current = false
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder !== null) recorder.stop() // stop 会把整段按住音频作为一句 flush 给 onUtterance
  }

  const toggleVoiceOn = (): void => {
    const next = !voiceOn
    setVoiceOn(next)
    writeFlag(VOICE_ENABLED_KEY, next)
    if (!next) {
      props.abortTts()
      speaker.stop()
    }
  }

  const toggleInterrupt = (): void => {
    const next = !interrupt
    setInterrupt(next)
    writeFlag(INTERRUPT_KEY, next)
  }

  const toggleCollapsed = (): void => {
    const next = !collapsed
    setCollapsed(next)
    writeFlag(PANEL_KEY, next)
  }

  if (collapsed) {
    return (
      <button
        type="button"
        className={styles.rail}
        title="语音通话面板"
        onClick={toggleCollapsed}
      >
        🎙️
      </button>
    )
  }

  const recording = mic === 'recording'
  const busy = mic === 'busy'

  return (
    <div className={styles.root}>
      <button type="button" className={styles.collapse} onClick={toggleCollapsed} title="收起">»</button>
      <header className={styles.header}>
        <span className={styles.title}>语音通话</span>
        <span className={styles.subtitle}>按住说话 · 松开识别填入输入框</span>
      </header>

      {/* PTT 大按钮 */}
      <div className={styles.micArea}>
        <button
          type="button"
          className={busy ? `${styles.micBtn} ${styles.micBusy}` : recording ? `${styles.micBtn} ${styles.micOn}` : styles.micBtn}
          title={recording ? '松开结束录音' : '按住说话'}
          disabled={busy}
          onPointerDown={(e) => void pressStart(e)}
          onPointerUp={pressEnd}
          onPointerLeave={() => { if (pressingRef.current) pressEnd() }}
          onPointerCancel={pressEnd}
          onContextMenu={(e) => e.preventDefault()}
        >
          {busy ? '⏳' : recording ? '🔴' : '🎙️'}
        </button>
        <span className={styles.stateText}>
          {busy ? '识别中…' : recording ? '正在听，松开结束' : reading ? '正在朗读回复…（按住可打断）' : '按住说话'}
        </span>
        {lastText !== '' && <span className={styles.lastText}>已填入输入框：“{lastText}”</span>}
      </div>

      {/* 模式开关 */}
      <div className={styles.controls}>
        <button
          type="button"
          className={voiceOn ? `${styles.toggle} ${styles.toggleOn}` : styles.toggle}
          onClick={toggleVoiceOn}
          title={voiceOn ? '关闭语音朗读' : '开启语音朗读'}
        >
          🔊 {voiceOn ? '朗读开' : '朗读关'}
        </button>
        <button
          type="button"
          className={interrupt ? `${styles.toggle} ${styles.toggleOn}` : styles.toggle}
          onClick={toggleInterrupt}
          title={interrupt ? '插话模式：说话打断当前回复并立即发送' : '排队模式：当前回复读完后再自动接上'}
        >
          ⚡ {interrupt ? '插话' : '排队'}
        </button>
      </div>

      {/* 音色切换 */}
      <label className={styles.voiceRow}>
        <span>🎚️ 音色</span>
        <select
          className={styles.select}
          value={currentVoice}
          onChange={e => handleVoiceChange(e.target.value)}
          disabled={voices.length === 0}
        >
          {voices.length === 0 && <option value="">（无音色，见 voices/ 说明）</option>}
          {voices.map(v => (
            <option key={v.name} value={v.name}>{v.label}</option>
          ))}
        </select>
      </label>

      {/* 状态 */}
      <footer className={styles.footer}>
        <div className={bridge.online ? `${styles.statusLine} ${styles.ok}` : styles.statusLine}>
          <span className={styles.dot} />
          {bridge.online ? '桥接正常' : '桥接未连接'}
        </div>
        <div className={styles.meta}>
          {bridge.stt ? 'ASR 就绪' : 'ASR 未加载'}
          <span className={styles.sep}>·</span>
          {bridge.tts ? 'TTS 就绪' : 'TTS 未加载'}
        </div>
      </footer>
    </div>
  )
})
