import type { Route } from "@playwright/test";

import { accessEndpoints } from "./access.js";
import { identityEndpoints } from "./identity.js";
import { migrationsEndpoints } from "./migrations.js";
import { overviewEndpoints } from "./overview.js";
import { storageEndpoints } from "./storage.js";
import { tablesEndpoints } from "./tables.js";
import type { FixtureRequest } from "./types.js";
const endpoints = [
  ...identityEndpoints,
  ...overviewEndpoints,
  ...tablesEndpoints,
  ...accessEndpoints,
  ...storageEndpoints,
  ...migrationsEndpoints,
];
export async function dispatchFixture(route: Route, request: FixtureRequest): Promise<void> {
  const endpoint = endpoints.find((candidate) => candidate.matches(request));
  if (endpoint !== undefined) {
    await route.fulfill(endpoint.respond(request));
    return;
  }
  const reply = (json: unknown) => route.fulfill({ status: 200, json });
  if (request.method !== "GET")
    return await reply({
      applied: false,
      catalog_pending: false,
      sql: ["-- Prévia fictícia para revisão da interface"],
      count: 1,
    });
  return await route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: "Mock endpoint not configured" }),
  });
}
