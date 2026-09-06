/**
 * 极简日志总线：插件各处（识别/回答保存/错误）都能往面板日志里写，
 * 面板挂载时 bindLog 绑定自身，卸载时解绑。
 */
type LogFn = (msg: string, bad?: boolean) => void

let current: LogFn | null = null

export function bindLog(fn: LogFn | null): void {
  current = fn
}

export function log(msg: string, bad = false): void {
  current?.(msg, bad)
}
