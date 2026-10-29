import type { Page } from "@playwright/test";

import type { TableData, UsersResponse } from "../src/lib/generated/contracts";
import {
  TableData as validateTableData,
  UsersResponse as validateUsersResponse,
} from "../src/lib/generated/validators.js";

/** Fetch inside the browser so page.route fixtures and browser cookies still apply. */
async function browserJson(page: Page, path: string): Promise<unknown> {
  return await page.evaluate(async (url) => {
    const response = await fetch(url);
    const value: unknown = await response.json();
    return value;
  }, path);
}

export async function tableFixture(page: Page): Promise<TableData> {
  const value = await browserJson(page, "/admin/api/tables/notes");
  if (validateTableData(value) === false)
    throw new TypeError("Invalid table response in browser fixture");
  return value as TableData;
}

export async function usersFixture(page: Page): Promise<UsersResponse> {
  const value = await browserJson(page, "/admin/api/users");
  if (validateUsersResponse(value) === false)
    throw new TypeError("Invalid users response in browser fixture");
  return value as UsersResponse;
}
