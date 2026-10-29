import type { CookieWriter } from "@nelcota/ssr";

type CookieOptions = Parameters<CookieWriter["set"]>[2];
/** One request's cookie view: what it presented and what its response set. */
export class Exchange implements CookieWriter {
  readonly sets: { name: string; value: string; options: CookieOptions }[] = [];
  constructor(readonly presented: Map<string, string>) {}
  get(name: string): { value: string } | undefined {
    const value = this.presented.get(name);
    return value != null && value !== "" ? { value } : undefined;
  }
  set(name: string, value: string, options: CookieOptions): void {
    this.sets.push({ name, value, options });
  }
}
