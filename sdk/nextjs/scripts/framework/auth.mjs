import { randomBytes } from "node:crypto";

import { fixtureObject, fixtureString } from "../fixture-values.mjs";
/** @param {string} id
 * @param {string} email */
const profile = (id, email) => ({
  id,
  email,
  email_confirmed_at: null,
  user_metadata: {},
  created_at: "",
  last_sign_in_at: null,
});

/** @typedef {{user: ReturnType<typeof profile>, tag: string}} FixtureUser */
/** @param {FixtureUser} row */
const session = (row) => ({
  access_token: `fixture-access-private-${row.tag}`,
  refresh_token: `fixture-refresh-private-${row.tag}`,
  token_type: "bearer",
  expires_in: 900,
  expires_at: Math.floor(Date.now() / 1000) + 900,
  user: row.user,
});

/** @param {Record<string, unknown>} payload */
function requestInput(payload) {
  return {
    data: fixtureObject(payload.data ?? {}),
    email: typeof payload.email === "string" ? payload.email : "",
    password: typeof payload.password === "string" ? payload.password : "",
    refresh_token: typeof payload.refresh_token === "string" ? payload.refresh_token : "",
    auth_code: typeof payload.auth_code === "string" ? payload.auth_code : "",
    code_verifier: typeof payload.code_verifier === "string" ? payload.code_verifier : "",
    token: typeof payload.token === "string" ? payload.token : "",
    type: typeof payload.type === "string" ? payload.type : "",
  };
}
/** @typedef {{input: ReturnType<typeof requestInput>, target: URL, path: string, request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, reply: (value: unknown) => void, invalid: () => void}} FixtureRequest */
/** Local auth transport; this fixture does not establish provider acceptance. */
export class FrameworkAuth {
  user = profile("next-fixture-user", "next@example.test");
  // Every fixture credential contains `-private`, so one substring check covers all of them.
  users = new Map([
    [this.user.email, { user: this.user, tag: "next" }],
    ["alice@example.test", { user: profile("alice", "alice@example.test"), tag: "alice" }],
    ["bob@example.test", { user: profile("bob", "bob@example.test"), tag: "bob" }],
  ]);
  tokens = new Map(
    [...this.users.values()].map((row) => [`Bearer fixture-access-private-${row.tag}`, row.user]),
  );
  counts = { password: 0, user: 0, logout: 0, refresh: 0, signup: 0, verify: 0 };
  password = randomBytes(24).toString("base64url");
  /** @type {Map<string, {row: FixtureUser, type: string}>} */
  emailLinks = new Map();
  /** @type {Map<string, string>} */
  oauthCodes = new Map();
  requireRefresh = false;

  /** @type {string[]} */
  grants = [];
  /** @param {string} email */
  fixtureUser(email) {
    const row = this.users.get(email);
    if (row === undefined) throw new Error("Missing fixture user");
    return row;
  }
  /** @param {import("node:http").IncomingMessage} request */
  tokenRow(request) {
    return this.users.get(this.tokens.get(request.headers.authorization ?? "")?.email ?? "");
  }
  /** @param {import("node:http").IncomingMessage} request
   * @param {import("node:http").ServerResponse} response */
  async handle(request, response) {
    response.setHeader("content-type", "application/json");
    const target = new URL(request.url ?? "/", "http://fixture"),
      path = target.pathname;
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = requestInput(fixtureObject(JSON.parse(body === "" ? "{}" : body)));
    /** @param {unknown} value */
    const reply = (value) => {
      response.end(JSON.stringify(value));
    };
    const invalid = () => {
      response.writeHead(400);
      reply({ code: "invalid_grant", message: "Invalid fixture credential" });
    };
    const context = { input, target, path, request, response, reply, invalid };
    return await this.dispatch(context);
  }
  expireSession() {
    this.requireRefresh = true;
  }
  /** @param {FixtureRequest} context */
  dispatch(context) {
    const { path, response, reply } = context;
    switch (path) {
      case "/auth/v1/token":
        return this.token(context);
      case "/auth/v1/signup":
        return this.signup(context);
      case "/auth/v1/recover":
      case "/auth/v1/magiclink":
      case "/auth/v1/resend":
        return this.emailLink(context);
      case "/auth/v1/verify":
        return this.verify(context);
      case "/auth/v1/authorize":
        return this.authorize(context);
      case "/auth/v1/user":
        return this.userRequest(context);
      case "/auth/v1/logout":
        return this.logout(context);
    }
    response.writeHead(404);
    reply({ code: "not_found", message: "Fixture route not found" });
  }

  /** @param {FixtureRequest} context */
  token(context) {
    switch (context.target.searchParams.get("grant_type")) {
      case "refresh_token":
        return this.refresh(context);
      case "pkce":
        return this.pkce(context);
      case null:
        return this.passwordGrant(context);
      default:
        return this.passwordGrant(context);
    }
  }
  /** @param {FixtureRequest} context */
  userRequest(context) {
    return context.request.method === "PUT" ? this.update(context) : this.readUser(context);
  }

  /** @param {FixtureRequest} context */
  refresh(context) {
    const { input, reply, invalid } = context;

    this.counts.refresh++;
    const row = [...this.users.values()].find(
      (row) => session(row).refresh_token === input.refresh_token,
    );
    if (row == null) {
      invalid();
      return;
    }
    reply(session(row));
    return;
  }

  /** @param {FixtureRequest} context */
  async pkce(context) {
    const { input, reply, invalid } = context;

    const challenge = this.oauthCodes.get(input.auth_code);
    this.oauthCodes.delete(input.auth_code);
    const { createHash } = await import("node:crypto");
    if (
      challenge === undefined ||
      createHash("sha256").update(input.code_verifier).digest("base64url") !== challenge
    ) {
      invalid();
      return;
    }
    reply(session(this.fixtureUser(this.user.email)));
    return;
  }

  /** @param {FixtureRequest} context */
  passwordGrant(context) {
    const { input, response, reply } = context;

    this.counts.password++;
    const row = this.users.get(input.email);
    if (row == null) {
      response.writeHead(400);
      response.end(JSON.stringify({ code: "invalid_credentials", message: "Invalid login" }));
      return;
    }
    this.grants.push(row.user.email);
    reply(session(row));
    return;
  }

  /** @param {FixtureRequest} context */
  signup(context) {
    const { input, reply } = context;

    this.counts.signup++;
    const row = {
      user: profile(`signup-${this.counts.signup}`, input.email),
      tag: `signup-${this.counts.signup}`,
    };
    this.users.set(input.email, row);
    this.tokens.set(`Bearer ${session(row).access_token}`, row.user);
    const token = randomBytes(32).toString("base64url");
    this.emailLinks.set(token, { row, type: "signup" });
    reply({ user: row.user, session: null });
    return;
  }

  /** @param {FixtureRequest} context */
  emailLink(context) {
    const { input, path, reply } = context;

    const row = this.users.get(input.email);
    if (row !== undefined)
      this.emailLinks.set(randomBytes(32).toString("base64url"), {
        row,
        type: emailLinkType(path),
      });
    reply(null);
    return;
  }

  /** @param {FixtureRequest} context */
  verify(context) {
    const { input, reply, invalid } = context;

    const link = this.emailLinks.get(input.token);
    if (link === undefined || link.type !== input.type) {
      invalid();
      return;
    }
    this.emailLinks.delete(input.token);
    this.counts.verify++;
    reply(session(link.row));
    return;
  }

  /** @param {FixtureRequest} context */
  authorize(context) {
    const { target, response } = context;

    const redirect = new URL(fixtureString(target.searchParams.get("redirect_to")));
    const code = randomBytes(24).toString("base64url");
    this.oauthCodes.set(code, fixtureString(target.searchParams.get("code_challenge")));
    redirect.searchParams.set("code", code);
    response.setHeader("location", redirect.href);
    response.writeHead(302);
    response.end();
    return;
  }

  /** @param {FixtureRequest} context */
  update(context) {
    const { input, request, reply, invalid } = context;

    const row = this.tokenRow(request);
    if (row == null) {
      invalid();
      return;
    }
    row.user.user_metadata = input.data;
    reply(row.user);
    return;
  }

  /** @param {FixtureRequest} context */
  readUser(context) {
    const { request, response, reply } = context;

    this.counts.user++;
    if (this.requireRefresh) {
      this.requireRefresh = false;
      response.writeHead(401);
      reply({ code: "invalid_token", message: "Expired fixture session" });
      return;
    }
    const known = this.tokens.get(request.headers.authorization ?? "");
    if (known == null) {
      response.writeHead(401);
      response.end(JSON.stringify({ code: "invalid_token", message: "Not signed in" }));
      return;
    }
    response.end(JSON.stringify(known));
    return;
  }

  /** @param {FixtureRequest} context */
  logout(context) {
    const { response } = context;

    this.counts.logout++;
    response.writeHead(204);
    response.end();
    return;
  }
}
/** @param {string} path @returns {string} Auth link purpose for a fixture route. */
function emailLinkType(path) {
  if (path.endsWith("recover")) return "recovery";
  return path.endsWith("resend") ? "signup" : "magiclink";
}
