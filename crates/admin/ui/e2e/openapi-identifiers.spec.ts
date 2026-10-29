import { expect, test } from "@playwright/test";

import { isOpenApiDocument, object } from "../src/lib/features/guides/openapi";
import { fixture } from "./fixtures";

test("OpenAPI presentation retains schema and property names inherited by plain objects", async ({
  page,
}) => {
  await fixture(page);
  const value: unknown = JSON.parse(
    '{"openapi":"3.0.3","info":{"title":"Fixture","version":"1"},"paths":{"/records":{"get":{"responses":{"200":{"description":"Rows"}}}}},"components":{"schemas":{"__proto__":{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"}}}}}}',
  );
  if (isOpenApiDocument(value) === false) throw new Error("Invalid OpenAPI fixture");
  const document = value;
  await page.route("**/rest/v1/", (route) => route.fulfill({ json: document }));
  // Observe the exact document delivered to the same-origin frame. Scalar
  // rendering is covered separately; this receiver isolates the transport.
  await page.route("**/admin/assets/reference.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><body><script>addEventListener("message",event=>{if(event.origin===location.origin&&event.data.type==="nelcota:openapi")document.body.textContent=JSON.stringify(event.data.document.components.schemas)})</script>',
    }),
  );
  await page.goto("/admin/guides/openapi");
  await expect(page.frameLocator("iframe").locator("body")).toHaveText(
    JSON.stringify(object(document.components).schemas),
  );
});
