import { NelcotaUsageError } from "./client.errors.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Array.isArray(value) === false;
}

/** Decimal identity, independent of exponent notation or insignificant zeros. */
function decimal(source: string): string {
  const [mantissa = "", power = "0"] = source.toLowerCase().split("e");
  const [whole = "", fraction = ""] = mantissa.split(".");
  const negative = whole.startsWith("-");
  const digits = (whole.replace("-", "") + fraction).replace(/^0+/, "");
  if (digits === "") return "0";
  const significant = digits.replace(/0+$/, "");
  const exponent =
    BigInt(power) - BigInt(fraction.length) + BigInt(digits.length - significant.length);
  return `${negative ? "-" : ""}${significant}e${exponent}`;
}
/**
 * A number token can only lose digits with 16+ significant digits (a run of
 * 16 digits or dots) or an exponent (a digit, e/E and digits ending at a JSON
 * delimiter). Doubles round-trip every decimal up to 15 significant digits, so
 * documents without either skip the rewrite pass. Matches inside strings only
 * cost the slow path, never correctness.
 */
const MAY_NEED_REWRITE = /[\d.]{16}|\d[eE][+-]?\d+(?:[,\]}\s]|$)/;
/**
 * Keep ordinary numbers numeric; preserve unsafe integers and decimals whose
 * digits would change as strings. This also works without JSON reviver source
 * support. Validate the original document before rewriting numeric tokens so
 * malformed JSON (including unquoted numeric keys) cannot become valid.
 */
export function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  if (MAY_NEED_REWRITE.test(text) === false) return parsed;
  let quoted = false;
  // Match escapes separately: a repeated full-string regex can exhaust the
  // engine stack on valid large strings. Only unquoted numbers are rewritten.
  const preserved = text.replaceAll(
    /\\.|"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (token) => {
      if (token === '"') {
        quoted = quoted === false;
        return token;
      }
      if (quoted) return token;
      const value = Number(token);
      if (
        Number.isFinite(value) &&
        (Number.isInteger(value) === false || Number.isSafeInteger(value)) &&
        decimal(token) === decimal(String(value))
      )
        return token;
      return JSON.stringify(token);
    },
  );
  return preserved !== text ? (JSON.parse(preserved) as unknown) : parsed;
}

/** Explicit null is valid; a non-finite number must never silently become null. */
export function encodeJson(input: unknown): string {
  const text = JSON.stringify(
    input,
    function (this: Record<string, unknown>, key, original: unknown) {
      const value = original instanceof Number ? original.valueOf() : original;
      if (typeof value === "number" && Number.isFinite(value) === false)
        throw new NelcotaUsageError("JSON numbers must be finite");
      // An invalid Date reaches here as null (toJSON ran first).
      const raw = this[key];
      if (raw instanceof Date && Number.isNaN(raw.getTime()))
        throw new NelcotaUsageError("JSON dates must be valid");
      if (typeof value === "bigint") throw new NelcotaUsageError("JSON cannot carry a bigint");
      return value;
    },
  );
  if (typeof text !== "string")
    throw new NelcotaUsageError("Request body must be JSON serializable");
  return text;
}
