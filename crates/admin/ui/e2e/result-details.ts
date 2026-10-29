import type { Page, Route } from "@playwright/test";

import { assertCondition } from "./condition";

export async function verifyResultDetails(page: Page) {
  await page.goto("/admin/sql");
  const long = "Value with complete content\n" + "x".repeat(200);
  const sql = (route: Route) =>
    route.fulfill({
      json: {
        results_truncated: false,
        results: [{ columns: ["body"], rows: [[long]], count: 1, truncated: false }],
      },
    });
  await page.route("**/admin/api/sql", sql);
  await page.getByRole("button", { name: "Executar", exact: true }).click();
  await page.getByRole("button", { name: "Ver conteúdo completo", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assertCondition(
    (await page.getByRole("dialog").innerText()).includes(long),
    "Long SQL result must show full content",
  );
  await page.keyboard.press("Escape");
  await page.unroute("**/admin/api/sql", sql);
}
