import { test, expect } from "@playwright/test";

import { emptyTableChrome, welcomeWidths, openEmptyTable } from "./empty-table-checks";
import { fixture } from "./fixtures";
import { TableHomeProbe } from "./table-home-probe";

for (const locale of ["pt-BR", "en"]) {
  test(`empty tables have one welcome and a working primary action in ${locale}`, async ({
    page,
  }, info) => {
    await page.addInitScript((value) => {
      localStorage.setItem("nelcota.locale", value);
      localStorage.setItem("mode-watcher-mode", "dark");
    }, locale);
    await fixture(page);
    await page.route("**/health", (route) => route.fulfill({ json: { status: "ok" } }));
    await page.route("**/admin/api/tables", (route) =>
      route.fulfill({ json: { schema: "public", tables: [] } }),
    );
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/admin/tables");
    const title = locale === "pt-BR" ? "Crie sua primeira tabela" : "Create your first table";
    const welcome = page.getByRole("region", { name: title, exact: true });
    await expect(welcome).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      locale === "pt-BR" ? "Tabelas" : "Tables",
    );
    await emptyTableChrome(page, locale);
    await expect(
      page.getByRole("link", { name: locale === "pt-BR" ? "Guia de tabelas" : "Tables guide" }),
    ).toHaveAttribute("href", "/admin/guides/panel");
    await expect(
      page.getByRole("button", {
        name: locale === "pt-BR" ? "Nova tabela" : "New table",
        exact: true,
      }),
    ).toHaveCount(1);
    await page.screenshot({
      path: info.outputPath(`empty-tables-${locale}-desktop.png`),
      fullPage: true,
    });
    await welcomeWidths(page, welcome);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: info.outputPath(`empty-tables-${locale}-mobile.png`),
      fullPage: true,
    });
    await openEmptyTable(page, welcome, locale);
  });
}

test("a failed catalog request cannot appear as an empty project", async ({ page }) => {
  await fixture(page);
  let failed = true;
  await page.route("**/admin/api/tables", (route) =>
    route.fulfill(
      failed
        ? { status: 503, json: { error: "Temporarily unavailable" } }
        : { json: { schema: "public", tables: [] } },
    ),
  );
  await page.goto("/admin/tables");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Crie sua primeira tabela", exact: true }),
  ).toHaveCount(0);
  failed = false;
  await page.getByRole("button", { name: "Tentar de novo", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Crie sua primeira tabela", exact: true }),
  ).toBeVisible();
});

test("the tables home search and the sidebar search keep their clear actions", async ({ page }) => {
  await fixture(page);
  await page.goto("/admin/tables");
  // The home lists every table itself: no second list beside it.
  await expect(page.getByRole("complementary", { name: "Lista de tabelas" })).toHaveCount(0);
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "notes", exact: true })).toBeVisible();
  await page.keyboard.press("/");
  await expect(main.getByRole("searchbox", { name: "Buscar tabelas…" })).toBeFocused();
  await page.keyboard.type("no-such-table");
  await expect(main.getByText("Nenhuma tabela encontrada.")).toBeVisible();
  await main.getByRole("button", { name: "Limpar busca", exact: true }).click();
  await expect(main.getByRole("link", { name: "notes", exact: true })).toBeVisible();
  // With a table open, the sidebar list returns with its own search.
  await page.goto("/admin/tables/notes");
  const sidebar = page.getByRole("complementary", { name: "Lista de tabelas" });
  await sidebar.getByRole("searchbox").fill("no-such-table");
  await expect(sidebar.locator('a[href="/admin/tables/notes"]')).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Limpar busca", exact: true }).first().click();
  await expect(sidebar.locator('a[href="/admin/tables/notes"]')).toBeVisible();
});

test("the tables home lists, filters, orders and fixes tables", async ({ page }) => {
  const probe = new TableHomeProbe(page);
  await probe.mount();
  await probe.content();
  await probe.ordering();
  await probe.filters();
  await probe.protection();
  await probe.menus();
  await probe.widths();
});
