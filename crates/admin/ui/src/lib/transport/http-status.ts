export const HTTP_STATUS = {
  noContent: 204,
  resetContent: 205,
  notModified: 304,
  clientErrorStart: 400,
  unauthorized: 401,
  badGateway: 502,
  unavailable: 503,
  gatewayTimeout: 504,
} as const;
