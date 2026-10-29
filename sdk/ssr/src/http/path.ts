const ASCII_CONTROL_END = 31;
const ASCII_DELETE = 127;

/** ASCII path controls must be rejected before any URL normalization. */
export function hasPathControls(value: string): boolean {
  return Array.from(value).some(
    (char) => char.charCodeAt(0) <= ASCII_CONTROL_END || char.charCodeAt(0) === ASCII_DELETE,
  );
}
