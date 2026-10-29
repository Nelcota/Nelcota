import { requiredValue } from "../../../src/core/required-value.js";

class InListParser {
  readonly #items: string[] = [];
  #current = "";
  #quoted = false;
  #wasQuoted = false;

  #flush(): void {
    this.#items.push(this.#wasQuoted ? this.#current : this.#current.trim());
    this.#current = "";
    this.#wasQuoted = false;
  }
  #consume(character: string, next: string | undefined): boolean {
    if (character === '"' && this.#quoted) {
      this.#quoted = false;
      return false;
    }
    if (character === '"' && this.#current.trim() === "") {
      this.#quoted = true;
      this.#wasQuoted = true;
      this.#current = "";
      return false;
    }
    if (character === "\\" && this.#quoted) {
      this.#current += next ?? "";
      return true;
    }
    if (character === "," && this.#quoted === false) {
      this.#flush();
      return false;
    }
    this.#current += character;
    return false;
  }
  parse(inner: string): string[] {
    const characters = Array.from(inner);
    for (let index = 0; index < characters.length; index++) {
      const character = requiredValue(characters[index], "server grammar character");
      if (this.#consume(character, characters[index + 1])) index++;
    }
    if (this.#quoted) throw new Error("unclosed quotes");
    this.#flush();
    return this.#items;
  }
}

/** Read quoted, escaped and unquoted list items using the server's delimiter rules. */
export function parseInList(value: string): string[] {
  if (value.startsWith("(") === false || value.endsWith(")") === false)
    throw new Error("not a list");
  const inner = value.slice(1, -1);
  return inner.trim() === "" ? [] : new InListParser().parse(inner);
}
