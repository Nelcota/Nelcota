import { readFile } from "node:fs/promises";

import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";

import { fixture } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await fixture(page);
});

test("scrollable code samples expose a supported accessible name", async ({ page }) => {
  await page.goto("/admin/connect");
  await page.getByText("Apply only after reviewing the preview", { exact: true }).click();
  const blocks = page.locator('pre[tabindex="0"]');
  await expect(blocks.first()).toBeVisible();
  for (const block of await blocks.all()) {
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await expect(block).toHaveAttribute("role", "group");
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await expect(block).toHaveAccessibleName(/\S/);
  }
  await blocks.first().focus();
  await expect(blocks.first()).toBeFocused();
});

test("SDK and S3 help stay in the panel and repository links open the matching guide", async ({
  page,
  context,
}) => {
  await page.goto("/admin/connect");
  await page.getByRole("link", { name: "Documentação do SDK", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/guides\/sdk$/);
  await expect(
    page.getByRole("heading", { name: "SDK JavaScript e TypeScript", exact: true }),
  ).toBeVisible();
  await expect(page.locator('article a[href*="github.com"]')).toHaveCount(0);
  await page
    .locator("article")
    .getByRole("link", { name: "solução de problemas", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/guides\/troubleshooting$/);
  await expect(
    page.getByRole("heading", { name: "Resolver problemas", exact: true }),
  ).toBeVisible();

  await page.goto("/admin/storage");
  await page.locator("main details > summary").click();
  await page.getByRole("link", { name: "Como usar S3", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/guides\/storage\?section=turning-it-on$/);
  await expect(page.getByRole("heading", { name: "Como ativar", exact: true })).toBeInViewport();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Como ativar", exact: true })).toBeInViewport();
  await expect(page.locator("article")).toContainText("NELCOTA_STORAGE_S3_BUCKET");
  await page
    .getByRole("navigation", { name: "Neste guia", exact: true })
    .getByRole("link", { name: "Buckets e políticas", exact: true })
    .click();
  await expect(page).toHaveURL(/section=buckets-and-policies$/);
  await expect(
    page.getByRole("heading", { name: "Buckets e políticas", exact: true }),
  ).toBeInViewport();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Como ativar", exact: true })).toBeInViewport();
  expect(context.pages()).toHaveLength(1);
});

test("guide search finds configuration inside documents and clears without losing the selected guide", async ({
  page,
}) => {
  await page.goto("/admin/guides/sdk");
  const search = page.getByRole("searchbox", { name: "Buscar nos guias", exact: true });
  const nav = page.getByRole("navigation", { name: "Guias do Nelcota", exact: true });
  await search.fill("NELCOTA_STORAGE_S3_SECRET_ACCESS_KEY");
  await expect(nav.getByRole("link", { name: "Arquivos e S3", exact: true })).toBeVisible();
  await search.fill("caixa de entrada");
  await expect(nav.getByRole("link", { name: "Autenticação", exact: true })).toBeVisible();
  await search.fill("um-termo-sem-resultados");
  await expect(nav.getByText("Nenhum guia encontrado")).toBeVisible();
  await page.getByRole("button", { name: "Limpar busca", exact: true }).click();
  await expect(nav.getByRole("link", { name: "Autenticação", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/guides\/sdk$/);
});

const openapiDocument = {
  openapi: "3.0.3",
  info: { title: "Nelcota REST API", version: "0.3.0" },
  servers: [{ url: "/rest/v1" }],
  paths: {
    "/notes": {
      get: {
        parameters: [
          {
            name: "id",
            in: "query",
            schema: { type: "string" },
            description:
              "Filter: eq, neq, gt, gte, lt, lte, like, ilike, in, is (e.g. eq.value, in.(a,b), not.is.null)",
          },
        ],
        responses: { "200": { description: "Visible rows (RLS)" } },
      },
    },
  },
  components: {
    schemas: {
      notes: {
        type: "object",
        properties: {
          title: { type: "string", description: "Postgres type: text", example: "English example" },
        },
      },
    },
  },
};

test("Scalar renders an interactive OpenAPI reference and downloads the document without another tab", async ({
  page,
  context,
}) => {
  await page.route("**/rest/v1/", async (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    await route.fulfill({ json: openapiDocument });
  });
  await page.goto("/admin/connect");
  await page.getByRole("link", { name: "Documentação OpenAPI", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/guides\/openapi$/);
  const reference = page.frameLocator("iframe");
  await page.locator("iframe").scrollIntoViewIfNeeded();
  await reference.getByRole("button", { name: "Abrir Menu", exact: true }).click();
  await reference.locator('a[href="#GET/notes"]:visible').click();
  await expect(reference.locator("body")).toContainText("Filtro: eq, neq");
  await expect(reference.getByRole("button", { name: /Testar Requisição/i }).first()).toBeVisible();
  // The panel runs on a local URL, where Scalar would offer its hosted SDK sign-up.
  await expect(reference.getByRole("button", { name: /Gerar SDK/i })).toHaveCount(0);
  expect(
    await page.locator("main").evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Baixar OpenAPI" }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("openapi.json");
  expect(JSON.parse(await readFile(await download.path(), "utf8"))).toEqual(openapiDocument);
  await page.getByRole("button", { name: "Conta", exact: true }).click();
  await page.getByRole("menuitem", { name: /Idioma/ }).hover();
  await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(reference.locator("body")).toContainText("Filter: eq, neq");
  await expect(reference.getByRole("button", { name: /Test Request/i }).first()).toBeVisible();
  expect(context.pages()).toHaveLength(1);
});

test("changing the panel language translates prose and contents with identical code and stable section links", async ({
  page,
}) => {
  await page.goto("/admin/guides/storage?section=turning-it-on");
  await expect(page.getByRole("heading", { name: "Como ativar", exact: true })).toBeInViewport();
  await expect(page.locator('article [lang="pt-BR"]')).toContainText("Projetos novos");
  await expect(page.getByText("Referência em inglês", { exact: true })).toHaveCount(0);
  const code = await page.locator("article pre").allTextContents();
  await page.getByRole("button", { name: "Conta", exact: true }).click();
  await page.getByRole("menuitem", { name: /Idioma/ }).hover();
  await page.getByRole("menuitemradio", { name: "English", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Turning it on", exact: true })).toBeInViewport();
  await expect(page.locator('article [lang="en"]')).toContainText("New projects");
  expect(await page.locator("article pre").allTextContents()).toEqual(code);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Turning it on", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("menuitem", { name: /Language/ }).hover();
  await page.getByRole("menuitemradio", { name: "Português", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Como ativar", exact: true })).toBeInViewport();
  expect(await page.locator("article pre").allTextContents()).toEqual(code);
  await expect(page).toHaveURL(/section=turning-it-on$/);
});

test("OpenAPI can retry a failure and explains an empty anonymous catalog", async ({ page }) => {
  let fail = true;
  await page.route("**/rest/v1/", (route) =>
    fail
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: { openapi: "3.0.3", paths: {} } }),
  );
  await page.goto("/admin/guides/openapi");
  await expect(page.getByRole("alert")).toContainText("Não foi possível carregar");
  fail = false;
  await page.getByRole("button", { name: "Tentar de novo", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Nenhuma rota disponível")).toBeVisible();
  await expect(
    page.getByText("Confira as permissões das tabelas para anon na tela de acesso."),
  ).toBeVisible();
});

for (const locale of ["pt-BR", "en"]) {
  test(`guides remain usable at 320px and 1440px in ${locale}`, async ({ page }) => {
    await page.addInitScript((locale) => localStorage.setItem("nelcota.locale", locale), locale);
    await page.goto("/admin/guides/sdk");
    await expect(page.locator("article")).toContainText("createClient");
    for (const width of [1440, 1024, 768, 390, 320]) {
      // oxlint-disable-next-line no-await-in-loop -- Each browser probe depends on the previous interaction and cleanup completing.
      await verifyGuideWidth(page, locale, width);
    }
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    if (locale === "pt-BR") {
      await page.screenshot({ path: "/tmp/nelcota-guides-dark-320.png" });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: "/tmp/nelcota-guides-dark-1440.png" });
    }
  });
}

test("the command palette opens the API reference inside the panel", async ({ page }) => {
  await page.route("**/rest/v1/", (route) => route.fulfill({ json: openapiDocument }));
  await page.getByRole("button", { name: "Buscar (Ctrl K)" }).waitFor();
  await page.keyboard.press("Control+k");
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Buscar", exact: true })
    .fill("documentação api");
  await page.getByRole("option", { name: "Abrir documentação da API" }).click();
  await expect(page).toHaveURL(/\/admin\/guides\/openapi$/);
  await expect(page.getByText("OpenAPI 3.0.3", { exact: true })).toBeVisible();
});

async function verifyGuideWidth(page: Page, locale: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  if (width >= 1024)
    await expect(
      page.locator(".panel-sidebar").getByRole("link", {
        name: locale === "en" ? "Guides and references" : "Guias e referências",
      }),
    ).toBeVisible();
  if (width < 1024)
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page.locator("main").evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  if (width === 320) {
    await page
      .getByRole("combobox", {
        name: locale === "en" ? "Choose a guide" : "Escolher um guia",
        exact: true,
      })
      .click();

    await page
      .getByRole("option", {
        name: locale === "en" ? "Files and S3" : "Arquivos e S3",
        exact: true,
      })
      .click();

    await expect(page).toHaveURL(/\/admin\/guides\/storage$/);
  }

  if (locale === "pt-BR") await page.screenshot({ path: `/tmp/nelcota-guides-${width}.png` });
}
