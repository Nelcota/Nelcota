const ID_RADIX = 36;

/** `crypto.randomUUID` only exists in a secure context (HTTPS or localhost). */
export function newId(): string {
  return (
    (crypto as Partial<Crypto>).randomUUID?.() ??
    `${Date.now().toString(ID_RADIX)}-${Math.random().toString(ID_RADIX).slice(2)}`
  );
}
