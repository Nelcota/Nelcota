import { createHmac, randomUUID } from "node:crypto";

import { createClient, memoryStorage, type NelcotaClient } from "../../src/index.js";
import type { Database } from "./generated/database.js";

export const URL_ = process.env["NELCOTA_SDK_TEST_URL"] ?? "";
export const MAIL = process.env["NELCOTA_SDK_TEST_MAIL"] ?? "";
const SECRET = process.env["NELCOTA_SDK_TEST_JWT_SECRET"] ?? "";

/** Contract tests only run under scripts/contract.ts. */
if (URL_.trim() === "") {
  throw new Error("Run the contract suite through scripts/contract.ts with its disposable backend");
}

export type Client = NelcotaClient<Database>;

export function visitor(): Client {
  return createClient<Database>(URL_, { auth: { storage: memoryStorage(), autoRefresh: false } });
}

/** A fresh account, signed in, with its own session storage (a "tab"). */
export async function signedIn(): Promise<{
  client: Client;
  email: string;
  password: string;
  id: string;
}> {
  const client = visitor();
  const email = `sdk-${randomUUID()}@example.com`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await client.auth.signUp({ email, password });
  if (error != null || data.session == null) throw new Error(`sign-up failed: ${error?.message}`);
  return { client, email, password, id: data.user.id };
}

/** A service_role token (HS256, the contract server's secret): bypasses RLS. */
export function serviceClient(): Client {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role: "service_role", iat: now, exp: now + 600 })}`;
  const token = `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
  return createClient<Database>(URL_, { accessToken: () => token });
}

interface MailSummary {
  ID: string;
  To: { Address: string }[];
}

async function messageLink(id: string, page: string): Promise<string | undefined> {
  const full = (await (await fetch(`${MAIL}/api/v1/message/${id}`)).json()) as { Text: string };
  return full.Text.split(/\s+/).find((word) => word.startsWith(page));
}

/** The link of the newest email to `address` that starts with `page`. */
export async function emailLink(address: string, page: string): Promise<string> {
  const delayInMs = 200;

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- Read the current mailbox result and honor its polling delay before another attempt.
    const list = (await (await fetch(`${MAIL}/api/v1/messages`)).json()) as {
      messages: MailSummary[];
    };
    const message = list.messages.find((m) => m.To.some((t) => t.Address === address));
    // oxlint-disable-next-line no-await-in-loop -- Read the current mailbox result and honor its polling delay before another attempt.
    const link = message == null ? undefined : await messageLink(message.ID, page);
    if (link != null && link !== "") return link;
    // oxlint-disable-next-line no-await-in-loop -- Read the current mailbox result and honor its polling delay before another attempt.
    await new Promise((r) => setTimeout(r, delayInMs));
  }
  throw new Error(`no email to ${address}`);
}
