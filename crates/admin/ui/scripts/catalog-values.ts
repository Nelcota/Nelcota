/** Reject malformed translation input before it can overwrite a catalog. */
export function stringCatalog(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected a translation catalog object");
  const entries = Object.entries(value);
  return Object.fromEntries(entries.map(([key, text]) => [key, translationText(text)]));
}

export function translationText(value: unknown): string {
  if (typeof value === "string") return value;
  throw new TypeError("Expected translation text");
}

export function translationList(value: unknown): string[] {
  if (Array.isArray(value) === false) throw new TypeError("Expected a translation array");
  return value.map((text: unknown) => translationText(text));
}
