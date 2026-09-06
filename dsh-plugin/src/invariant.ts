/** Minimal invariant helper (packages/client convention export). */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[dsh-client-ui-voice-call] ${message}`)
  }
}

export default invariant
