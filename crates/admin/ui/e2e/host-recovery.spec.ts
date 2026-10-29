import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";

import { id, digest, base, host, mount, plan, confirm } from "./host-fixture";
import { RecoveryRace } from "./host-recovery-race";
import { requestObject, jsonObject } from "./request-json";

test("recovery after restore verification shows the checkpoint and preserves later writes", async ({
  page,
}, info) => {
  await mount(page);
  const job = restoreRecoveryJob();
  let stage = "needs_attention",
    recoveries = 0;
  await page.route("**/admin/api/updates", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { result: "status", data: base } });
      return;
    }
    const body = requestObject(route.request());
    if (body.action === "host_status") {
      await route.fulfill({
        json: {
          result: "host_status",
          data: {
            ...host,
            jobs: [{ ...job, stage, sequence: stage === "needs_attention" ? 9 : 10 }],
          },
        },
      });
      return;
    }
    if (body.action === "host_recover") {
      expect(body.job).toBe(digest);
      expect(body.confirmation).toBe("RESUME shop");
      recoveries++;
      stage = "accepted";
      await route.abort("failed");
      return;
    }
    throw new Error("Recovery must never create a replacement restore request");
  });
  await page.goto("/admin/");
  await expect(page.getByText(/Última etapa registrada/)).toBeVisible();
  await page.getByRole("button", { name: "Revisar recuperação", exact: true }).click();
  await expectPreservedWrites(page);
  await confirm(page, "RESUME shop");
  await page.screenshot({
    path: info.outputPath("recovery-review.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Confirmar e executar", exact: true }).click();
  await acceptedRecovery(page, recoveries);
});

test("rejected passwords settle the pending receipt and allow a fresh review", async ({ page }) => {
  await mount(page);
  let starts = 0;
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
          data: plan(body.operation, "CREATE reporting"),
        },
      });
      return;
    }
    if (body.action === "host_start") {
      starts++;
      await route.fulfill({
        status: 403,
        json: { code: "reauthentication_failed" },
      });
      return;
    }
    throw new Error("Unexpected action", { cause: body.action });
  });
  await page.goto("/admin/");
  await page.getByLabel("Nome do projeto").fill("reporting");
  await page.getByLabel("Domínio da API").fill("api.reporting.test");
  await page.getByRole("button", { name: "Validar e revisar", exact: true }).click();
  await confirm(page, "CREATE reporting");
  await page.getByRole("button", { name: "Confirmar e executar", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("A operação foi bloqueada");
  await expect(page.getByRole("button", { name: "Validar e revisar", exact: true })).toBeEnabled();
  expect(starts).toBe(1);
  expect(
    await page.evaluate(() => sessionStorage.getItem("nelcota.host.request:operator@example.test")),
  ).toBeNull();
});

test("an older status request cannot settle a newly rejected request key", async ({ page }) => {
  await mount(page);

  const race = new RecoveryRace();
  await page.route("**/admin/api/updates", (route) => race.handle(route));
  try {
    await page.goto("/admin/");
    await expect(page.getByLabel("Nome do projeto")).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => race.reads).toBe(2);
    await page.getByLabel("Nome do projeto").fill("reporting");
    await page.getByLabel("Domínio da API").fill("api.reporting.test");
    await page.getByRole("button", { name: "Validar e revisar", exact: true }).click();
    await confirm(page, "CREATE reporting");
    await page.getByRole("button", { name: "Confirmar e executar", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Não foi possível confirmar a resposta");
    race.old.open();
    await expect.poll(() => race.currentKey).not.toBeNull();
    const pending = jsonObject(
      await page.evaluate(
        () =>
          JSON.parse(
            sessionStorage.getItem("nelcota.host.request:operator@example.test") ?? "null",
          ) as unknown,
      ),
    );
    expect(pending.key).toBe(race.currentKey);
    race.current.open();
    await expect(page.getByRole("alert")).toContainText("A operação foi bloqueada");
    expect(race.starts).toBe(1);
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("nelcota.host.request:operator@example.test"),
      ),
    ).toBeNull();
  } finally {
    race.old.open();
    race.current.open();
  }
});

function restoreRecoveryJob() {
  return {
    id: digest,
    request_key: id,
    operation: {
      kind: "restore",
      project: "shop",
      backup: "nelcota-shop-pair.dump",
    },
    stage: "needs_attention",
    sequence: 9,
    updated_at: 123,
    changed: true,
    backup: "nelcota-shop-safety.dump",
    error: "worker_interrupted",
    last_stage: "verifying",
  };
}

async function expectPreservedWrites(page: Page): Promise<void> {
  await expect(
    page.getByText("Verification of the already restored database and files.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(/A recuperação verifica o estado atual e preserva gravações posteriores/),
  ).toBeVisible();
  await expect(
    page.getByText(/Os dados e arquivos serão substituídos pelo par selecionado/),
  ).toHaveCount(0);
}

async function acceptedRecovery(page: Page, recoveries: number) {
  await expect(page.getByText("Pedido registrado", { exact: true })).toBeVisible();
  expect(recoveries).toBe(1);
  await expect(page.getByRole("button", { name: "Confirmar e executar", exact: true })).toHaveCount(
    0,
  );
}
