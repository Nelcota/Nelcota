import { test, expect, type Page, type Route } from "@playwright/test";

import type {
  ProjectSetting,
  ProjectSettingsView,
} from "../src/lib/features/server/project-settings";
import { base, digest, host, id, mount } from "./host-fixture";
import { jsonObject, requestObject } from "./request-json";

function setting(overrides: Partial<ProjectSetting> = {}): ProjectSetting {
  return {
    key: "jwt_expiry_secs",
    group: "authentication",
    kind: "integer",
    nullable: false,
    minimum: 60,
    maximum: 86400,
    dependencies: [],
    default_value: 900,
    saved_value: 900,
    expected_value: 900,
    runtime_value: 900,
    pending_restart: false,
    source: "default",
    ...overrides,
  };
}
const snapshot: ProjectSettingsView = {
  revision: "d".repeat(64),
  runtime_status: "effective",
  blocked: null,
  settings: [
    setting({
      key: "signup_enabled",
      kind: "boolean",
      minimum: 0,
      maximum: 1,
      default_value: true,
      saved_value: true,
      expected_value: true,
      runtime_value: true,
    }),
    setting(),
    setting({
      key: "cors_allow_origins",
      kind: "origins",
      group: "api",
      nullable: true,
      minimum: 0,
      maximum: 32,
      default_value: null,
      saved_value: null,
      expected_value: null,
      runtime_value: null,
    }),
    setting({
      key: "storage_max_file_size",
      group: "storage",
      minimum: 1,
      maximum: 1073741824,
      default_value: 1048576,
      saved_value: 1048576,
      expected_value: 1048576,
      runtime_value: 1048576,
    }),
  ],
};

function configurationData(projected: ProjectSettingsView) {
  return {
    project: "shop",
    fields: {},
    smtp_configured: false,
    google_configured: false,
    github_configured: false,
    backup_configured: false,
    shared_login: true,
    project_settings: projected,
  };
}

function configurationPlan(body: Record<string, unknown>) {
  const configuration = jsonObject(body.configuration);
  const values = jsonObject(configuration.values);
  const changes = Object.entries(values).map(([key, value]) => {
    const current = snapshot.settings.find((field) => field.key === key);
    if (current === undefined) throw new Error(`Unexpected configuration key: ${key}`);
    return { key, before: current.expected_value, after: value };
  });
  return {
    id,
    operation: {
      kind: "configure",
      project: "shop",
      section: "project_settings",
      revision: digest,
    },
    confirmation: "CONFIGURE shop",
    affected_projects: ["shop"],
    configuration_changes: changes,
    expires_at: Math.floor(Date.now() / 1000) + 300,
    version: "0.5.6",
    image_digest: digest,
    blockers: [],
    ram_mb: 8192,
    free_bytes: host.free_bytes,
    project_count: 1,
    destructive: false,
  };
}

type SettingsFixture = {
  actions: Record<string, unknown>[];
  projected: ProjectSettingsView;
  stale: boolean;
};
async function settingsRoute(route: Route, fixture: SettingsFixture) {
  const { actions, projected, stale } = fixture;
  if (route.request().method() === "GET")
    return await route.fulfill({ json: { result: "status", data: base } });
  const body = requestObject(route.request());
  actions.push(body);
  switch (body.action) {
    case "host_status":
      return await route.fulfill({ json: { result: "host_status", data: host } });
    case "host_configuration":
      return await route.fulfill({
        json: { result: "host_configuration", data: configurationData(projected) },
      });
    case "host_configure_plan":
      if (stale)
        return await route.fulfill({
          status: 403,
          json: { result: "error", code: "project_configuration_changed" },
        });
      return await route.fulfill({ json: { result: "host_plan", data: configurationPlan(body) } });
    default:
      throw new Error(`Unexpected action: ${String(body.action)}`);
  }
}

async function settingsPage(
  page: Page,
  options: { unavailable?: boolean; stale?: boolean; legacy?: boolean } = {},
) {
  const actions: Record<string, unknown>[] = [];
  const current = structuredClone(snapshot);
  if (options.legacy === true) {
    const jwt = current.settings.find((field) => field.key === "jwt_expiry_secs");
    if (jwt === undefined) throw new Error("Missing JWT fixture");
    jwt.saved_value = 172800;
    jwt.expected_value = 172800;
    jwt.runtime_value = 172800;
    jwt.source = "environment";
  }
  const projected: ProjectSettingsView =
    options.unavailable === true
      ? {
          ...current,
          runtime_status: "unavailable",
          settings: current.settings.map((field) => ({
            ...field,
            runtime_value: null,
            pending_restart: null,
          })),
        }
      : current;
  await mount(page);
  await page.route("**/admin/api/updates", (route) =>
    settingsRoute(route, { actions, projected, stale: options.stale === true }),
  );
  await page.goto("/admin/");
  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  await expect(page.getByLabel("Cadastro público", { exact: true })).toBeVisible();
  return actions;
}

test("a typed cross-section batch reviews exact values without executing or persisting the draft", async ({
  page,
}) => {
  const actions = await settingsPage(page);
  await page.getByLabel("Cadastro público", { exact: true }).uncheck();
  await page.getByLabel("Validade do token de acesso (segundos)", { exact: true }).fill("1200");
  await page.getByLabel("Usar comportamento padrão", { exact: true }).uncheck();
  await page
    .getByLabel("Origens CORS permitidas", { exact: true })
    .fill("https://batch.example.test");
  await page.getByLabel("Tamanho máximo por arquivo (bytes)", { exact: true }).fill("512");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Validar lote e revisar impacto", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Revise antes de confirmar", exact: true }),
  ).toBeVisible();
  const review = page.getByRole("region", { name: "Alterações validadas pelo servidor" });
  await expect(review).toContainText("Cadastro público");
  await expect(review).toContainText("1.200");
  await expect(review).toContainText("https://batch.example.test");
  const plans = actions.filter((action) => action.action === "host_configure_plan");
  expect(plans).toHaveLength(1);
  expect(jsonObject(plans[0]?.configuration)).toEqual({
    section: "project_settings",
    expected_revision: snapshot.revision,
    values: {
      signup_enabled: false,
      jwt_expiry_secs: 1200,
      cors_allow_origins: ["https://batch.example.test"],
      storage_max_file_size: 512,
    },
  });
  expect(actions.some((action) => action.action === "host_start")).toBe(false);
  const storage = await page.evaluate(() => JSON.stringify([sessionStorage, localStorage]));
  expect(storage).not.toContain("batch.example.test");
});

test("stale configuration never executes and keeps the draft for explicit reload or discard", async ({
  page,
}) => {
  const actions = await settingsPage(page, { stale: true });
  await page.getByLabel("Cadastro público", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Validar lote e revisar impacto", exact: true }).click();
  await expect(
    page.getByText(
      "A configuração mudou desde a leitura. Recarregue e revise novamente; nada foi sobrescrito.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Cadastro público", { exact: true })).not.toBeChecked();
  expect(actions.some((action) => action.action === "host_start")).toBe(false);
});

test("unavailable process evidence is not shown as active and blocks editing", async ({ page }) => {
  const actions = await settingsPage(page, { unavailable: true });
  await expect(page.getByLabel("Cadastro público", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Validar lote e revisar impacto", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("Em uso pelo processo", { exact: true })).toHaveCount(0);
  expect(
    actions.some((action) => ["host_start", "host_configure_plan"].includes(String(action.action))),
  ).toBe(false);
});

test("unchanged legacy values outside panel bounds do not block an unrelated batch", async ({
  page,
}) => {
  const actions = await settingsPage(page, { legacy: true });
  await page.getByLabel("Cadastro público", { exact: true }).uncheck();
  const lifetime = page.getByLabel("Validade do token de acesso (segundos)", { exact: true });
  await lifetime.fill("172801");
  await expect(
    page.getByRole("button", { name: "Validar lote e revisar impacto", exact: true }),
  ).toBeDisabled();
  await lifetime.fill("172800");
  await page.getByRole("button", { name: "Validar lote e revisar impacto", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Revise antes de confirmar", exact: true }),
  ).toBeVisible();
  const plans = actions.filter((action) => action.action === "host_configure_plan");
  expect(plans).toHaveLength(1);
  expect(jsonObject(plans[0]?.configuration)).toMatchObject({ values: { signup_enabled: false } });
});
