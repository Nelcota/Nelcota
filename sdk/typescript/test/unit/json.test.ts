import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { encodeJson, parseJson } from "../../src/core/json.js";

it("lossless numeric responses: preserves every sampled signed 64-bit integer", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }), (value) => {
      const expected =
        value >= -9007199254740991n && value <= 9007199254740991n
          ? Number(value)
          : value.toString();
      expect(parseJson(`[${value}]`)).toEqual([expected]);
    }),
  );
});

it("lossless numeric responses: preserves unsafe integers and decimal digits inside nested values", () => {
  expect(
    parseJson(
      '{"id":9007199254740993,"amount":12345678901234567890.123456789,"nested":[-9007199254740993,0.1234567890123456789,1e400,1e-400]}',
    ),
  ).toEqual({
    id: "9007199254740993",
    amount: "12345678901234567890.123456789",
    nested: ["-9007199254740993", "0.1234567890123456789", "1e400", "1e-400"],
  });
});

it("lossless numeric responses: keeps ordinary numbers and equivalent decimal notation numeric", () => {
  expect(parseJson("[0,-0,0.1,1.2500,1e3,1.25e-3,9007199254740991]")).toEqual([
    0,
    -0,
    0.1,
    1.25,
    1000,
    0.00125,
    Number.MAX_SAFE_INTEGER,
  ]);
});

it("lossless numeric responses: leaves strings, escapes and property names untouched", () => {
  const original = {
    "9007199254740993": 'value " 9007199254740993',
    slash: "\\",
    line: "\n",
    unicode: "ação",
  };
  expect(parseJson(JSON.stringify(original))).toEqual(original);
});

it.each(["{9007199254740993:1}", "[01]", "[NaN]", "[1e]", "[1e400,]", '"unterminated', "[1.2.3]"])(
  "lossless numeric responses: rejects malformed input %s",
  (input) => {
    expect(() => parseJson(input)).toThrow(SyntaxError);
  },
);

it.each(["x", '\\"12345678901234567890'])(
  "decodes large strings without regex stack growth (%s)",
  (fragment) => {
    const body = fragment.repeat(Math.ceil((10 * 1024 * 1024) / fragment.length));
    const wire = `{"body":${JSON.stringify(body)},"id":9007199254740993}`;
    expect(parseJson(wire)).toEqual({ body, id: "9007199254740993" });
  },
);

describe("request bodies", () => {
  it("refuses values JSON would silently turn into null or throw on", () => {
    // Date#toJSON turns an invalid date into null before any replacer sees it.
    expect(() => encodeJson({ due: new Date(Number.NaN) })).toThrow("JSON dates must be valid");
    expect(() => encodeJson({ id: 10n })).toThrow("bigint");
    expect(encodeJson({ due: new Date(0), none: null })).toBe(
      '{"due":"1970-01-01T00:00:00.000Z","none":null}',
    );
  });
});

const token = fc.oneof(
  fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }).map(String),
  fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .filter((value) => Object.is(value, -0) === false)
    .map(String),
  fc
    .tuple(
      fc.stringMatching(/^-?(?:0|[1-9]\d{0,24})$/),
      fc.stringMatching(/^\d{1,24}$/),
      fc.option(fc.stringMatching(/^[eE][+-]?\d{1,3}$/)),
    )
    .map(([whole, fraction, exponent]) => `${whole}.${fraction}${exponent ?? ""}`),
);
// A 16-digit string forces the full rewrite pass, so it is the reference.
const SLOW_PATH_MARKER = '"0000000000000000"';
it("parseJson fast path > returns the same values as the full rewrite pass", () => {
  fc.assert(
    fc.property(fc.array(token, { minLength: 1, maxLength: 8 }), (tokens) => {
      const fast = parseJson(`[${tokens.join(",")}]`) as unknown[];
      const reference = parseJson(`[${[...tokens, SLOW_PATH_MARKER].join(",")}]`) as unknown[];
      expect(fast).toEqual(reference.slice(0, -1));
    }),
  );
});
it("parseJson fast path > takes the fast path for short tokens and still matches the full pass", () => {
  const short = fc.oneof(
    fc.integer({ min: -99_999_999_999_999, max: 99_999_999_999_999 }).map(String),
    fc
      .tuple(fc.stringMatching(/^-?(?:0|[1-9]\d{0,6})$/), fc.stringMatching(/^\d{1,7}$/))
      .map(([whole, fraction]) => `${whole}.${fraction}`),
  );
  fc.assert(
    fc.property(fc.array(short, { minLength: 1, maxLength: 8 }), (tokens) => {
      const text = `[${tokens.join(", ")}]`;
      const reference = parseJson(`[${[...tokens, SLOW_PATH_MARKER].join(",")}]`) as unknown[];
      expect(parseJson(text)).toEqual(JSON.parse(text));
      expect(parseJson(text)).toEqual(reference.slice(0, -1));
    }),
  );
});
it("parseJson fast path > rewrites exponent and long tokens wherever they end in the document", () => {
  expect(parseJson("1e400")).toBe("1e400");
  expect(parseJson('{"a":1E-400}')).toEqual({ a: "1E-400" });
  const documents = [
    "[1e400,2]",
    "[1e400]",
    '{"a":1e400}',
    "[1e400 ,2]",
    "[1e400\t,2]",
    "[1e400\r,2]",
    "[1e400\n,2]",
  ];
  for (const text of documents) {
    const value = parseJson(text);
    expect(JSON.stringify(value)).toContain('"1e400"');
  }
  expect(parseJson("[12345678901234567]")).toEqual(["12345678901234567"]);
  expect(parseJson("[0.12345678901234567]")).toEqual(["0.12345678901234567"]);
});
it("parseJson fast path > leaves strings that look like numbers untouched", () => {
  const uuid = "0c1e3f2a-41e3-4b6c-9d1e-123456789012";
  expect(parseJson(JSON.stringify({ id: uuid, note: "1e3, 12345678901234567" }))).toEqual({
    id: uuid,
    note: "1e3, 12345678901234567",
  });
});
