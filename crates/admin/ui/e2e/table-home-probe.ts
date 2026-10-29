import { expect, type Page } from "@playwright/test";

import { fixture } from "./fixtures";
import { requestObject } from "./request-json";
const tableRls = (state: string, policies = 0) => ({
  state,
  label: state,
  enabled: state === "ok" || state === "warn",
  forced: false,
  policies,
});

/** Verifies table-home behavior against one mutable RLS fixture. */
export class TableHomeProbe {
  private openDataState = "danger";
  private altered: unknown = null;
  constructor(private readonly page: Page) {}
  private get main() {
    return this.page.getByRole("main");
  }
  private get list() {
    return this.main.getByRole("table", { name: "Tabelas" });
  }
  private row(name: string) {
    return this.main
      .getByRole("row")
      .filter({ has: this.page.getByRole("link", { name, exact: true }) });
  }
  private async names() {
    return await this.main.locator('table tbody a[href^="/admin/tables/"]').allTextContents();
  }
  private tables() {
    return [
      { name: "notes", kind: "table", has_pk: true, rls: tableRls("ok", 2) },
      { name: "open_data", kind: "table", has_pk: true, rls: tableRls(this.openDataState, 1) },
      { name: "balances", kind: "view", has_pk: false, rls: tableRls("view") },
    ];
  }
  private overview() {
    return {
      schema: "public",
      counts: { tables: 3, users: 0, signed_in_users: 0, policies: 3, functions: 0 },
      exposed_without_rls: this.openDataState === "danger" ? ["open_data"] : [],
      tables: [
        {
          ...this.tables()[0],
          comment: "Notas de cada usuário",
          rows: 1234,
          rows_exact: true,
          grants: { anon: [], authenticated: ["SELECT", "INSERT", "UPDATE", "DELETE"] },
        },
        {
          ...this.tables()[1],
          comment: null,
          rows: 5,
          rows_exact: true,
          grants: { anon: ["SELECT"], authenticated: ["SELECT"] },
        },
        {
          ...this.tables()[2],
          comment: null,
          rows: null,
          rows_exact: false,
          grants: { anon: [], authenticated: ["SELECT"] },
        },
      ],
    };
  }
  async mount() {
    const { page } = this;
    await fixture(page);
    await page.addInitScript(() => localStorage.setItem("nelcota:tables-last", "notes"));
    await page.route("**/admin/api/tables", (route) =>
      route.fulfill({ json: { schema: "public", tables: this.tables() } }),
    );
    await page.route("**/admin/api/tables/open_data", async (route) => {
      if (route.request().method() !== "PATCH") return await route.fallback();
      this.altered = requestObject(route.request());
      this.openDataState = "ok";
      await route.fulfill({ json: { sql: [], applied: true, catalog_pending: false } });
    });
    await page.route("**/admin/api/schema", (route) =>
      route.fulfill({
        json: {
          schema: "public",
          tables: {
            notes: ["id", "title", "owner"],
            open_data: ["id"],
            balances: ["org", "total"],
          },
        },
      }),
    );
    await page.route("**/admin/api/overview", (route) => route.fulfill({ json: this.overview() }));
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/admin/tables");
  }
  async content() {
    const { main } = this;
    const row = (name: string) => this.row(name);
    await expect(main.getByRole("heading", { level: 1 })).toContainText("Tabelas");
    await expect(row("notes")).toContainText("3 colunas");
    await expect(row("notes")).toContainText("1.234 linhas");
    await expect(row("notes")).toContainText("Notas de cada usuário");
    await expect(row("notes")).toContainText("Usuários logados: Leitura e escrita");
    await expect(row("open_data")).toContainText("Visitantes: Só leitura");
    await expect(row("open_data")).not.toContainText("Usuários logados");
    await expect(row("balances")).toContainText("Somente leitura");
    // The previously opened table is offered again, migrated from the old single entry.
    await expect(
      main.getByRole("navigation", { name: "Recentes" }).getByRole("link", { name: "notes" }),
    ).toBeVisible();
  }
  async ordering() {
    const { list } = this;
    // Views come after the tables; rows sort largest first.
    expect(await this.names()).toEqual(["notes", "open_data", "balances"]);
    await list.getByRole("button", { name: "Linhas" }).click();
    expect(await this.names()).toEqual(["notes", "open_data", "balances"]);
    await list.getByRole("button", { name: "Linhas" }).click();
    expect(await this.names()).toEqual(["open_data", "notes", "balances"]);
  }
  async filters() {
    const { page, main } = this;
    // The filters are sub-items of Tables in the sidebar, kept in the URL.
    const sidebar = page.locator(".panel-sidebar");
    await expect(main.locator(".panel-segments")).toHaveCount(0);
    const tablesGroup = sidebar.getByRole("button", { name: "Tabelas", exact: true });
    await expect(tablesGroup).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar.getByRole("link", { name: "Todas", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await sidebar.getByRole("link", { name: "Atenção", exact: true }).click();
    await expect(page).toHaveURL(/\/tables\?filter=attention$/);
    await expect(sidebar.locator('[aria-current="page"]')).toHaveText("Atenção");
    expect(await this.names()).toEqual(["open_data"]);
    await sidebar.getByRole("link", { name: "Views", exact: true }).click();
    expect(await this.names()).toEqual(["balances"]);
    await sidebar.getByRole("link", { name: "Todas", exact: true }).click();
    await expect(page).toHaveURL(/\/tables$/);
    // The group folds like every other one.
    await tablesGroup.click();
    await expect(tablesGroup).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar.getByRole("link", { name: "Views", exact: true })).toBeHidden();
  }
  async protection() {
    const { main } = this;
    const row = (name: string) => this.row(name);
    // The attention panel turns protection on in place (with rules, no confirmation).
    const attention = main.getByRole("region", { name: "1 tabela precisa de atenção" });
    await attention.getByRole("button", { name: "Ativar proteção por linha (RLS)" }).click();
    await expect
      .poll(() => this.altered)
      .toEqual({ actions: [{ action: "set_rls", enabled: true }], preview: false });
    await expect(attention).toHaveCount(0);
    await expect(row("open_data")).toContainText("Protegida");
  }
  async menus() {
    const { page } = this;
    const row = (name: string) => this.row(name);
    // Each row's menu reaches the table's other tools.
    await row("notes").getByRole("button", { name: "Ações de notes" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Exportar CSV" })).toHaveAttribute(
      "href",
      "/admin/api/tables/notes/export?format=csv",
    );
    await expect(menu.getByRole("menuitem", { name: "Regras de acesso" })).toHaveAttribute(
      "href",
      "/admin/policies?table=notes",
    );
    await menu.getByRole("menuitem", { name: "Consultar no SQL" }).click();
    await expect(page).toHaveURL(/\/admin\/sql$/);

    await page.goto("/admin/tables");
    await row("balances").getByRole("button", { name: "Ações de balances" }).click();
    await expect(page.getByRole("menuitem", { name: "Apagar…" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Clicking anywhere on a row opens the table.
    await row("open_data").getByRole("cell").nth(2).click();
    await expect(page).toHaveURL(/\/admin\/tables\/open_data$/);
  }
  async widths() {
    const { page, main, list } = this;
    const row = (name: string) => this.row(name);
    await page.goto("/admin/tables");
    for (const width of [1600, 1280, 390]) {
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      await page.setViewportSize({ width, height: 844 });
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      const name = await list.getByRole("link", { name: "open_data", exact: true }).boundingBox();
      // Views share the tables' columns at every width.
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      const tableCell = await row("notes").getByRole("cell").last().boundingBox();
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      const viewCell = await row("balances").getByRole("cell").last().boundingBox();
      expect(viewCell?.x).toBe(tableCell?.x);
      expect(name?.width ?? 0).toBeGreaterThan(60);
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await expect(main.getByRole("button", { name: "Nova tabela", exact: true })).toBeVisible();
  }
}
