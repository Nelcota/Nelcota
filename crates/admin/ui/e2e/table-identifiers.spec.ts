import { expect, test } from "@playwright/test";

import { requiredValue } from "../src/lib/contracts/required-value";
import { fixture } from "./fixtures";
import { rowPatch } from "./request-json";
import { tableFixture } from "./response-json";

test("row editing preserves special column names and custom types", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fixture(page);
  const data = await tableFixture(page);
  const text = requiredValue(data.table.columns[1], "text column");
  data.table.columns = [
    requiredValue(data.table.columns[0], "primary-key column"),
    { ...text, name: "__proto__" },
    {
      ...text,
      name: "status",
      type: "constructor",
      full_type: "constructor",
      enum_values: ["open", "closed"],
    },
  ];
  data.rows = [
    Object.fromEntries([
      ["id", "00000000-0000-4000-8000-000000000001"],
      ["__proto__", "before"],
      ["status", "open"],
    ]),
  ];
  data.total = 1;
  await page.route("**/admin/api/tables/notes?*", (route) => route.fulfill({ json: data }));
  let sent: { pk: Record<string, string>; values: Record<string, string | null> } | undefined;
  await page.route("**/admin/api/tables/notes/rows", async (route) => {
    sent = rowPatch(route.request());
    await route.fulfill({ json: { count: 1 } });
  });
  await page.goto("/admin/tables/notes");
  await expect(page.locator('[data-cell="0:1"]')).toHaveText("before");
  await page.getByRole("button", { name: "Expandir linha 1", exact: true }).click();
  await expect(page.locator("#f-__proto__")).toHaveValue("before");
  await expect(page.getByRole("button", { name: "Salvar", exact: true })).toBeDisabled();
  await page.locator("#f-__proto__").fill("after");
  await expect(page.getByRole("button", { name: "Salvar", exact: true })).toBeEnabled();
  await page.locator("#f-status").click();
  await page.getByRole("option", { name: "closed", exact: true }).click();
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(sent?.pk.id).toBe(requiredValue(data.rows[0], "original table row").id);
  expect(Object.hasOwn(sent?.values ?? {}, "__proto__")).toBe(true);
  expect(sent?.values).toEqual(JSON.parse('{"__proto__":"after","status":"closed"}'));
  expect(errors).toEqual([]);
});
