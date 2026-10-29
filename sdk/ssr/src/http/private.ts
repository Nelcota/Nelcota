/** Responses carrying a session must never be cached or leak the URL as a referrer. */
export function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  headers.set("referrer-policy", "no-referrer");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  const vary = new Set(
    (headers.get("vary") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== ""),
  );
  vary.add("Cookie");
  headers.set("vary", [...vary].join(", "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
