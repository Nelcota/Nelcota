export const HTTP_STATUS = {
  movedPermanently: 301,
  found: 302,
  seeOther: 303,
  temporaryRedirect: 307,
  permanentRedirect: 308,
  unauthorized: 401,
  notFound: 404,
} as const;

export function isRedirect(status: number): boolean {
  return [
    HTTP_STATUS.movedPermanently,
    HTTP_STATUS.found,
    HTTP_STATUS.seeOther,
    HTTP_STATUS.temporaryRedirect,
    HTTP_STATUS.permanentRedirect,
  ].some((candidate) => candidate === status);
}
