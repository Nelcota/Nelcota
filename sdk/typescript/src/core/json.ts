import { NelcotaUsageError } from './errors.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decimal identity, independent of exponent notation or insignificant zeros. */
function decimal(source: string): string {
  const [mantissa = '', power = '0'] = source.toLowerCase().split('e');
  const [whole = '', fraction = ''] = mantissa.split('.');
  const negative = whole.startsWith('-');
  const digits = (whole.replace('-', '') + fraction).replace(/^0+/, '');
  if (digits === '') return '0';
  const significant = digits.replace(/0+$/, '');
  const exponent = BigInt(power) - BigInt(fraction.length) + BigInt(digits.length - significant.length);
  return `${negative ? '-' : ''}${significant}e${exponent}`;
}
/**
 * Keep ordinary numbers numeric; preserve unsafe integers and decimals whose
 * digits would change as strings. This also works without JSON reviver source
 * support. Validate the original document before rewriting numeric tokens so
 * malformed JSON (including unquoted numeric keys) cannot become valid.
 */
export function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  let changed = false;
  const preserved = text.replace(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token.startsWith('"')) return token;
    const value = Number(token);
    if (Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) && decimal(token) === decimal(String(value))) return token;
    changed = true;
    return JSON.stringify(token);
  });
  return changed ? JSON.parse(preserved) as unknown : parsed;
}

/** Explicit null is valid; a non-finite number must never silently become null. */
export function encodeJson(input: unknown): string {
  const text = JSON.stringify(input, (_key, original: unknown) => {
    const value = original instanceof Number ? original.valueOf() : original;
    if (typeof value === 'number' && !Number.isFinite(value)) throw new NelcotaUsageError('JSON numbers must be finite');
    return value;
  });
  if (text === undefined) throw new NelcotaUsageError('Request body must be JSON serializable');
  return text;
}
