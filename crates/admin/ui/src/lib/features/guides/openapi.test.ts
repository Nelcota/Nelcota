import { marked } from "marked";
import { expect, it } from "vitest";

import prose from "../../../../../../../docs/i18n/pt-BR/openapi.json";
import { requiredValue } from "../../contracts/required-value.js";
import { isOpenApiDocument, text, object, operations, type OpenApiDocument } from "./openapi";
import { translateOpenApi } from "./openapi-prose";

it("renders generated JWT placeholders and wildcard examples literally in both languages", () => {
  const description = requiredValue(
    Object.keys(prose).find((value) => value.startsWith("API generated")),
    "guide content",
  );
  const columns = requiredValue(
    Object.keys(prose).find((value) => value.startsWith("Columns:")),
    "guide content",
  );
  for (const locale of ["en", "pt-BR"]) {
    const source: OpenApiDocument = {
      openapi: "3.0.3",
      info: { description },
      security: [{}, { bearer: [] }],
      paths: { "/notes": { get: { parameters: [{ name: "select", description: columns }] } } },
    };
    const translated = translateOpenApi(source, locale);
    const parameters = requiredValue(operations(translated)[0], "test fixture item").operation
      .parameters;
    const select = object(Array.isArray(parameters) ? parameters[0] : null);
    const html = marked.parse(
      `${text(object(translated.info).description)}\n\n${text(select.description)}`,
    ) as string;
    expect(html).toContain("<code>Authorization: Bearer &lt;jwt&gt;</code>");
    expect(html).toContain("<code>*</code>");
    expect(html).toContain("<code>items(*)</code>");
    expect(html).toContain("<code>orders(id,items(*))</code>");
    expect(html).not.toContain("<em>");
    expect(translated.security).toEqual([{}, { bearer: [] }]);
  }
});

it("rejects non-OpenAPI responses and invalid paths", () => {
  for (const value of [
    null,
    "<html>",
    {},
    { openapi: "2.0", paths: {} },
    { openapi: "3.0.3", paths: [] },
    { openapi: "3.0.3", paths: { "/notes": null } },
  ])
    expect(isOpenApiDocument(value)).toBe(false);
});

it("translates generated prose while preserving schemas, examples, custom comments and the original download", () => {
  const source = customDocument();
  const original = JSON.stringify(source);
  const translated = translateOpenApi(source, "pt-BR");
  expect(translated.info).toEqual({ title: "API REST do Nelcota" });
  expect(JSON.stringify(translated)).toContain(
    "Grupo de filtros combinados com OR: (or=(col.op.value,...))",
  );
  expect(JSON.stringify(translated)).toContain("Linhas visíveis (RLS)");
  expect(JSON.stringify(translated)).toContain(
    "User-authored column comment\\n\\nTipo Postgres: text",
  );
  expect(JSON.stringify(translated)).toContain("User-authored table comment");
  expect(JSON.stringify(translated)).toContain("User-authored function comment");
  expect(JSON.stringify(translated)).toContain("English example");
  expect(JSON.stringify(translated)).toContain("English default");
  expect(JSON.stringify(source)).toBe(original);
  expect(translateOpenApi(source, "en")).toBe(source);
});

it("lists HTTP operations, ignoring path metadata, and accepts an empty catalog", () => {
  const doc = {
    openapi: "3.0.3",
    paths: {
      "/notes": {
        get: { responses: {} },
        post: { requestBody: {} },
        description: "Notes",
        parameters: [],
      },
    },
  };
  expect(isOpenApiDocument(doc)).toBe(true);
  expect(operations(doc).map(({ path, method }) => ({ path, method }))).toEqual([
    { path: "/notes", method: "GET" },
    { path: "/notes", method: "POST" },
  ]);
  expect(isOpenApiDocument({ openapi: "3.0.3", paths: {} })).toBe(true);
});

function customDocument() {
  return {
    openapi: "3.0.3",
    info: { title: "Nelcota REST API" },
    paths: {
      "/notes": {
        get: {
          parameters: [
            {
              name: "or",
              in: "query",
              description:
                "Group of filters joined with OR: (or=(col.op.value,...)); nests with and(...)/or(...), negate with not.or",
              example: "or=(id.eq.1,id.eq.2)",
            },
          ],
          responses: { "200": { description: "Visible rows (RLS)" } },
        },
      },
      "/rpc/f": {
        post: {
          description: "User-authored function comment",
          responses: { "200": { description: "Result" } },
        },
      },
    },
    components: {
      schemas: {
        notes: {
          description: "User-authored table comment",
          properties: {
            title: {
              description: "User-authored column comment\n\nPostgres type: text",
              type: "string",
              default: "English default",
              example: "English example",
            },
          },
        },
      },
    },
  };
}
