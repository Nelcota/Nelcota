import type { FetchLike } from "../../src/core/http/client.js";
import { requiredValue } from "../../src/core/required-value.js";

export interface Recorded {
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
}

function recordedBody(body: RequestInit["body"]): string | null {
  if (typeof body === "string") return body;
  return body == null ? null : "[binary]";
}

type Reply = Response | ((request: Recorded) => Response | Promise<Response>);

/** A fetch that records requests and answers from a queue (the last reply repeats). */
export function mockFetch(...replies: Reply[]): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const request: Recorded = {
      url: new URL(input instanceof Request ? input.url : input),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: recordedBody(init.body),
    };
    calls.push(request);
    if (init.signal?.aborted === true) throw init.signal.reason;
    const reply =
      replies.length > 1 ? requiredValue(replies.shift(), "required operation value") : replies[0];
    if (reply === undefined) throw new Error("no reply queued");
    const response = typeof reply === "function" ? await reply(request) : reply.clone();
    return response;
  };
  return { fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function empty(status = 204, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/** A session as the server returns it, expiring `inSeconds` from now. */
export function session(inSeconds = 900, refresh = "refresh-1", access = "access-1") {
  return {
    access_token: access,
    token_type: "bearer" as const,
    expires_in: 900,
    expires_at: Math.floor(Date.now() / 1000) + inSeconds,
    refresh_token: refresh,
    user: {
      id: "00000000-0000-0000-0000-000000000001",
      email: "ana@example.com",
      email_confirmed_at: null,
      user_metadata: {},
      created_at: "2026-01-01T00:00:00Z",
      last_sign_in_at: null,
    },
  };
}

/** An unsigned JWT with these claims (the client never verifies signatures). */
export function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "EdDSA", typ: "JWT" })}.${encode(claims)}.signature`;
}
