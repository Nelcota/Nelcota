import { HTTP_STATUS } from "./http-status";
/** Shared transport error contract, independent of API requests and i18n. */
export class ApiError extends Error {
  public code: string | undefined;
  public params: Record<string, string | number> | undefined;
  constructor(
    message: string,
    public status: number,
    {
      code,
      params,
    }: { code?: string | undefined; params?: Record<string, string | number> | undefined } = {},
  ) {
    super(message);
    this.code = code;
    this.params = params;
    this.name = "ApiError";
  }
}

/**
 * Failure without a panel error body. Gateway statuses mean the server
 * behind a proxy is down or restarting; anything else is unexpected.
 */
export function httpError(status: number): ApiError {
  const code = [HTTP_STATUS.badGateway, HTTP_STATUS.unavailable, HTTP_STATUS.gatewayTimeout].some(
    (candidate) => candidate === status,
  )
    ? "server_unreachable"
    : "unexpected_response";
  return new ApiError(`HTTP ${status}`, status, { code: code, params: { status } });
}

/** Accepts only panel error fields whose runtime shapes match the transport contract. */
export function errorFromBody(status: number, value: unknown): ApiError {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return httpError(status);
  const body = value as Record<string, unknown>;
  const message = errorText(body["error"]);
  const code = errorText(body["code"]);
  if (message === undefined && code === undefined) return httpError(status);
  return new ApiError(message ?? `HTTP ${status}`, status, {
    code,
    params: errorParameters(body["params"]),
  });
}

function errorText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function errorParameters(value: unknown): Record<string, string | number> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const params = value as Record<string, unknown>;
  const valid = Object.values(params).every(
    (item) => typeof item === "string" || (typeof item === "number" && Number.isFinite(item)),
  );
  return valid ? (params as Record<string, string | number>) : undefined;
}
