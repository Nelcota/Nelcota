import { randomBytes } from "node:crypto";
/** @typedef {import("node:http").IncomingMessage} Incoming */
/** @typedef {import("node:http").ServerResponse} Outgoing */

/** Owns only local auth transport for the production SvelteKit smoke. */
export class KitAuth {
  user = {
    id: "kit-fixture-user",
    email: "kit@example.test",
    email_confirmed_at: null,
    user_metadata: {},
    created_at: "",
    last_sign_in_at: null,
  };
  password = randomBytes(24).toString("base64url");
  access = `fixture-access-private-${randomBytes(8).toString("hex")}`;
  counts = { password: 0, user: 0, refresh: 0, logout: 0 };
  signedOut = false;
  expired = false;
  current = this.access;
  /** @param {Incoming} request @param {Outgoing} response */
  async handle(request, response) {
    response.setHeader("content-type", "application/json");
    const target = new URL(request.url ?? "/", "http://fixture");
    const input = await requestInput(request);
    if (
      target.pathname === "/auth/v1/token" &&
      target.searchParams.get("grant_type") === "password"
    )
      return this.passwordGrant(input, response);
    if (
      target.pathname === "/auth/v1/token" &&
      target.searchParams.get("grant_type") === "refresh_token"
    )
      return this.refresh(input, response);
    if (target.pathname === "/auth/v1/user") return this.readUser(request, response);
    if (target.pathname === "/auth/v1/logout") return this.logout(response);
    fail(response, 404, "not_found");
  }
  /** @param {Record<string, unknown>} input @param {Outgoing} response */
  passwordGrant(input, response) {
    this.counts.password++;
    if (input.email !== this.user.email || input.password !== this.password)
      return fail(response, 400, "invalid_credentials");
    this.signedOut = false;
    this.issue(response, this.access, "fixture-refresh-private");
  }
  /** @param {Record<string, unknown>} input @param {Outgoing} response */
  refresh(input, response) {
    this.counts.refresh++;
    if (input.refresh_token !== "fixture-refresh-private")
      return fail(response, 400, "invalid_grant");
    this.expired = false;
    this.issue(response, `${this.access}-renewed`, "fixture-refresh-private-renewed");
  }
  /** @param {Incoming} request @param {Outgoing} response */
  readUser(request, response) {
    this.counts.user++;
    if (
      this.signedOut ||
      this.expired ||
      request.headers.authorization !== `Bearer ${this.current}`
    )
      return fail(response, 401, "invalid_token");
    response.end(JSON.stringify(this.user));
  }
  /** @param {Outgoing} response */
  logout(response) {
    this.counts.logout++;
    this.signedOut = true;
    response.writeHead(204);
    response.end();
  }
  /** @param {Outgoing} response @param {string} token @param {string} refresh */
  issue(response, token, refresh) {
    this.current = token;
    response.end(
      JSON.stringify({
        access_token: token,
        refresh_token: refresh,
        token_type: "bearer",
        expires_in: 900,
        expires_at: Math.floor(Date.now() / 1000) + 900,
        user: this.user,
      }),
    );
  }
}
/** @param {Incoming} request @returns {Promise<Record<string, unknown>>} */
async function requestInput(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  const parsed = /** @type {unknown} */ (JSON.parse(body === "" ? "{}" : body));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Expected an auth request object");
  return /** @type {Record<string, unknown>} */ (parsed);
}
/** @param {Outgoing} response @param {number} status @param {string} code */
function fail(response, status, code) {
  response.writeHead(status);
  response.end(JSON.stringify({ code, message: "Fixture refusal" }));
}
