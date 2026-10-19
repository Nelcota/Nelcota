/** Only the newest request owns its result, even when an adapter ignores cancellation. */
export class RemoteResource<T> {
  data = $state<T | null>(null)
  loading = $state(false)
  loaded = $state(false)
  error = $state<unknown>(null)
  private generation = 0
  private controller?: AbortController

  async load(fetcher: (signal: AbortSignal) => Promise<T>): Promise<boolean> {
    this.cancel()
    const generation = this.generation
    const controller = this.controller = new AbortController()
    this.loading = true
    this.error = null
    try {
      const data = await fetcher(controller.signal)
      if (generation !== this.generation) return false
      this.data = data
      return true
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted) this.error = error
      return false
    } finally {
      if (generation === this.generation) { this.loading = false; this.loaded = true }
    }
  }
  cancel() {
    this.generation++
    this.controller?.abort()
    this.controller = undefined
    this.loading = false
  }
  clear() { this.cancel(); this.data = null; this.error = null; this.loaded = false }
}
