import { describe, expect, it, vi } from 'vitest'
import { LatestSeekQueue } from './latestSeek'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((succeed, fail) => { resolve = succeed; reject = fail })
  return { promise, resolve, reject }
}

describe('latest timeline request queue', () => {
  it('runs only the first and last of 100 inputs without overlapping seeks or publishing an intermediate completion', async () => {
    const first = deferred(), last = deferred()
    const seek = vi.fn<(time: number) => Promise<void>>()
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise)
    const state = vi.fn()
    const queue = new LatestSeekQueue(seek, state)
    for (let target = 1; target <= 100; target++) queue.request(target)
    expect(seek.mock.calls).toEqual([[1]])
    expect(state.mock.calls).toEqual([[{ pending: true, settled: false }]])
    first.resolve()
    await Promise.resolve()
    expect(seek.mock.calls).toEqual([[1], [100]])
    expect(state.mock.calls).toEqual([[{ pending: true, settled: false }]])
    last.resolve()
    await Promise.resolve()
    expect(state.mock.calls).toEqual([
      [{ pending: true, settled: false }], [{ pending: false, settled: true }],
    ])
  })

  it('continues to the latest target after an older seek fails and publishes only the latest result', async () => {
    const first = deferred(), last = deferred()
    const seek = vi.fn<(time: number) => Promise<void>>()
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise)
    const state = vi.fn()
    const queue = new LatestSeekQueue(seek, state)
    queue.request(1)
    queue.request(2)
    queue.request(3)
    first.reject(new Error('Superseded seek failed'))
    await Promise.resolve()
    expect(seek.mock.calls).toEqual([[1], [3]])
    expect(state.mock.calls).toEqual([[{ pending: true, settled: false }]])
    last.resolve()
    await Promise.resolve()
    expect(state).toHaveBeenLastCalledWith({ pending: false, settled: true })
    expect(state).toHaveBeenCalledTimes(2)
  })

  it('reports the final failure and accepts a successful retry at zero', async () => {
    const first = deferred(), retry = deferred()
    const seek = vi.fn<(time: number) => Promise<void>>()
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
    const state = vi.fn()
    const queue = new LatestSeekQueue(seek, state)
    const failure = new Error('Final seek failed')
    queue.request(2)
    first.reject(failure)
    await Promise.resolve()
    expect(state).toHaveBeenLastCalledWith({ pending: false, settled: false, error: failure })
    queue.request(0)
    expect(seek.mock.calls).toEqual([[2], [0]])
    expect(state).toHaveBeenLastCalledWith({ pending: true, settled: false })
    retry.resolve()
    await Promise.resolve()
    expect(state).toHaveBeenLastCalledWith({ pending: false, settled: true })
  })

  it('keeps zero as the latest waiting target rather than treating it as an empty slot', async () => {
    const first = deferred(), last = deferred()
    const seek = vi.fn<(time: number) => Promise<void>>()
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise)
    const queue = new LatestSeekQueue(seek, vi.fn())
    queue.request(2)
    queue.request(1)
    queue.request(0)
    first.resolve()
    await Promise.resolve()
    expect(seek.mock.calls).toEqual([[2], [0]])
    last.resolve()
    await Promise.resolve()
  })

  it.each(['success', 'failure'] as const)('discards pending work and late %s notifications after disposal', async (outcome) => {
    const first = deferred()
    const seek = vi.fn<(time: number) => Promise<void>>().mockReturnValue(first.promise)
    const state = vi.fn()
    const queue = new LatestSeekQueue(seek, state)
    queue.request(1)
    queue.request(2)
    queue.dispose()
    queue.request(3)
    if (outcome === 'success') first.resolve()
    else first.reject(new Error('Old controller disposed'))
    await Promise.resolve()
    expect(seek.mock.calls).toEqual([[1]])
    expect(state.mock.calls).toEqual([[{ pending: true, settled: false }]])
  })
})
