/**
 * PttRecorder（V1）— 按住说话（PTT）录音，基于内置 MediaRecorder。
 *
 * 不用 AudioWorklet / AudioContext：规避 Chrome
 * “AudioWorkletNode cannot be created: No execution context available”
 * 这类上下文未激活问题。按住 start()、松开 stop()，产出一整段
 * Blob（webm/opus，浏览器原生支持），由 record-sink 用 ffmpeg 转 MP3。
 */

export interface PttRecorderHooks {
  /** 录音结束，产出整段音频 Blob 与时长(ms)。 */
  onDone: (blob: Blob, durationMs: number) => void
}

type RecState = 'new' | 'starting' | 'live' | 'stopping' | 'stopped'

function pickMime(): string {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ]
  if (typeof MediaRecorder === 'undefined') return ''
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime
    } catch { /* ignore */ }
  }
  return ''
}

export class PttRecorder {
  private state: RecState = 'new'
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  private cancelled = false

  constructor(private readonly hooks: PttRecorderHooks) {}

  get active(): boolean {
    return this.state === 'starting' || this.state === 'live'
  }

  /** 请求麦克风并开始录制（须在用户手势中调用）。 */
  async start(): Promise<void> {
    if (this.state === 'stopping' || this.state === 'stopped') return
    this.state = 'starting'
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (err) {
      this.state = 'stopped'
      throw err
    }
    // 极短按压：getUserMedia 返回前已松开 → 直接释放。
    if (this.state !== 'starting') {
      stream.getTracks().forEach(track => { try { track.stop() } catch { /* ignore */ } })
      this.state = 'stopped'
      return
    }
    this.stream = stream
    this.chunks = []
    this.cancelled = false
    const mime = pickMime()
    let rec: MediaRecorder
    try {
      rec = mime !== ''
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream)
    } catch (err) {
      stream.getTracks().forEach(track => { try { track.stop() } catch { /* ignore */ } })
      this.state = 'stopped'
      throw err
    }
    rec.ondataavailable = (e: BlobEvent): void => {
      if (e.data !== null && e.data.size > 0) this.chunks.push(e.data)
    }
    this.recorder = rec
    this.startedAt = performance.now()
    try {
      rec.start()
    } catch (err) {
      this.state = 'stopped'
      throw err
    }
    this.state = 'live'
  }

  /** 松开：停止并交付整段录音。 */
  stop(): void {
    if (this.state === 'stopping' || this.state === 'stopped') return
    this.state = 'stopping'
    const rec = this.recorder
    const stream = this.stream
    this.recorder = null
    this.stream = null
    if (rec === null || stream === null || rec.state === 'inactive') {
      this.state = 'stopped'
      return
    }
    const ms = Math.max(0, Math.round(performance.now() - this.startedAt))
    rec.onstop = (): void => {
      stream.getTracks().forEach(track => { try { track.stop() } catch { /* ignore */ } })
      const first = this.chunks[0]
      const type = (first !== undefined ? first.type : rec.mimeType) || 'audio/webm'
      const blob = new Blob(this.chunks, { type })
      this.chunks = []
      this.state = 'stopped'
      if (!this.cancelled && blob.size > 0) this.hooks.onDone(blob, ms)
    }
    try {
      rec.stop()
    } catch (err) {
      this.state = 'stopped'
      this.chunks = []
      throw err
    }
  }

  /** 放弃本次录音（不交付）。 */
  cancel(): void {
    if (this.state === 'stopping' || this.state === 'stopped') return
    this.cancelled = true
    this.stop()
  }
}
