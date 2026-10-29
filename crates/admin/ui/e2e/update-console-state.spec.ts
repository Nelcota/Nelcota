import { test, expect } from "@playwright/test";

import { gate as controlGate } from "./gate";
import { requestObject } from "./request-json";
import { id, planId, status, controller } from "./updates-fixture";

test("an expired online poll cannot replace a newly authenticated session", async ({ page }) => {
  await controller(page);
  let reads = 0;

  const { promise: pending, open: started } = controlGate();
  const { promise: held, open: release } = controlGate();
  await page.route("**/admin/api/updates", async (route) => {
    if (route.request().method() === "POST") {
      expect(requestObject(route.request()).action).toBe("login");
      await route.fulfill({ json: { result: "session", email: status.email } });
      return;
    }
    const current = ++reads;
    if (current === 2) {
      started();
      await held;
      await route.fulfill({ status: 401, body: "<html>Expired</html>" }).catch(() => {});
      return;
    }
    if (current === 1) {
      await route.fulfill({ status: 401, body: "<html>Expired</html>" });
      return;
    }
    await route.fulfill({ json: { result: "status", data: status } });
  });
  try {
    await page.goto("/admin/");
    await expect(page.getByLabel("E-mail", { exact: true })).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await pending;
    await page.getByLabel("E-mail", { exact: true }).fill("operator@example.test");
    await page.getByLabel("Senha", { exact: true }).fill("operator-test-password");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Preparar atualização" })).toBeVisible();
    release();
    await expect(page.getByRole("button", { name: "Preparar atualização" })).toBeVisible();
    expect(reads).toBeGreaterThanOrEqual(3);
  } finally {
    release();
  }
});

for (const theme of ["dark", "light"]) {
  test(`update console stays usable on narrow screens in ${theme} mode`, async ({ page }, info) => {
    await controller(page);
    await page.addInitScript((value) => localStorage.setItem("mode-watcher-mode", value), theme);
    await page.route("**/admin/api/updates", (route) =>
      route.fulfill({ json: { result: "status", data: { ...status, enabled: false } } }),
    );
    await page.goto("/admin/");
    await expect(
      page.getByRole("heading", { name: "Instalação bloqueada", exact: true }),
    ).toBeVisible();
    await expect(page.locator('img[src*="nelcota-"]:visible')).toHaveCount(1);
    await expect(page.getByRole("heading", { name: "Nenhuma operação registrada" })).toBeVisible();
    await page.screenshot({ path: info.outputPath("updates-desktop.png"), fullPage: true });
    for (const width of [320, 390, 768]) {
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      await page.setViewportSize({ width, height: 844 });
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      await expect(page.getByLabel("Projeto", { exact: true })).toBeVisible();
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  });
}

test("blocked plan preserves password gating and offers cancellation", async ({ page }) => {
  await controller(page);
  await page.route("**/admin/api/updates", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { result: "status", data: { ...status, enabled: false } } });
      return;
    }
    expect(requestObject(route.request()).action).toBe("plan");
    await route.fulfill({
      json: {
        result: "plan",
        data: {
          id: planId,
          project: "shop",
          current: "0.4.0",
          target: "0.5.0",
          digest: id,
          expires_at: Math.floor(Date.now() / 1000) + 300,
          blockers: ["installation_not_validated", "offsite_backup_required"],
        },
      },
    });
  });
  await page.goto("/admin/");
  await page.getByRole("button", { name: "Preparar atualização" }).click();
  await expect(page.getByText("Configurar backup externo do host", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Confirme a senha do operador")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Iniciar atualização", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(page.getByLabel("Confirme a senha do operador")).toHaveCount(0);
});

test("operator login is responsive, keyboard accessible and localized", async ({ page }, info) => {
  await controller(page);
  await page.route("**/admin/api/updates", (route) =>
    route.fulfill({ status: 401, json: { result: "error", code: "session_required" } }),
  );
  await page.goto("/admin/");
  await expect(page.getByRole("heading", { name: "Acesso do operador" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Ir para o conteúdo" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await page.screenshot({ path: info.outputPath("operator-login-desktop.png"), fullPage: true });
  for (const width of [320, 390]) {
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await page.setViewportSize({ width, height: 844 });
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await expect(page.getByLabel("Senha", { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Operator access" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("operator-login-mobile-en.png"), fullPage: true });
});
