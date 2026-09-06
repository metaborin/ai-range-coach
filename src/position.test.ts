import { describe, expect, it } from 'vitest'
import { moveRequestedPosition } from './position'

describe('requested video position, separate from observed frame time', () => {
  it('accumulates ten accepted 0.01-second requests to 0.1 seconds without frame-time rounding', () => {
    let requested = 1.4
    const positions: number[] = []
    for (let index = 0; index < 10; index++) {
      requested = moveRequestedPosition(requested, 0.01, 5)
      positions.push(requested)
    }
    expect(positions).toEqual([1.41, 1.42, 1.43, 1.44, 1.45, 1.46, 1.47, 1.48, 1.49, 1.5])
  })

  it('moves back and forward by the selected increment and keeps a timeline or playback baseline', () => {
    expect(moveRequestedPosition(2.4, -0.01, 5)).toBe(2.39)
    expect(moveRequestedPosition(2.39, 0.01, 5)).toBe(2.4)
    expect(moveRequestedPosition(2.4, 0.1, 5)).toBe(2.5)
    expect(moveRequestedPosition(2.5, -0.1, 5)).toBe(2.4)
    // Playback need not stop at an exact hundredth of a second.
    expect(moveRequestedPosition(1.234567, 0.01, 5)).toBeCloseTo(1.244567, 9)
  })

  it('clamps at zero and the actual end without losing a fractional duration', () => {
    expect(moveRequestedPosition(0, -0.01, 5)).toBe(0)
    expect(moveRequestedPosition(0.005, -0.01, 5)).toBe(0)
    expect(moveRequestedPosition(4.999, 0.01, 5)).toBe(5)
    expect(moveRequestedPosition(5, 0.01, 5)).toBe(5)
    expect(moveRequestedPosition(4.997, 0.01, 5.003)).toBe(5.003)
    expect(moveRequestedPosition(5.003, -0.01, 5.003)).toBe(4.993)
  })
})
