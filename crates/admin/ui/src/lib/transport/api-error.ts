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
