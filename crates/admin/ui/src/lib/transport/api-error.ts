/** Shared transport error contract, independent of API requests and i18n. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public params?: Record<string, string | number>,
  ) {
    super(message)
  }
}

/**
 * Failure without a panel error body. Gateway statuses mean the server
 * behind a proxy is down or restarting; anything else is unexpected.
 */
export function httpError(status: number): ApiError {
  const code = [502, 503, 504].includes(status) ? 'server_unreachable' : 'unexpected_response'
  return new ApiError(`HTTP ${status}`, status, code, { status })
}
