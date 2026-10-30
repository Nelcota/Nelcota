import "server-only";
import { SessionError } from "@nelcota/nextjs/server";

/** Generic, safe failure classes. Never show causes, cookies, keys or backend messages. */
export type SessionFailure = "forbidden" | "unavailable";

/** Maps an adapter error to a generic failure (log the stable code only), or null. */
export function sessionFailure(error: unknown): SessionFailure | null {
  if (error instanceof SessionError === false) return null;
  console.error(`Session request failed: ${error.code}`);
  if (error.code === "csrf") return "forbidden"; // a 403-like refusal
  if (["session_store", "session_capacity"].includes(error.code)) return "unavailable"; // 503-like
  return null;
}

export const FAILURE_MESSAGES: Record<SessionFailure, string> = {
  forbidden: "This request was refused. Reload the page and try again.",
  unavailable: "The session service is temporarily unavailable. Try again shortly.",
};
