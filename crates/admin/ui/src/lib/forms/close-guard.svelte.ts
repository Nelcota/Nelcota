/** Guard user-initiated closing; successful saves can close directly. */
export class CloseGuard {
  pending = $state(false)

  constructor(private dirty: () => boolean, private busy: () => boolean, private close: () => void) {}

  request = () => {
    if (this.busy()) return
    if (this.dirty()) { this.pending = true; return }
    this.close()
  }

  discard = () => {
    this.pending = false
    this.close()
  }

  change = (next: boolean) => {
    if (!next) this.request()
  }
}
