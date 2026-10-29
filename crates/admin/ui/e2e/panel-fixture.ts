import { test as base, expect, type Locator, type Page } from "@playwright/test";

import { fixture } from "./fixtures";
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      if (Boolean(localStorage.getItem("nelcota.locale")) === false)
        localStorage.setItem("nelcota.locale", "en");
    });
    await fixture(page);
    await page.route("**/health", (route) => route.fulfill({ json: { status: "ok" } }));

    await use(page);
  },
});
export async function openUser(page: Page) {
  await page.goto("/admin/users");
  await page.getByRole("button", { name: "New user", exact: true }).first().click();
  await expect(page.locator("#new-user-email")).toBeVisible();
}
export async function fits(element: Locator) {
  await expect
    .poll(() => element.evaluate((e) => e.scrollWidth - e.clientWidth))
    .toBeLessThanOrEqual(1);
}
export async function visibleHitTarget(element: Locator) {
  await expect(element).toBeInViewport({ ratio: 1 });
  expect(
    await element.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return [0.2, 0.5, 0.8].every((x) =>
        [0.2, 0.5, 0.8].every((y) => {
          const hit = document.elementFromPoint(r.x + r.width * x, r.y + r.height * y);
          return hit !== null && (hit === e || e.contains(hit));
        }),
      );
    }),
  ).toBe(true);
}
