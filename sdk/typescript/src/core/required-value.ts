/**
 * Returns a value required by the current operation.
 *
 * @param value - Value that may be absent.
 * @param context - Field or operation name included in the failure message.
 * @returns The original value, preserving valid falsy values.
 * @throws When the value is null or undefined.
 */
export function requiredValue<T>(value: T, context: string): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new TypeError(`Missing ${context}`);
  }
  return value;
}
