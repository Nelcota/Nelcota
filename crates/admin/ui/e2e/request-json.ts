import type { Request } from "@playwright/test";

/** Validate object payloads before a route fixture reads their fields. */
export function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && Array.isArray(value) === false) {
    return value as Record<string, unknown>;
  }
  throw new TypeError("Expected a JSON object in the browser fixture");
}

export function requestObject(request: Request): Record<string, unknown> {
  return jsonObject(request.postDataJSON());
}

export function jsonString(value: unknown): string {
  if (typeof value === "string") return value;
  throw new TypeError("Expected a string in the browser fixture");
}

/** Preserve the exact row-key and nullable-cell wire shapes used by table editing. */
export function rowPatch(request: Request): {
  pk: Record<string, string>;
  values: Record<string, string | null>;
} {
  const body = requestObject(request);
  return {
    pk: Object.fromEntries<string>(
      Object.entries(jsonObject(body.pk)).map(([key, value]) => [key, jsonString(value)]),
    ),
    values: Object.fromEntries<string | null>(
      Object.entries(jsonObject(body.values)).map(([key, value]) => [
        key,
        value === null ? null : jsonString(value),
      ]),
    ),
  };
}

export function updateRequest(
  body: Record<string, unknown>,
): Record<string, unknown> & { key: string; plan: string; password: string } {
  return {
    ...body,
    key: jsonString(body.key),
    plan: jsonString(body.plan),
    password: jsonString(body.password),
  };
}
