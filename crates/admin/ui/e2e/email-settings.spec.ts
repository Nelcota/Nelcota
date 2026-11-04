import { test, expect, type Page } from "@playwright/test";

import type {
  ProjectSetting,
  ProjectSettingsView,
} from "../src/lib/features/server/project-settings";
import { base, host, mount } from "./host-fixture";
import { requestObject } from "./request-json";

function setting(overrides: Partial<ProjectSetting> = {}): ProjectSetting {
  return {
    key: "email_language",
    group: "email",
    kind: "text",
    nullable: false,
    minimum: 2,
    maximum: 5,
    dependencies: [],
    default_value: "en",
    saved_value: "en",
    expected_value: "en",
    runtime_value: "en",
    source: "default",
    pending_restart: false,
    ...overrides,
  };
}
const snapshot: ProjectSettingsView = {
  revision: "d".repeat(64),
  blocked: null,
  runtime_status: "effective",
  settings: [
    setting(),
    setting({
      key: "email_recovery_subject_base64",
      nullable: true,
      minimum: 1,
      maximum: 200,
      default_value: null,
      saved_value: null,
      expected_value: "Reset your password",
      runtime_value: "Reset your password",
    }),
    setting({
      key: "email_recovery_text_base64",
      nullable: true,
      minimum: 1,
      maximum: 2048,
      default_value: null,
      saved_value: null,
      expected_value: "Hello {{email}}\n{{link}}",
      runtime_value: "Hello {{email}}\n{{link}}",
    }),
    setting({
      key: "email_recovery_ttl_minutes",
      kind: "integer",
      minimum: 5,
      maximum: 1440,
      default_value: 60,
      saved_value: 60,
      expected_value: 60,
      runtime_value: 60,
    }),
  ],
};

async function setup(page: Page, configured = true) {
  const actions: Record<string, unknown>[] = [];
  const previews: Record<string, unknown>[] = [];
  const sends: Record<string, unknown>[] = [];
  await mount(page);
  await page.route("**/admin/api/updates", async (route) => {
    if (route.request().method() === "GET")
      return await route.fulfill({ json: { result: "status", data: base } });
    const body = requestObject(route.request());
    actions.push(body);
    if (body.action === "host_status")
      return await route.fulfill({ json: { result: "host_status", data: host } });
    if (body.action !== "host_configuration")
      throw new Error(`Unexpected side effect: ${String(body.action)}`);
    return await route.fulfill({
      json: {
        result: "host_configuration",
        data: {
          project: "shop",
          fields: {},
          smtp_configured: configured,
          google_configured: false,
          github_configured: false,
          backup_configured: false,
          shared_login: true,
          project_settings: snapshot,
        },
      },
    });
  });
  await page.route("**/admin/api/email", (route) =>
    route.fulfill({ json: { project: "shop", configured, test_recipient: "admin@example.test" } }),
  );
  await emailCalls(page, previews, sends);
  await page.goto("/admin/");
  await page.getByRole("button", { name: "Configurações", exact: true }).click();
  await expect(page.getByLabel("Idioma dos emails", { exact: true })).toBeVisible();
  return { actions, previews, sends };
}

async function emailCalls(
  page: Page,
  previews: Record<string, unknown>[],
  sends: Record<string, unknown>[],
) {
  await page.route("**/admin/api/email/preview", async (route) => {
    const body = requestObject(route.request());
    previews.push(body);
    if (typeof body.text === "string" && body.text.includes("{{secret}}"))
      return await route.fulfill({
        status: 400,
        json: { code: "email_content_invalid", message: "invalid draft" },
      });
    return await route.fulfill({
      json: {
        subject: "Example project",
        text: typeof body.text === "string" ? body.text : "Fictional default preview",
        ttl_minutes: body.ttl_minutes,
      },
    });
  });
  await page.route("**/admin/api/email/test", (route) => {
    sends.push(requestObject(route.request()));
    return route.fulfill({ json: { accepted: true } });
  });
}

async function editText(page: Page, text: string) {
  const input = page.locator("#setting-email_recovery_text_base64");
  await input.locator("..").getByRole("checkbox").uncheck();
  await input.fill(text);
}

test("preview and fixed-recipient test keep multiline drafts ephemeral and inert on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const { actions, previews, sends } = await setup(page);
  const text =
    "draft-only-email-marker · D'água $HOME \\ #\n{{link}}\n<img data-email-injection src=x onerror=alert(1)>";
  await editText(page, text);
  await page.getByRole("button", { name: "Gerar prévia do rascunho", exact: true }).click();
  await expect(page.getByLabel("Prévia com dados fictícios")).toContainText(
    "draft-only-email-marker",
  );
  expect(previews).toHaveLength(1);
  expect(previews[0]?.text).toBe(text);
  expect(await page.locator("img[data-email-injection]").count()).toBe(0);
  await page.getByRole("button", { name: "Enviar rascunho de teste", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "O SMTP aceitou o teste" }),
  ).toBeVisible();
  expect(sends).toHaveLength(1);
  expect(sends[0]?.project).toBe("shop");
  expect(sends[0]?.text).toBe(text);
  expect(sends[0]).not.toHaveProperty("to");
  expect(actions.some((action) => action.action === "host_configure_plan")).toBe(false);
  expect(actions.some((action) => action.action === "host_start")).toBe(false);
  const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  expect(stored).not.toContain("draft-only-email-marker");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test("invalid server previews are localized and editing clears the stale result", async ({
  page,
}) => {
  const { sends } = await setup(page);
  await editText(page, "Hello {{email}}\n{{link}}");
  await page.getByRole("button", { name: "Gerar prévia do rascunho", exact: true }).click();
  await expect(page.getByLabel("Prévia com dados fictícios")).toBeVisible();
  await page.locator("#setting-email_recovery_text_base64").fill("{{secret}} {{link}}");
  await expect(page.getByLabel("Prévia com dados fictícios")).toHaveCount(0);
  await page.getByRole("button", { name: "Gerar prévia do rascunho", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Confira o idioma" })).toBeVisible();
  expect(sends).toHaveLength(0);
});

test("preview works without SMTP but invalid lifetimes cannot be sent", async ({ page }) => {
  const { previews, sends } = await setup(page, false);
  const preview = page.getByRole("button", { name: "Gerar prévia do rascunho", exact: true });
  const send = page.getByRole("button", { name: "Enviar rascunho de teste", exact: true });
  await expect(send).toBeDisabled();
  await preview.click();
  await expect(page.getByLabel("Prévia com dados fictícios")).toBeVisible();
  expect(previews[0]?.text).toBeNull();
  await page.locator("#setting-email_recovery_ttl_minutes").fill("0");
  await expect(preview).toBeDisabled();
  expect(sends).toHaveLength(0);
});
