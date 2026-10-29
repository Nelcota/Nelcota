import { test, expect } from "@playwright/test";

import { id, digest, base, host, mount, confirm } from "./host-fixture";
import { CreationReceipt } from "./host-receipt-fixture";
import { requestObject } from "./request-json";

test("a confirmed receipt releases the form even when local storage cleanup fails", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // oxlint-disable-next-line typescript/unbound-method -- Instrumentation explicitly invokes this saved method with .call(this).
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key: string) {
      if (key.startsWith("nelcota.host.request:")) throw new DOMException("Storage unavailable");
      return original.call(this, key);
    };
  });
  await mount(page);
  const receipt = new CreationReceipt("acknowledged");
  await page.route("**/admin/api/updates", (route) => receipt.handle(route));
  await page.goto("/admin/");
  await page.getByLabel("Nome do projeto").fill("reporting");
  await page.getByLabel("Domínio da API").fill("api.reporting.test");
  await page.getByRole("button", { name: "Validar e revisar", exact: true }).click();
  await confirm(page, "CREATE reporting");
  await page.getByRole("button", { name: "Confirmar e executar", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("O resultado foi confirmado na VPS");
  await expect(page.getByRole("button", { name: "Confirmar e executar", exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Validar e revisar", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByRole("button", { name: "Validar e revisar", exact: true })).toBeEnabled();
  expect(receipt.starts).toBe(1);
});

test("a fresh bounded history releases a completed operation that fell out of history", async ({
  page,
}) => {
  await mount(page);
  let reads = 0;
  const job = historyCreationJob();
  await page.route("**/admin/api/updates", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { result: "status", data: base } });
      return;
    }
    const body = requestObject(route.request());
    if (body.action === "host_status") {
      reads++;
      const jobs =
        reads === 1
          ? [job]
          : Array.from({ length: 32 }, (_, index) => ({
              ...job,
              request_key: (index + 40).toString(16).padStart(64, "0"),
              operation: { kind: "backup", project: "shop" },
              backup: `nelcota-shop-${index}.dump`,
              id: (index + 1).toString(16).padStart(64, "0"),
              stage: "completed",
              sequence: 7,
            }));
      await route.fulfill({
        json: { result: "host_status", data: { ...host, jobs } },
      });
      return;
    }
    throw new Error("No mutation is expected");
  });
  await page.goto("/admin/");
  await expect(page.getByRole("status").filter({ hasText: "Iniciando serviços" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Validar e revisar", exact: true })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: "Validar e revisar", exact: true })).toBeEnabled();
  await expect(page.getByRole("status").filter({ hasText: "Iniciando serviços" })).toHaveCount(0);
});

function historyCreationJob() {
  return {
    id: digest,
    request_key: id,
    operation: {
      kind: "create",
      project: "reporting",
      domain: "api.reporting.test",
      profile: "1gb",
    },
    stage: "starting",
    sequence: 4,
    updated_at: 123,
    changed: true,
    backup: null,
    error: null,
    last_stage: null,
  };
}
