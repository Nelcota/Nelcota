import { test, expect, type Page } from "@playwright/test";

import { fixture } from "./fixtures";

test("owner views warn and explain invoker privileges without offering table policies", async ({
  page,
}) => {
  await fixture(page);
  await ownerOverview(page);
  await page.route("**/admin/api/policies", (route) =>
    route.fulfill({
      json: {
        schema: "public",
        exposed_without_rls: ["owner_todos"],
        anon_functions: [],
        tables: [{ name: "todos", rls: protectedRls, exposed_without_rls: false, policies: [] }],
      },
    }),
  );
  await page.goto("/admin/");
  await expect(page.getByText("Acesso sem proteção por usuário em owner_todos")).toBeVisible();
  await page.goto("/admin/policies");
  // The owner view is listed with the fix next to it: a review in the SQL editor, never a table rule.
  const attention = page.getByRole("region", { name: "1 item precisa de atenção" });
  await expect(attention.getByText("owner_todos", { exact: true })).toBeVisible();
  await expect(attention.getByText(/configure security_invoker = true/)).toBeVisible();
  await expect(
    attention.getByRole("link", { name: "Abrir editor SQL", exact: true }),
  ).toHaveAttribute("href", "/admin/sql");
  await expect(page.getByRole("button", { name: "Nova regra", exact: true })).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "Ativar proteção por linha (RLS)", exact: true }),
  ).toHaveCount(0);
  // Filtering by attention keeps the item and does not claim everything is fine.
  await page.locator(".panel-sidebar").getByRole("link", { name: "Atenção", exact: true }).click();
  await expect(attention).toBeVisible();
  await expect(page.getByText("Nada precisa de atenção")).toHaveCount(0);
});

test("problems come first with their fix, and the rule sheet fits on one screen", async ({
  page,
}) => {
  await fixture(page);
  await policyProblems(page);
  await page.goto("/admin/policies");
  const main = page.getByRole("main");
  await expect(main.getByText("2 de 3 tabelas protegidas", { exact: true })).toBeVisible();
  const attention = main.getByRole("region", { name: "2 itens precisam de atenção" });
  await expect(attention.getByRole("listitem")).toHaveCount(2);
  await expect(attention.getByRole("listitem").first()).toContainText("orders");
  // The most urgent tables lead the list.
  await expect(
    main.getByRole("region", { name: "Tabelas" }).getByRole("heading", { level: 3 }),
  ).toHaveText(["orders", "profiles", "notes"]);

  // Turning protection on for a table without rules still asks first.
  await attention
    .getByRole("button", { name: "Ativar proteção por linha (RLS)", exact: true })
    .click();
  await expect(
    page.getByRole("alertdialog", { name: "Ativar a proteção de orders?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();

  // "Create rule" opens the sheet for that table with every option in view.
  await attention.getByRole("button", { name: "Criar regra", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Criar regra de acesso" });
  await expect(sheet).toContainText("na tabela profiles");
  await expect(sheet.getByRole("radio")).toHaveCount(5);
  await expect(sheet.getByRole("button", { name: "Continuar" })).toHaveCount(0);
  await sheet.getByText("Qualquer pessoa, mesmo sem login", { exact: true }).click();
  await expect(sheet.getByRole("radio", { name: "Ver, criar, editar e apagar" })).toBeDisabled();
  await expect(sheet.getByRole("region", { name: "Como vai ficar" })).toContainText(
    "Qualquer pessoa poderá ver todos os registros",
  );
  // An invalid name opens the folded name field and points at it.
  await sheet.getByText("Nome e SQL da regra").click();
  await sheet.getByLabel("Nome da regra").fill("");
  await sheet.getByText("Nome e SQL da regra").click();
  await sheet.getByRole("button", { name: "Criar regra de acesso", exact: true }).click();
  await expect(sheet.getByLabel("Nome da regra")).toBeFocused();
});

const protectedRls = {
  state: "ok",
  label: "RLS · 1 policies",
  enabled: true,
  forced: false,
  policies: 1,
};
const ownerRls = {
  state: "danger",
  label: "view owner privileges",
  enabled: false,
  forced: false,
  policies: 0,
};
const grants = { anon: ["SELECT"], authenticated: ["SELECT"] };

async function ownerOverview(page: Page) {
  await page.route("**/admin/api/overview", (route) =>
    route.fulfill({
      json: {
        schema: "public",
        counts: { tables: 1, users: 0, signed_in_users: 0, policies: 1, functions: 0 },
        exposed_without_rls: ["owner_todos"],
        tables: [
          {
            name: "todos",
            kind: "table",
            comment: null,
            rows: 2,
            rows_exact: true,
            rls: protectedRls,
            grants,
          },
          {
            name: "owner_todos",
            kind: "view",
            comment: null,
            rows: null,
            rows_exact: false,
            rls: ownerRls,
            grants,
          },
        ],
      },
    }),
  );
}

const rule = {
  name: "owner_access",
  permissive: true,
  roles: ["authenticated"],
  command: "ALL",
  using: "owner = auth.uid()",
  check: "owner = auth.uid()",
};

async function policyProblems(page: Page) {
  await page.route("**/admin/api/policies", (route) =>
    route.fulfill({
      json: {
        schema: "public",
        exposed_without_rls: ["orders"],
        anon_functions: [],
        tables: [
          {
            name: "notes",
            exposed_without_rls: false,
            rls: { state: "ok", label: "RLS", enabled: true, forced: false, policies: 1 },
            policies: [rule],
          },
          {
            name: "profiles",
            exposed_without_rls: false,
            rls: { state: "warn", label: "RLS", enabled: true, forced: false, policies: 0 },
            policies: [],
          },
          {
            name: "orders",
            exposed_without_rls: true,
            rls: {
              state: "danger",
              label: "RLS disabled",
              enabled: false,
              forced: false,
              policies: 0,
            },
            policies: [],
          },
        ],
      },
    }),
  );
}
