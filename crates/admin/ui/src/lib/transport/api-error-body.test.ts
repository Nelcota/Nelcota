import { expect, it } from "vitest";

import { ApiError, parseResponse } from "./api";

it.each([
  null,
  false,
  0,
  [],
  { error: 0, code: false },
  { error: false, code: 0 },
  { error: {}, code: [] },
])("uses the HTTP fallback for malformed error metadata: %j", async (body) => {
  await expect(
    parseResponse(Response.json(body, { status: 502 }), "/anything", { method: "GET" }),
  ).rejects.toMatchObject({
    name: "ApiError",
    status: 502,
    code: "server_unreachable",
    message: "HTTP 502",
  });
});

it.each([[], "unexpected", { project: {} }, { count: null }])(
  "discards invalid interpolation parameters: %j",
  async (params) => {
    const response = Response.json(
      { error: "Missing project", code: "project_missing", params },
      {
        status: 404,
      },
    );
    await expect(parseResponse(response, "/anything", { method: "GET" })).rejects.toMatchObject({
      message: "Missing project",
      code: "project_missing",
      params: undefined,
    });
  },
);

it("rejects interpolation numbers that overflow during JSON decoding", async () => {
  const response = new Response('{"code":"project_missing","params":{"count":1e400}}', {
    status: 404,
  });
  await expect(parseResponse(response, "/anything", { method: "GET" })).rejects.toMatchObject({
    code: "project_missing",
    params: undefined,
  });
});

it.each([
  { error: "Missing project", code: 42, params: [] },
  { error: {}, code: "project_missing", params: { project: "notes", count: 3 } },
  { error: "Missing project", code: "project_missing", params: { project: "notes", count: 3 } },
])("preserves valid fields independently of malformed optional metadata: %j", async (body) => {
  const pending = parseResponse(Response.json(body, { status: 404 }), "/anything", {
    method: "GET",
  });
  await expect(pending).rejects.toBeInstanceOf(ApiError);
  await expect(pending).rejects.toMatchObject({
    message: typeof body.error === "string" ? body.error : "HTTP 404",
    code: typeof body.code === "string" ? body.code : undefined,
    params: Array.isArray(body.params) ? undefined : body.params,
  });
});
