// GET /notes forwards the caller's bearer token to Postgres RLS.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { createRestClient } from "@nelcota/client/rest";
const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
const PAGE_SIZE = 20;
const HTTP_BAD_GATEWAY = 502;
const HTTP_OK = 200;
const HTTP_SERVER_ERROR = 500;
const DEFAULT_PORT = 5179;

/** @param {string | undefined} apiUrl */
export function createExampleServer(apiUrl) {
  if (apiUrl == null || apiUrl === "") throw new Error("Set NELCOTA_URL");
  /** @param {import("node:http").IncomingMessage} request
   * @param {import("node:http").ServerResponse} response */
  const handleRequest = async (request, response) => {
    /** @param {number} status
     * @param {unknown} data */
    const json = (status, data) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (request.method !== "GET" || request.url !== "/notes")
      return json(HTTP_NOT_FOUND, { code: "not_found" });
    const match = request.headers.authorization?.match(/^Bearer ([^\s]+)$/i);
    if (match?.[1] === undefined) return json(HTTP_UNAUTHORIZED, { code: "session_missing" });
    const token = match[1];
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    try {
      const client = createRestClient(apiUrl, { accessToken: () => token });
      const { data, error } = await client
        .from("notes")
        .select("id,body")
        .order("id", { ascending: false })
        .limit(PAGE_SIZE)
        .abortSignal(controller.signal)
        .execute();
      if (error !== null)
        return json(error.status === 0 ? HTTP_BAD_GATEWAY : error.status, {
          code: error.code,
          message: error.message,
        });
      return json(HTTP_OK, data);
    } catch {
      return json(HTTP_SERVER_ERROR, { code: "server_error" });
    }
  };
  return createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      response.destroy(
        error instanceof Error ? error : new Error("Request handler failed", { cause: error }),
      );
    });
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createExampleServer(process.env.NELCOTA_URL).listen(
    Number(process.env.PORT ?? DEFAULT_PORT),
    "127.0.0.1",
    () => {
      console.log("GET http://127.0.0.1:5179/notes with Authorization: Bearer <user token>");
    },
  );
}
