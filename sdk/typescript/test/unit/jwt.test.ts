import { describe, expect, it } from 'vitest';
import { NelcotaUsageError } from '../../src/core/errors.js';
import { assertTokenAllowed, decodeJwt } from '../../src/core/jwt.js';

describe('JWT payload decoding', () => {
  it.each(['Renée 🚀', 'Renée 🚀x', 'Renée 🚀xy'])('reads padded and unpadded UTF-8 claims (%s)', name => {
    const claims = { role: 'service_role', exp: 1_900_000_000, name };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    for (const encoded of [payload, payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')]) {
      const token = `header.${encoded}.signature`;
      expect(decodeJwt(token)).toEqual(claims);
      expect(() => assertTokenAllowed(token, true)).toThrow(NelcotaUsageError);
    }
  });

  it.each(['header.a.signature', 'header.%%%.signature', 'header.bnVsbA.signature', 'header.W10.signature'])(
    'ignores malformed or non-object payloads (%s)', token => {
      expect(decodeJwt(token)).toBeNull();
    },
  );
});
