import { expect, test } from "@playwright/test";

import { fixture } from "./fixtures";
import { requestObject } from "./request-json";

const token = `eyJ.${"s".repeat(120)}.sig`;

test("a service_role token is issued only after confirming, once, and stays masked until revealed", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await fixture(page);
  const issued: unknown[] = [];
  await page.route("**/admin/api/tokens/service-role", async (route) => {
    const delayInMs = 300;

    issued.push(requestObject(route.request()));
    // Slow enough for a second click to land while the first is in flight.
    await new Promise((resolve) => setTimeout(resolve, delayInMs));
    await route.fulfill({ status: 200, json: { token, expires_at: 1_900_000_000 } });
  });
  await page.goto("/admin/connect");
  const card = page.locator("#api-token");
  await card.getByRole("button", { name: "Gerar token", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Gerar um token service_role?" });
  await expect(confirm).toContainText("90 dias");
  // A stray Enter right after opening issues nothing; Escape cancels.
  await page.keyboard.press("Enter");
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  expect(issued).toHaveLength(0);

  await card.getByRole("button", { name: "Gerar token", exact: true }).click();
  const action = confirm.getByRole("button", { name: "Gerar token", exact: true });
  await action.dblclick();
  await expect(confirm).toHaveCount(0);
  expect(issued).toEqual([{ days: 90 }]);

  // Masked by default: the value is not in the page until asked for.
  await expect(card.getByText("Token oculto")).toBeAttached();
  expect(await page.content()).not.toContain(token);
  const reveal = card.getByRole("button", { name: "Mostrar token", exact: true });
  await expect(reveal).toHaveAttribute("aria-pressed", "false");
  await card.getByRole("button", { name: "Copiar token", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
  await reveal.click();
  await expect(reveal).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByText(token, { exact: true })).toBeVisible();
});

test("making an existing bucket public asks first, names the file count and cancels cleanly", async ({
  page,
}) => {
  await fixture(page);
  const bucket = existingBucket();
  const writes: unknown[] = [];
  await page.route("**/admin/api/storage", (route) =>
    route.fulfill({
      status: 200,
      json: {
        enabled: true,
        backend: "disk",
        max_file_size: 52428800,
        max_total_size: null,
        public_url: null,
        buckets: [bucket],
      },
    }),
  );
  await page.route("**/admin/api/storage/buckets/documents", async (route) => {
    if (route.request().method() === "PUT") writes.push(requestObject(route.request()));
    await route.fulfill({ status: 200, json: bucket });
  });
  await page.goto("/admin/storage");
  await page.getByRole("button", { name: "Ações de documents", exact: true }).click();
  await page.getByRole("menuitem", { name: "Editar…", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox", { name: "Público", exact: true }).check();
  await dialog.getByRole("button", { name: "Salvar", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Tornar o bucket 'documents' público?" });
  await expect(confirm).toContainText("Os 3 arquivos que já estão nele");
  await confirm.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(writes).toHaveLength(0);

  // Enter submits the form: it must stop at the same confirmation.
  await dialog.getByLabel("Limite por arquivo (MiB)").press("Enter");
  await expect(confirm).toBeVisible();
  expect(writes).toHaveLength(0);
  await confirm.getByRole("button", { name: "Tornar público", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ public: true, file_size_limit: null });
});

function existingBucket() {
  const bucket = {
    id: "documents",
    public: false,
    file_size_limit: null,
    allowed_mime_types: null,
    created_at: "2026-10-08T10:30:00Z",
    files: 3,
    bytes: 1258291,
  };

  return bucket;
}
