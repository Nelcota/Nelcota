"use client";
import { refreshSession } from "@nelcota/nextjs/browser";
import { useState } from "react";

/** `next` was validated on the server with safeReturnTo; the login hop keeps it. */
export function Continue({ next }: { next: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function renew() {
    setPending(true);
    setError("");
    try {
      const response = await refreshSession();
      if (Boolean(response.ok) === false) {
        window.location.assign(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      window.location.assign(next);
    } catch {
      setError("Could not renew the session. Try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <button
        disabled={pending}
        onClick={() => {
          void renew();
        }}
      >
        {pending ? "Renewing…" : "Continue"}
      </button>
      <p role="status">{error}</p>
    </>
  );
}
