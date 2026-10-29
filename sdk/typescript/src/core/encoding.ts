/**
 * Turning caller input into the API's URL grammar. The rule is that input
 * never becomes syntax: identifiers are validated (they cannot be quoted in
 * the grammar), and values are quoted wherever the grammar has delimiters.
 * Every function throws `NelcotaUsageError` before any request is sent.
 */

import { NelcotaUsageError } from "./client.errors.js";

/** Characters that delimit the query grammar (`select`, filters, `order`). */
const GRAMMAR = /[.,()":!*\\\s\p{Cc}]/u;
const MAX_IDENTIFIER_BYTES = 63;
const encoder = new TextEncoder();

/** A table, column, function or alias name that the grammar can carry. */
export function identifier(name: string, what = "name"): string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    GRAMMAR.test(name) ||
    encoder.encode(name).length > MAX_IDENTIFIER_BYTES
  ) {
    throw new NelcotaUsageError(
      `Invalid ${what} ${JSON.stringify(name)}: up to 63 bytes, without spaces or . , ( ) " : ! * \\`,
    );
  }
  return name;
}

/**
 * A column, optionally inside embeds (`orders.total`, `orders.items.qty`).
 * Each segment is validated on its own.
 */
export function columnPath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new NelcotaUsageError(`Invalid column ${JSON.stringify(path)}`);
  }
  for (const segment of path.split(".")) identifier(segment, "column");
  return path;
}

export type FilterScalar = string | number | bigint | boolean | Date;

/** A value as text, the way Postgres reads it (`$1::text::<type>`). */
export function scalar(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new NelcotaUsageError("Cannot filter by an invalid Date");
    return value.toISOString();
  }
  if (value === null) throw new NelcotaUsageError("Use .is(column, null) to filter by null");
  const text = primitiveText(value);
  if (text !== undefined) return text;
  throw new NelcotaUsageError(
    `Cannot filter by a ${typeof value}: use a string, number, bigint, boolean or Date`,
  );
}

function primitiveText(value: unknown): string | undefined {
  switch (typeof value) {
    case "string":
      return value;
    case "bigint":
      return value.toString();
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return numberText(value);
    case "function":
    case "object":
    case "symbol":
    case "undefined":
      return undefined;
  }
}

function numberText(value: number): string {
  if (Number.isFinite(value) === false)
    throw new NelcotaUsageError(`Cannot filter by ${value}: only finite numbers`);
  return String(value);
}

/** A double-quoted value: the grammar's escapes are `\"` and `\\`. */
export function quote(value: string): string {
  return `"${value.replaceAll(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** The operand of `in`: `("a","b,c")`, every item quoted. */
export function inList(values: readonly unknown[]): string {
  if (Array.isArray(values) === false) throw new NelcotaUsageError("in expects an array");
  return `(${values.map((v) => quote(scalar(v))).join(",")})`;
}

/**
 * Escapes the LIKE wildcards in text a person typed, for `like`/`ilike`
 * patterns: `%` and `_` become literal. The API reads `*` as `%` and has no
 * escape for it, so a typed `*` matches any single character instead.
 */
export function escapeLike(text: string): string {
  return text.replaceAll(/[\\%_]/g, (c) => `\\${c}`).replaceAll("*", "_");
}

const BUCKET = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const RESERVED_BUCKETS = new Set(["public", "sign", "list"]);
const MAX_OBJECT_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;

export function bucketId(id: string): string {
  if (typeof id !== "string" || BUCKET.test(id) === false || RESERVED_BUCKETS.has(id)) {
    throw new NelcotaUsageError(
      `Invalid bucket ${JSON.stringify(id)}: lowercase letters, digits, '-' and '_', up to 63, not public/sign/list`,
    );
  }
  return id;
}

/**
 * An object name, NFC-normalized like the server does, encoded segment by
 * segment for the URL path. `..`, `.`, empty segments, control characters
 * and backslashes are refused, so a name can never climb out of its bucket.
 */
export function objectPath(name: string): string {
  if (typeof name !== "string") throw new NelcotaUsageError("A file name must be a string");
  const normalized = name.normalize("NFC");
  const bytes = encoder.encode(normalized).length;
  if (bytes === 0 || bytes > MAX_OBJECT_BYTES) {
    throw new NelcotaUsageError(`A file name needs 1 to ${MAX_OBJECT_BYTES} bytes`);
  }
  if (/[\p{Cc}\\]/u.test(normalized)) {
    throw new NelcotaUsageError("A file name cannot hold control characters or a backslash");
  }
  return normalized
    .split("/")
    .map((segment) => {
      if (segment === "" || segment === "." || segment === "..") {
        throw new NelcotaUsageError(
          `Invalid file name ${JSON.stringify(name)}: empty, '.' or '..' segment`,
        );
      }
      if (encoder.encode(segment).length > MAX_SEGMENT_BYTES) {
        throw new NelcotaUsageError(
          `Each part of a file name holds up to ${MAX_SEGMENT_BYTES} bytes`,
        );
      }
      return encodeURIComponent(segment);
    })
    .join("/");
}

/** A listing prefix: empty, or a folder ending in `/`. Returned unencoded (it goes in a JSON body). */
export function folderPrefix(prefix: string): string {
  if (prefix === "") return "";
  if (typeof prefix !== "string" || prefix.endsWith("/") === false) {
    throw new NelcotaUsageError("A prefix is a folder and ends in '/'");
  }
  objectPath(prefix.slice(0, -1));
  return prefix.normalize("NFC");
}
