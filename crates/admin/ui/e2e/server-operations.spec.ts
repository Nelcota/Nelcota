import { test, expect, type Page } from "@playwright/test";

import { expectReadable } from "./accessibility";
import { controllerPage } from "./controller-page";
import { requestObject } from "./request-json";
const id = "a".repeat(64),
  digest = "b".repeat(64);
const operator = {
  email: "operator@example.test",
  host_management: true,
  projects: [{ name: "base", version: "0.5.1", update_available: false }],
  jobs: [],
  release: null,
  enabled: false,
  checking: false,
  check_error: null,
};
const host = {
  receipt: null,
  enabled: true,
  projects: [
    {
      name: "base",
      domain: "base.example.test",
      version: "0.5.1",
      app: "healthy",
      database: "healthy",
      backups: ["nelcota-base-test.dump"],
    },
  ],
  jobs: [],
  max_projects: 5,
  ram_mb: 8192,
  free_bytes: 90 * 1024 ** 3,
};
const view = {
  project: "base",
  fields: { BACKUP_HOUR: "3", BACKUP_MINUTE: "0", BACKUP_KEEP: "7" },
  smtp_configured: false,
  google_configured: false,
  github_configured: false,
  backup_configured: false,
  shared_login: true,
};
const health = {
  project: "base",
  checked_at: 1792598400,
  memory_total_bytes: 8 * 1024 ** 3,
  memory_available_bytes: 7 * 1024 ** 3,
  cpu_percent: null,
  load_one: 0.25,
  free_bytes: 90 * 1024 ** 3,
  last_backup_at: null,
  last_offsite_backup_at: null,
  checks: [
    { name: "application", status: "passed" },
    { name: "offsite_configured", status: "warning" },
    { name: "update_acceptance", status: "warning" },
  ],
};
async function mount(page: Page, actions: Record<string, unknown>[]) {
  await controllerPage(page);
  await page.route("**/admin/api/updates", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { result: "status", data: operator } });
      return;
    }
    const body = requestObject(route.request());
    actions.push(body);
    switch (body.action) {
      case "host_status":
        await route.fulfill({ json: { result: "host_status", data: host } });
        return;
      case "host_configuration":
        await route.fulfill({ json: { result: "host_configuration", data: view } });
        return;
      case "host_diagnostics":
        await route.fulfill({ json: { result: "host_diagnostics", data: health } });
        return;
      case "host_plan":
      case "host_configure_plan": {
        await route.fulfill({ json: { result: "host_plan", data: configurationPlan(body) } });
        return;
      }
      case "host_start":
        await route.abort("failed");
        return;
      default:
        throw new Error(`Unexpected action: ${String(body.action)}`);
    }
  });
  await page.goto("/admin/");
  await expect(page.getByRole("button", { name: "Saúde", exact: true })).toBeVisible();
}
test("diagnostics are read-only, preserve unknown CPU, and fit a narrow viewport", async ({
  page,
}, info) => {
  const actions: Record<string, unknown>[] = [];
  await mount(page, actions);
  await page.getByRole("button", { name: "Saúde", exact: true }).click();
  await expect(page.getByText("7,0 GiB / 8,0 GiB")).toBeVisible();
  await expectReadable(page.getByText("Verificado", { exact: true }).first());
  await expect(
    page.getByText("A instalação de atualizações permanece bloqueada", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Indisponível", { exact: true })).toBeVisible();
  expect(actions.some((a) => a.action === "host_start")).toBe(false);
  await page.screenshot({ path: info.outputPath("server-health-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("server-health-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test("configuration reviews do not execute automatically or persist credentials after a lost reply", async ({
  page,
}) => {
  const actions: Record<string, unknown>[] = [];
  await mount(page, actions);
  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  await page.getByLabel("Habilitar esta configuração").check();
  const secret = "smtps://operator:private-smtp-password@smtp.example.test:465";
  await page.getByLabel("Nova URL SMTP com TLS").fill(secret);
  await page.getByLabel("Remetente", { exact: true }).fill("Nelcota <mail@example.test>");
  await page
    .getByLabel("Página de recuperação de senha", { exact: true })
    .fill("https://app.example.test/recover");
  await page.getByRole("button", { name: "Validar e revisar alteração", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Revise antes de confirmar" })).toBeVisible();
  await expect(page.getByText("base, second-project", { exact: true })).toBeVisible();
  expect(actions.filter((a) => a.action === "host_configure_plan")).toHaveLength(1);
  expect(actions.filter((a) => a.action === "host_start")).toHaveLength(0);
  await expect(page.getByLabel("Nova URL SMTP com TLS")).toHaveValue("");
  await page.getByLabel("Conferi o projeto, o domínio e o impacto desta operação.").check();
  await page.getByLabel("Tenho acesso SSH e compreendo como recuperar a VPS.").check();
  await page.getByLabel("Digite exatamente a confirmação abaixo").fill("CONFIGURE base");
  await page.getByLabel("Confirme a senha do operador").fill("operator-test-password");
  await page.getByRole("button", { name: "Confirmar e executar", exact: true }).click();
  await expect
    .poll(
      async () =>
        await page.evaluate(() =>
          sessionStorage.getItem("nelcota.host.request:operator@example.test"),
        ),
    )
    .not.toBeNull();
  const stored = await page.evaluate(() => JSON.stringify([sessionStorage, localStorage]));
  expect(stored).not.toContain("private-smtp-password");
  expect(stored).not.toContain("operator-test-password");
  const start = actions.find((a) => a.action === "host_start");
  expect(JSON.stringify(start)).not.toContain("private-smtp-password");
});
test("draft changes require visual discard before leaving server settings", async ({ page }) => {
  const actions: Record<string, unknown>[] = [];
  await mount(page, actions);
  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  await page.getByLabel("Habilitar esta configuração").check();
  await page.getByLabel("Remetente", { exact: true }).fill("Draft <draft@example.test>");
  await page.getByRole("button", { name: "Saúde", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  expect(actions.some((a) => a.action === "host_start")).toBe(false);
});
test("backups show the actual saved schedule and warn that readback is not an off-host restore", async ({
  page,
}) => {
  const actions: Record<string, unknown>[] = [];
  await mount(page, actions);
  await page.getByRole("button", { name: "Backups", exact: true }).click();
  await expect(
    page.getByText("Isso não substitui um ensaio de restauração em outra máquina.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Backups", exact: true }).selectOption("schedule");
  await expect(page.getByLabel("Hora (fuso da VPS)")).toHaveValue("3");
  await expect(page.getByLabel("Quantidade de backups locais preservados")).toHaveValue("7");
  await page.getByLabel("Quantidade de backups locais preservados").fill("30");
  await page.getByRole("button", { name: "Validar e revisar alteração", exact: true }).click();
  expect(
    actions.some(
      (a) =>
        a.action === "host_configure_plan" && (a.configuration as { keep: number }).keep === 30,
    ),
  ).toBe(true);
  expect(actions.some((a) => a.action === "host_start")).toBe(false);
});
test("configuration recovery retains every affected project after reload and identifies its own recovery boundary", async ({
  page,
}) => {
  const actions: Record<string, unknown>[] = [];
  await mount(page, actions);
  const operation = {
    kind: "configure",
    project: "base",
    section: "admin_password",
    revision: "c".repeat(64),
  };
  const interrupted = {
    id,
    request_key: digest,
    operation,
    affected_projects: ["base", "second-project"],
    stage: "needs_attention",
    last_stage: "verifying",
    sequence: 8,
    updated_at: 123,
    changed: true,
    backup: null,
    error: "worker_interrupted",
  };
  await page.route("**/admin/api/updates", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { result: "status", data: operator } });
      return;
    }
    const body = requestObject(route.request()) as { action: string };
    if (body.action === "host_status") {
      await route.fulfill({
        json: { result: "host_status", data: { ...host, jobs: [interrupted] } },
      });
      return;
    }
    throw new Error(`Unexpected action: ${body.action}`);
  });
  await page.reload();
  await page.getByRole("button", { name: "Revisar recuperação", exact: true }).click();
  await expect(page.getByText("base, second-project", { exact: true })).toBeVisible();
  await expect(
    page.getByText("A recuperação respeita a alteração ou a reversão registrada", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("A restauração já chegou à verificação.", { exact: false }),
  ).toHaveCount(0);
  expect(actions.some((a) => a.action === "host_start")).toBe(false);
});

function configurationPlan(body: Record<string, unknown>) {
  const configuration = body.configuration as { section: string } | undefined;
  const operation =
    configuration != null
      ? {
          kind: "configure",
          project: "base",
          section: configuration.section,
          revision: "c".repeat(64),
        }
      : (body.operation as { kind: string });
  return {
    id,
    operation,
    confirmation: `${operation.kind.toUpperCase()} base`,
    affected_projects: ["base", "second-project"],
    blockers: [],
    expires_at: Math.floor(Date.now() / 1000) + 300,
    version: "0.5.1",
    image_digest: digest,
    ram_mb: 8192,
    free_bytes: host.free_bytes,
    project_count: 1,
    destructive: false,
  };
}
