export type LatestSeekState = { pending: boolean; settled: boolean; error?: unknown }

/** Run one seek at a time and replace any waiting target with the latest input. */
export class LatestSeekQueue {
  private latest: number | undefined
  private running = false
  private disposed = false

  constructor(
    private readonly seek: (time: number) => Promise<void>,
    private readonly onState: (state: LatestSeekState) => void,
  ) {}

  request(time: number): void {
    if (this.disposed) return
    this.latest = time
    if (this.running) return
    this.running = true
    this.onState({ pending: true, settled: false })
    void this.drain()
  }

  dispose(): void {
    this.disposed = true
    this.latest = undefined
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.latest !== undefined) {
      const target = this.latest
      this.latest = undefined
      let succeeded = false
      let error: unknown
      try { await this.seek(target); succeeded = true }
      catch (cause) { error = cause }
      if (this.disposed) return
      // A newer input owns the result, including when the older seek failed.
      if (this.latest !== undefined) continue
      this.running = false
      this.onState(succeeded
        ? { pending: false, settled: true }
        : { pending: false, settled: false, error })
      return
    }
  }
}
