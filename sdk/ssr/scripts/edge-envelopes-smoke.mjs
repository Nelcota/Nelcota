import assert from "node:assert/strict";
import { randomBytes, webcrypto, createHash } from "node:crypto";
/** Independently verifies both released envelope formats and session hashes.
 * @param {string} secret
 * @param {typeof import("../src/sealing/seal.js")} sealing */
export async function verifyReleasedEnvelopes(secret, { SessionSealer, sessionKey }) {
  const state = {
    schema: 1,
    session: "old-session",
    pkce: null,
    oauthState: null,
    returnTo: "/",
    expiresAt: Date.now() + 60_000,
  };
  const sealer = await SessionSealer.create([secret]);
  const raw = Buffer.from(secret, "base64url");
  const keyId = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  // Independent construction of both previously released formats.
  for (const version of ["v1", "v2"]) {
    // oxlint-disable-next-line no-await-in-loop -- Verify each released envelope before constructing the next case.
    const envelope = await releasedEnvelope(version, { raw, keyId, state });
    // oxlint-disable-next-line no-await-in-loop -- Verify each released envelope before constructing the next case.
    assert.equal((await sealer.open(envelope, "binding")).session, "old-session");
    // oxlint-disable-next-line no-await-in-loop -- Verify each released envelope before constructing the next case.
    await assert.rejects(sealer.open(envelope, "other-project"));
  }
  const id = randomBytes(32).toString("base64url");
  assert.equal(
    await sessionKey(id, "namespace"),
    createHash("sha256").update("namespace\0").update(id).digest("hex"),
  );
}
/** @param {string} version
 * @param {{raw: Buffer<ArrayBuffer>, keyId: string, state: {schema: number, session: string, pkce: null, oauthState: null, returnTo: string, expiresAt: number}}} fixture */
async function releasedEnvelope(version, { raw, keyId, state }) {
  const salt = randomBytes(16),
    iv = randomBytes(12);

  let key = await webcrypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
  if (version === "v2") {
    const hkdf = await webcrypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);

    key = await webcrypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: Buffer.from(`nelcota-next/seal/v2\0${keyId}`),
      },
      hkdf,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
  }

  const encrypted = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: Buffer.from("binding") },
    key,
    Buffer.from(JSON.stringify(state)),
  );
  const body = Buffer.concat([
    ...(version === "v2" ? [salt] : []),
    iv,
    Buffer.from(encrypted),
  ]).toString("base64url");
  return `${version}.${keyId}.${body}`;
}
