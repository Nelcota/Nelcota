const HEX_RADIX = 16;

// Web-standard primitives shared by sealing and request-bound session identity.
const encoder = new TextEncoder();
export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value);
}
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}
export function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (/^[A-Za-z0-9_-]+$/.test(value) === false) throw new Error("Invalid base64url");
  const text = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(text, (character) => character.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error("Noncanonical base64url");
  return bytes;
}
export async function sha256(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", typeof value === "string" ? utf8(value) : value),
  );
  return Array.from(digest, (byte) => byte.toString(HEX_RADIX).padStart(2, "0")).join("");
}
export function equalState(first: string, second: string): boolean {
  if (first.length !== second.length) return false;
  let difference = 0;
  for (let index = 0; index < first.length; index++)
    difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
  return difference === 0;
}
export function concatenate(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(arrays.reduce((length, array) => length + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}
