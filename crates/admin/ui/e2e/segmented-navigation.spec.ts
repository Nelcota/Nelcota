import { test, expect, type Locator } from "@playwright/test";

import { fixture } from "./fixtures";

for (const theme of ["light", "dark"]) {
  test(`page and section navigation share one visual style in ${theme}`, async ({ page }, info) => {
    await page.addInitScript((value) => localStorage.setItem("mode-watcher-mode", value), theme);
    await fixture(page);
    await page.route("**/health", (route) => route.fulfill({ json: { status: "ok" } }));
    await page.route("**/admin/api/webhooks**", (route) =>
      route.fulfill({
        json: route.request().url().includes("/deliveries")
          ? { deliveries: [], next_cursor: null }
          : {
              endpoints: [],
              tables: ["notes"],
              allow_loopback: false,
              outstanding: 0,
              retained: 0,
            },
      }),
    );
    let baseline: unknown;
    for (const route of ["connect", ""]) {
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      await page.goto(`/admin/${route}`);
      const group = page.locator("main .panel-segments").first();
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      await expect(group).toBeVisible();
      const selected = group.locator(
        '[aria-current="page"], [aria-current="location"], [aria-pressed="true"]',
      );
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      await expect(selected).toHaveCount(1);
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      const style = await selectionStyle(selected);
      if (baseline !== undefined) expect(style).toEqual(baseline);
      if (Boolean(baseline) === false) baseline = style;
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      await group.screenshot({
        path: info.outputPath(`${route === "" ? "overview" : route}-${theme}.png`),
      });
      for (const width of [320, 390, 768, 1440]) {
        // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
        await page.setViewportSize({ width, height: 960 });
        // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
    }
  });
}

test("neutral selection keeps page links and local filters interactive", async ({ page }) => {
  await fixture(page);
  await page.route("**/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.goto("/admin/tables/notes");
  const views = page
    .locator("main nav.panel-segments")
    .filter({ has: page.getByRole("link", { name: "Dados", exact: true }) });
  await views.getByRole("link", { name: "Estrutura", exact: true }).click();
  await expect(page).toHaveURL(/\/tables\/notes\/structure/);
  await expect(page.getByRole("link", { name: "Estrutura", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.goto("/admin/");
  const filters = page
    .locator("main .panel-segments")
    .filter({ has: page.getByRole("button", { name: "Requisições", exact: true }) });
  await filters.getByRole("button", { name: "Requisições", exact: true }).click();
  await expect(filters.getByRole("button", { name: "Requisições", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(filters.getByRole("button", { name: "Tudo", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

async function selectionStyle(selected: Locator) {
  return await selected.evaluate((element) => {
    // Browser callbacks cannot capture imports from the test runner.
    function requiredValue<T>(value: T, context: string): NonNullable<T> {
      if (value === null || value === undefined) throw new TypeError(`Missing ${context}`);
      return value;
    }

    const item = getComputedStyle(element),
      parent = getComputedStyle(requiredValue(element.parentElement, "parent element"));
    return {
      height: element.getBoundingClientRect().height,
      radius: item.borderRadius,
      padding: item.padding,
      font: item.fontSize,
      background: item.backgroundColor,
      color: item.color,
      containerRadius: parent.borderRadius,
      containerPadding: parent.padding,
      gap: parent.gap,
    };
  });
}
