/** Read fixture JSON fields without inheriting JSON.parse's any return type. */
export function requestObject(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== "string") throw new TypeError("Expected a JSON request body");
  const value: unknown = JSON.parse(init.body);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected an object request body");
  return value as Record<string, unknown>;
}

export function requestUser(init: RequestInit): string {
  const email = requestObject(init).email;
  if (typeof email !== "string") throw new TypeError("Expected a fixture email");
  const [user = ""] = email.split("@");
  return user;
}
