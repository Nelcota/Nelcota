import { expect, type Page, type Locator } from "@playwright/test";
/** Verifies that an empty catalog has no duplicate sidebar search. */
export async function emptyTableChrome(page: Page, locale: string) {
  const sidebar = page.getByRole("complementary", {
    name: locale === "pt-BR" ? "Lista de tabelas" : "Table list",
  });
  await expect(sidebar).toHaveCount(0);
  await expect(
    page.getByRole("searchbox", {
      name: locale === "pt-BR" ? "Buscar tabelas…" : "Search tables…",
    }),
  ).toHaveCount(0);
}
/** Keeps the same welcome and primary action visible across mobile widths. */
export async function welcomeWidths(page: Page, welcome: Locator) {
  for (const width of [320, 390, 768]) {
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await page.setViewportSize({ width, height: 900 });
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await expect(welcome).toBeVisible();
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await expect(welcome.getByRole("button")).toBeInViewport();
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
}

/** Opens the only primary action and verifies its localized dialog. */
export async function openEmptyTable(page: Page, welcome: Locator, locale: string) {
  await welcome
    .getByRole("button", { name: locale === "pt-BR" ? "Nova tabela" : "New table", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("heading", {
      name: locale === "pt-BR" ? "Nova tabela" : "New table",
      exact: true,
    }),
  ).toBeVisible();
}
