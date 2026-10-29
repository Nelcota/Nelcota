import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { user } from "./storage-redirect-fixtures.js";
export const listen = (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<[Server, string]> =>
  new Promise((resolve) => {
    const server = createServer(handler).listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve([
        server,
        `http://127.0.0.1:${typeof address === "object" && address != null ? address.port : 0}`,
      ]);
    });
  });

/** Produces signed-in API responses and then redirects object bytes to another origin. */
export function redirectBackend(
  objectOrigin: string,
  seen: Record<string, string | undefined>[],
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    if (request.url?.startsWith("/auth/v1/token") === true) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          access_token: "access-one",
          refresh_token: "refresh-one",
          token_type: "bearer",
          expires_in: 900,
          expires_at: Math.floor(Date.now() / 1000) + 900,
          user,
        }),
      );
      return;
    }
    if (request.url?.startsWith("/auth/v1/user") === true) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(user));
      return;
    }
    seen.push({ authorization: request.headers.authorization });
    response.writeHead(307, {
      location: `${objectOrigin}/bucket/report.pdf?X-Amz-Signature=fixture`,
    });
    response.end();
  };
}
