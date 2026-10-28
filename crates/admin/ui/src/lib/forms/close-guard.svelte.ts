import { beforeNavigate } from '$lib/navigation/router.svelte'

/** Guard user-initiated closing; successful saves can close directly. */
export class CloseGuard {
  pending = $state(false)
  private proceed: (() => void) | null = null
  private waiting = $state(false)

  constructor(private dirty: () => boolean, private busy: () => boolean, private close: () => void, active: () => boolean) {
    $effect(() => {
      if (!active()) return
      return beforeNavigate({
        blocked: () => active() && (this.busy() || this.dirty()),
        request: proceed => {
          this.proceed = proceed
          if (this.busy()) { this.waiting = true; return }
          this.pending = true
        },
      })
    })
    $effect(() => {
      if (!this.waiting || this.busy()) return
      this.waiting = false
      if (active() && this.dirty()) { this.pending = true; return }
      const proceed = this.proceed
      this.proceed = null
      proceed?.()
    })
  }

  request = () => {
    if (this.busy()) return
    this.proceed = null
    if (this.dirty()) { this.pending = true; return }
    this.close()
  }

  discard = () => {
    const proceed = this.proceed
    this.proceed = null
    this.pending = false
    this.close()
    proceed?.()
  }

  change = (next: boolean) => {
    if (!next) this.request()
  }
}
