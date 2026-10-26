import { describe, expect, it } from 'vitest';
import { encodeJson, parseJson } from '../../src/core/json.js';
import fc from 'fast-check';

describe('lossless numeric responses', () => {
  it('preserves every sampled signed 64-bit integer', () => {
    fc.assert(fc.property(fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }), value => {
      const expected = value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value.toString();
      expect(parseJson(`[${value}]`)).toEqual([expected]);
    }));
  });
  it('preserves unsafe integers and decimal digits inside nested values', () => {
    expect(parseJson('{"id":9007199254740993,"amount":12345678901234567890.123456789,"nested":[-9007199254740993,0.1234567890123456789,1e400,1e-400]}')).toEqual({
      id: '9007199254740993', amount: '12345678901234567890.123456789',
      nested: ['-9007199254740993', '0.1234567890123456789', '1e400', '1e-400'],
    });
  });
  it('keeps ordinary numbers and equivalent decimal notation numeric', () => {
    expect(parseJson('[0,-0,0.1,1.2500,1e3,1.25e-3,9007199254740991]')).toEqual([0, -0, 0.1, 1.25, 1000, 0.00125, Number.MAX_SAFE_INTEGER]);
  });
  it('leaves strings, escapes and property names untouched', () => {
    const original = { '9007199254740993': 'value " 9007199254740993', slash: '\\', line: '\n', unicode: 'ação' };
    expect(parseJson(JSON.stringify(original))).toEqual(original);
  });
  it.each(['{9007199254740993:1}', '[01]', '[NaN]', '[1e]', '[1e400,]', '"unterminated', '[1.2.3]'])('rejects malformed input %s', input => {
    expect(() => parseJson(input)).toThrow(SyntaxError);
  });
});


it.each(['x', '\\"12345678901234567890'])('decodes large strings without regex stack growth (%s)', fragment => {
  const body = fragment.repeat(Math.ceil(10 * 1024 * 1024 / fragment.length));
  const wire = `{"body":${JSON.stringify(body)},"id":9007199254740993}`;
  expect(parseJson(wire)).toEqual({ body, id: '9007199254740993' });
});

describe('request bodies', () => {
  it('refuses values JSON would silently turn into null or throw on', () => {
    // Date#toJSON turns an invalid date into null before any replacer sees it.
    expect(() => encodeJson({ due: new Date('bogus') })).toThrow('JSON dates must be valid');
    expect(() => encodeJson({ id: 10n })).toThrow('bigint');
    expect(encodeJson({ due: new Date(0), none: null })).toBe('{"due":"1970-01-01T00:00:00.000Z","none":null}');
  });
});
