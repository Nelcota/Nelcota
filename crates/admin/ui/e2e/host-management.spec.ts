import { test, expect } from "@playwright/test";

import { base, host, mount, plan, confirm } from "./host-fixture";
import { CreationReceipt } from "./host-receipt-fixture";
import { requestObject } from "./request-json";

test("creation requires visual review, both acknowledgements, exact phrase and password; lost replies retain one operation", async ({
  page,
}, info) => {
  await mount(page);
  const receipt = new CreationReceipt("lost-response");
  await page.route("**/admin/api/updates", (route) => receipt.handle(route));
  await page.goto("/admin/");
  await page.getByLabel("Nome do projeto").fill("reporting");
  await page.getByLabel("Domínio da API").fill("api.reporting.test");
  await page.getByRole("button", { name: "Validar e revisar", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Revise antes de confirmar" })).toBeVisible();
  const execute = page.getByRole("button", {
    name: "Confirmar e executar",
    exact: true,
  });
  await expect(execute).toBeDisabled();
  await page.getByLabel("Confirme a senha do operador").fill("operator-test-password");
  await expect(execute).toBeDisabled();
  await confirm(page, "CREATE reporting");
  await expect(execute).toBeEnabled();
  await page.screenshot({
    path: info.outputPath("creation-review.png"),
    fullPage: true,
  });
  await execute.click();
  await expect(page.getByRole("status").filter({ hasText: "Iniciando serviços" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: "Iniciando serviços" })).toBeVisible();
  expect(receipt.starts).toBe(1);
  expect(
    await page.evaluate(() => sessionStorage.getItem("nelcota.host.request:operator@example.test")),
  ).toBeNull();
});

test("DNS blockers remain visible and prohibit execution", async ({ page }) => {
  await mount(page);
  await page.route("**/admin/api/updates", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { result: "status", data: base } });
      return;
    }
    const body = requestObject(route.request());
    if (body.action === "host_status") {
      await route.fulfill({ json: { result: "host_status", data: host } });
      return;
    }
    if (body.action === "host_plan") {
      await route.fulfill({
        json: {
          result: "host_plan",
          data: plan(body.operation, "CREATE reporting", ["dns_mismatch"]),
        },
      });
      return;
    }
    throw new Error("A blocked operation was submitted");
  });
  await page.goto("/admin/");
  await page.getByLabel("Nome do projeto").fill("reporting");
  await page.getByLabel("Domínio da API").fill("api.reporting.test");
  await page.getByRole("button", { name: "Validar e revisar", exact: true }).click();
  await expect(
    page.getByText("O DNS não aponta exclusivamente para os endereços aprovados da VPS."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirmar e executar", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Confirme a senha do operador")).toBeDisabled();
});

test("restore review identifies the exact backup and warns about replacing data", async ({
  page,
}, info) => {
  await mount(page);
  await page.route("**/admin/api/updates", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { result: "status", data: base } });
      return;
    }
    const body = requestObject(route.request());
    if (body.action === "host_status") {
      await route.fulfill({ json: { result: "host_status", data: host } });
      return;
    }
    if (body.action === "host_plan") {
      expect(body.operation).toEqual({
        kind: "restore",
        project: "shop",
        backup: "nelcota-shop-pair.dump",
      });
      await route.fulfill({
        json: {
          result: "host_plan",
          data: plan(body.operation, "RESTORE shop"),
        },
      });
      return;
    }
    throw new Error("An unconfirmed restore was submitted");
  });
  await page.goto("/admin/");
  await page.getByRole("button", { name: "Selecionar projeto", exact: true }).click();
  await page.getByLabel("Backup selecionado").selectOption("nelcota-shop-pair.dump");
  await page.getByRole("button", { name: "Restaurar backup", exact: true }).click();
  await expect(page.getByText("nelcota-shop-pair.dump", { exact: true }).last()).toBeVisible();
  await expect(
    page.getByText(/Os dados e arquivos serão substituídos pelo par selecionado/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirmar e executar", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("restore-review.png"),
    fullPage: true,
  });
});

test("removal names the target and explains the verified private archive before approval", async ({
  page,
}, info) => {
  await mount(page);
  await page.route("**/admin/api/updates", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { result: "status", data: base } });
      return;
    }
    const body = requestObject(route.request());
    if (body.action === "host_status") {
      await route.fulfill({ json: { result: "host_status", data: host } });
      return;
    }
    if (body.action === "host_plan") {
      expect(body.operation).toEqual({ kind: "remove", project: "shop" });
      await route.fulfill({
        json: { result: "host_plan", data: plan(body.operation, "REMOVE shop") },
      });
      return;
    }
    throw new Error("Unconfirmed removal must never be submitted");
  });
  await page.goto("/admin/");
  await page.getByRole("button", { name: "Selecionar projeto", exact: true }).click();
  await page.getByRole("button", { name: "Remover projeto", exact: true }).click();
  await expect(page.getByText("REMOVE shop", { exact: true })).toBeVisible();
  await expect(page.getByText(/O backup final e a configuração ficarão/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirmar e executar", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("removal-review.png"),
    fullPage: true,
  });
});
