import { createHash, hkdfSync, randomBytes, webcrypto } from "node:crypto";

import { expect, it } from "vitest";

import { MAX_SEALED_CHARS, SessionSealer, type SessionState } from "../src/sealing/seal.js";
import { requiredValue } from "./required-value.js";

const state = (): SessionState => ({
  schema: 1,
  session: "private-session",
  pkce: "private-pkce",
  oauthState: null,
  returnTo: "/",
  expiresAt: Date.now() + 60000,
});
async function legacyV1(secret: string): Promise<string> {
  const bytes = Buffer.from(secret, "base64url"),
    iv = randomBytes(12);
  const raw = await webcrypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const encrypted = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: Buffer.from("binding") },
    raw,
    Buffer.from(JSON.stringify(state())),
  );
  return `v1.${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${Buffer.concat([iv, Buffer.from(encrypted)]).toString("base64url")}`;
}

it("writes the digest key id 0.1.x reads and also opens the HKDF-derived id", async () => {
  const secret = randomBytes(32).toString("base64url"),
    sealer = await SessionSealer.create([secret]);
  const raw = Buffer.from(secret, "base64url");
  const digestId = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const derivedId = Buffer.from(
    hkdfSync("sha256", raw, Buffer.alloc(0), "nelcota-next/key-id/v1", 8),
  ).toString("hex");
  const sealed = await sealer.seal(state(), "binding");
  const [, id, body] = sealed.split(".");
  // Rolling deploys and rollbacks: 0.1.x instances select keys by the digest id.
  expect(id).toBe(digestId);
  expect(derivedId).not.toBe(digestId);
  // Forward compatibility: a later release writes the derived id with the same body.
  const future = `v2.${derivedId}.${requiredValue(body, "sealed body")}`;
  expect((await sealer.open(future, "binding")).session).toBe("private-session");
  expect((await sealer.open(sealed, "binding")).session).toBe("private-session");
});

it("refuses v1 envelopes only when legacy envelopes are disabled", async () => {
  const secret = randomBytes(32).toString("base64url");
  const legacy = await legacyV1(secret);
  const strict = await SessionSealer.create([secret], { legacyEnvelopes: false });
  await expect(strict.open(legacy, "binding")).rejects.toMatchObject({ code: "invalid_session" });
  const sealed = await strict.seal(state(), "binding");
  expect((await strict.open(sealed, "binding")).pkce).toBe("private-pkce");
  expect((await (await SessionSealer.create([secret])).open(legacy, "binding")).pkce).toBe(
    "private-pkce",
  );
});

it("derives the store bound from the plaintext cap", async () => {
  const sealer = await SessionSealer.create([randomBytes(32).toString("base64url")]);
  const fill = (length: number): SessionState => ({ ...state(), returnTo: "x".repeat(length) });
  const overhead = new TextEncoder().encode(JSON.stringify(fill(0))).length;
  const largest = await sealer.seal(fill(65_536 - overhead), "binding");
  expect(largest.length).toBeLessThanOrEqual(MAX_SEALED_CHARS);
  expect(MAX_SEALED_CHARS - largest.length).toBeLessThan(4);
  expect(MAX_SEALED_CHARS).toBeLessThan(131_072);
  await expect(sealer.seal(fill(65_537 - overhead), "binding")).rejects.toMatchObject({
    code: "invalid_session",
  });
});
