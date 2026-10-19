// Admin session: `undefined` = checking, `null` = signed out. `expired` is set
// when a signed-in session is rejected (401), so the login can say why.
export const session = $state<{ email: string | null | undefined; expired: boolean; epoch: number }>({ email: undefined, expired: false, epoch: 0 })
