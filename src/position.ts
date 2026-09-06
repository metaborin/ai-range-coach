/** Accumulate requested movement without snapping to a frame or to 0.1 seconds. */
export function moveRequestedPosition(current: number, delta: number, duration: number): number {
  const next = Math.round((current + delta) * 1_000_000_000) / 1_000_000_000
  return Math.max(0, Math.min(duration, next))
}
