"use client";

// Production hides server error details from the browser (only an opaque digest
// arrives), so session codes are mapped on the server: see lib/session-errors.ts,
// used by the sign-in Action and the account/profile pages. This boundary only
// covers whatever remains, with a generic message.
export default function Failure({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <p>Try again in a moment.</p>
      <button onClick={reset}>Try again</button>
    </main>
  );
}
