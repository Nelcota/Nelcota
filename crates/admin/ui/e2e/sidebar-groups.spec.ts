import { test, expect } from "@playwright/test";

import { fixture } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await fixture(page);
  await page.route("**/health", (r) => r.fulfill({ json: { status: "ok" } }));
  await page.route("**/admin/api/webhooks**", (r) =>
    r.fulfill({
      json: r.request().url().includes("/deliveries")
        ? { deliveries: [], next_cursor: null }
        : { endpoints: [], tables: ["notes"], allow_loopback: false, outstanding: 0, retained: 0 },
    }),
  );
});

test("database and users have nested links with one selected leaf and no duplicate tabs", async ({
  page,
}) => {
  const sidebar = page.locator(".panel-sidebar");
  await page.goto("/admin/sql");
  await expect(
    sidebar.getByRole("button", { name: "Banco de dados", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  // Tables is a group of its own inside Database: its first leaf lists every table.
  await sidebar.getByRole("button", { name: "Tabelas", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "Tabelas", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  for (const [label, path] of [
    ["Todas", "/tables"],
    ["Editor SQL", "/sql"],
    ["Migrações", "/migrations"],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await sidebar.getByRole("link", { name: label, exact: true }).click();
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await expect(page).toHaveURL(new RegExp(`/admin${path}$`));
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1);
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await expect(sidebar.getByRole("link", { name: label, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await expect(
      page.locator("main").getByRole("navigation", { name: "Seções do banco de dados" }),
    ).toHaveCount(0);
  }
  await sidebar.getByRole("button", { name: "Usuários", exact: true }).click();
  await sidebar.getByRole("link", { name: "Formas de entrar", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(
    sidebar.getByRole("link", { name: "Formas de entrar", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await sidebar.getByRole("link", { name: "Lista de usuários", exact: true }).click();
  await expect(page).toHaveURL(/\/users$/);
  await expect(page.locator("main .panel-segments")).toHaveCount(0);
});

test("policy filters are sidebar links that keep the search", async ({ page }) => {
  const sidebar = page.locator(".panel-sidebar");
  await page.goto("/admin/policies?q=notes");
  await expect(sidebar.getByRole("button", { name: "Acesso", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(sidebar.getByRole("link", { name: "Todas", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await sidebar.getByRole("link", { name: "Sem proteção", exact: true }).click();
  await expect(page).toHaveURL(/\/policies\?q=notes&filter=disabled$/);
  await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(sidebar.getByRole("link", { name: "Sem proteção", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator("main .panel-segments")).toHaveCount(0);
  await sidebar.getByRole("link", { name: "Todas", exact: true }).click();
  await expect(page).toHaveURL(/\/policies\?q=notes$/);
});

test("webhook history is selected for query filters and back navigation", async ({ page }) => {
  const sidebar = page.locator(".panel-sidebar");
  await page.goto("/admin/webhooks?tab=deliveries&status=failed");
  const history = sidebar.getByRole("link", { name: "Entregas", exact: true });
  await expect(history).toHaveAttribute("aria-current", "page");
  await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1);
  // The sidebar is the only navigation between the two views, as for every other group.
  await expect(page.locator("main .panel-segments")).toHaveCount(0);
  await sidebar.getByRole("link", { name: "Configuração", exact: true }).click();
  await expect(history).not.toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(history).toHaveAttribute("aria-current", "page");
});

test("API outline scrolls to the chosen section and preserves example settings", async ({
  page,
}) => {
  await page.goto("/admin/connect?lang=curl&topic=auth");
  const sidebar = page.locator(".panel-sidebar");
  const sdk = sidebar.locator('a[href*="section=api-sdk"]');
  await sdk.click();
  await expect(page).toHaveURL(/lang=curl&topic=auth&section=api-sdk/);
  await expect(sdk).toHaveAttribute("aria-current", "location");
  await expect
    .poll(() =>
      page.locator("#api-sdk").evaluate((e) => {
        // Browser callbacks cannot capture imports from the test runner.
        function requiredValue<T>(value: T, context: string): NonNullable<T> {
          if (value === null || value === undefined) throw new TypeError(`Missing ${context}`);
          return value;
        }

        const root = requiredValue(document.getElementById("conteudo"), "main content element");
        const rect = e.getBoundingClientRect(),
          bounds = root.getBoundingClientRect();
        return rect.top >= bounds.top - 1 && rect.top < bounds.bottom;
      }),
    )
    .toBe(true);
  const selectedTop = await page.locator("#api-sdk").evaluate((e) => e.getBoundingClientRect().top);
  await page.locator("#api-address").scrollIntoViewIfNeeded();
  await expect(sdk).not.toHaveAttribute("aria-current", "location");
  await sdk.click();
  await expect
    .poll(() =>
      page
        .locator("#api-sdk")
        .evaluate((e, top) => Math.abs(e.getBoundingClientRect().top - top), selectedTop),
    )
    .toBeLessThanOrEqual(1);
  await expect(page.locator("main .panel-segments-scroll")).toHaveCount(0);
  await page.locator("#api-examples").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "JavaScript", exact: true }).click();
  await expect(page).toHaveURL(/lang=js/);
  await expect.poll(() => page.locator("#api-examples").evaluate(examplesVisible)).toBe(true);
});

test("mobile groups support keyboard expansion, child selection and focus return", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  const menu = page.getByRole("dialog");
  const group = menu.getByRole("button", { name: "Banco de dados", exact: true });
  await group.focus();
  await page.keyboard.press("Enter");
  await expect(group).toHaveAttribute("aria-expanded", "true");
  await menu.getByRole("link", { name: "Editor SQL", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(page).toHaveURL(/\/sql$/);
  await expect
    .poll(() =>
      page.locator("main").evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(menu.getByRole("link", { name: "Editor SQL", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await menu.getByRole("button", { name: "Conectar", exact: true }).click();
  await menu.locator('a[href*="section=api-sdk"]').click();
  await expect(menu).toHaveCount(0);
  await expect(page).toHaveURL(/connect\?section=api-sdk/);
  await expect
    .poll(() =>
      page.locator("#api-sdk").evaluate((e) => {
        // Browser callbacks cannot capture imports from the test runner.
        function requiredValue<T>(value: T, context: string): NonNullable<T> {
          if (value === null || value === undefined) throw new TypeError(`Missing ${context}`);
          return value;
        }

        const root = requiredValue(document.getElementById("conteudo"), "main content element");
        return e.getBoundingClientRect().top < root.getBoundingClientRect().bottom;
      }),
    )
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("the shortcut rail shows on desktops and tablets", async ({ page }) => {
  await page.goto("/admin/");
  const rail = page.locator(".panel-rail");
  const sidebar = page.locator(".panel-sidebar");
  await expect(sidebar).toBeVisible();
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("link", { name: "Nelcota", exact: true })).toBeVisible();
  await expect(rail.getByRole("link", { name: "Projetos", exact: true })).toBeVisible();
  // Tablet: the sidebar collapses into the menu and the rail keeps the shortcuts.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(sidebar).toBeHidden();
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("link", { name: "Projetos", exact: true })).toBeVisible();
});

function examplesVisible(e: HTMLElement | SVGElement) {
  // Browser callbacks cannot capture imports from the test runner.
  function requiredValue<T>(value: T, context: string): NonNullable<T> {
    if (value === null || value === undefined) throw new TypeError(`Missing ${context}`);
    return value;
  }

  const root = requiredValue(document.getElementById("conteudo"), "main content element");
  const rect = e.getBoundingClientRect(),
    bounds = root.getBoundingClientRect();
  return rect.bottom > bounds.top && rect.top < bounds.bottom;
}
