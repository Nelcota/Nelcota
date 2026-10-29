import { requiredValue } from "../../../src/core/required-value.js";

type QuoteState = "plain" | "quoted" | "escaped";
class OperandParser {
  #depth = 0;
  #quote: QuoteState = "plain";
  #quoted(character: string): void {
    if (this.#quote === "escaped") {
      this.#quote = "quoted";
      return;
    }
    if (character === "\\") {
      this.#quote = "escaped";
      return;
    }
    this.#quote = character === '"' ? "plain" : "quoted";
  }
  #delimiter(character: string): boolean {
    if (this.#quote !== "plain") {
      this.#quoted(character);
      return false;
    }
    if (character === '"') {
      this.#quote = "quoted";
      return false;
    }
    if (character === "(") {
      this.#depth++;
      return false;
    }
    if (character === ")") {
      if (this.#depth === 0) throw new Error("unbalanced");
      this.#depth--;
      return false;
    }
    return character === "," && this.#depth === 0;
  }
  parse(input: string): string[] {
    const parts: string[] = [];
    let start = 0;
    for (let index = 0; index < input.length; index++) {
      if (this.#delimiter(requiredValue(input[index], "server grammar character"))) {
        parts.push(input.slice(start, index));
        start = index + 1;
      }
    }
    if (this.#quote !== "plain" || this.#depth !== 0) throw new Error("unbalanced");
    parts.push(input.slice(start));
    return parts;
  }
}

/** Split only delimiters outside quoted values and nested operand groups. */
export function splitTopLevel(input: string): string[] {
  return new OperandParser().parse(input);
}
