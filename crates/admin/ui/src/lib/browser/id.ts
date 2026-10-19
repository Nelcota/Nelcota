/** `crypto.randomUUID` only exists in a secure context (HTTPS or localhost). */
export function newId(): string {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
