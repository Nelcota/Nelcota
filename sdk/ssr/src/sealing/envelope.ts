const MAX_ENVELOPE_CHARS = 90_000;

/** Parse the bounded wire envelope before selecting or deriving a decryption key. */
export function sealedEnvelope(sealed: string): { version: "v1" | "v2"; id: string; body: string } {
  if (sealed.length > MAX_ENVELOPE_CHARS) throw new Error("size");
  const [version, id, body, extra] = sealed.split(".");
  if (
    (version !== "v1" && version !== "v2") ||
    id === undefined ||
    id === "" ||
    body === undefined ||
    body === "" ||
    extra !== undefined ||
    /^[A-Za-z0-9_-]+$/.test(body) === false
  )
    throw new Error("envelope");
  return { version, id, body };
}
