declare global {
  /** Native Deno identity is optional when the smoke runs on Node or Bun. */
  var Deno: { version: { deno: string } } | undefined;
}
export {};
