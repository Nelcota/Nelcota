import { createHash, createHmac } from "node:crypto";
/** Minimal SigV4 for management of the disposable provider's own bucket. */
export class FixtureProvider {
  /** @param {{endpoint: URL, key: string, secret: string, region: string}} configuration */
  constructor(configuration) {
    this.configuration = configuration;
  }
  /** @param {string} method @param {string} path @param {string} [query] */
  async request(method, path, query = "") {
    const s3 = this.configuration;
    const url = new URL(path + (query !== "" ? `?${query}` : ""), s3.endpoint),
      now = new Date().toISOString().replaceAll(/[:-]|\.\d{3}/g, ""),
      day = now.slice(0, 8);
    /** @param {string} value */
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    /** @param {string | Uint8Array} key
     * @param {string} value */
    const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
    const payload = hash(""),
      scope = `${day}/${s3.region}/s3/aws4_request`,
      signed = "host;x-amz-content-sha256;x-amz-date";
    const canonical = [
      method,
      url.pathname,
      [...url.searchParams]
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .toSorted()
        .join("&"),
      `host:${url.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${now}\n`,
      signed,
      payload,
    ].join("\n");
    const key = hmac(hmac(hmac(hmac(`AWS4${s3.secret}`, day), s3.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", key)
      .update(["AWS4-HMAC-SHA256", now, scope, hash(canonical)].join("\n"))
      .digest("hex");
    const response = await fetch(url, {
      method,
      headers: {
        "x-amz-date": now,
        "x-amz-content-sha256": payload,
        authorization: `AWS4-HMAC-SHA256 Credential=${s3.key}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
      },
    });
    const text = await response.text();
    if (response.ok === false)
      throw new Error(`Provider ${method} ${url.pathname} failed: ${response.status}`);
    return text;
  }
}
