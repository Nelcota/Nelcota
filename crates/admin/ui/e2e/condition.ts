/** Fail a browser scenario at the first violated invariant. */
export function assertCondition(value: unknown, message: string): asserts value {
  if (Boolean(value) === false) throw new Error(message);
}
