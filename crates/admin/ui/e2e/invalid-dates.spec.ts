import { expect, test } from "@playwright/test";

import { requiredValue } from "../src/lib/contracts/required-value";
import { fixture } from "./fixtures";
import { usersFixture } from "./response-json";

test("an invalid user timestamp remains readable without breaking the page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await fixture(page);
  const users = await usersFixture(page);
  const first = requiredValue(users.users[0], "fixture user");
  first.created_at = "not-a-date";
  first.last_sign_in_at = null;
  await page.route("**/admin/api/users?*", (route) => route.fulfill({ json: users }));
  await page.goto("/admin/users");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Usuários");
  await expect(page.getByRole("cell", { name: "not-a-date", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
