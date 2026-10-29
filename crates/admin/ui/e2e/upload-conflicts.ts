import { expect, type Page, type Route } from "@playwright/test";

import { requiredValue } from "../src/lib/contracts/required-value";
import { assertCondition } from "./condition";

export async function verifyConflictReplacement(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/storage/documents");
  const uploads: string[] = [];
  const pending: { finish?: () => void } = {};
  const upload = async (route: Route) => {
    const url = new URL(route.request().url());
    uploads.push(url.search);
    if (url.searchParams.get("replace") === "true") return await route.fulfill({ json: {} });
    await new Promise<void>((resolve) => (pending.finish = resolve));
    await route.fulfill({ status: 409, json: { error: "Already exists", code: "object_exists" } });
  };
  await page.route("**/admin/api/storage/buckets/documents/upload?*", upload);
  await page.getByRole("button", { name: "Enviar arquivos", exact: true }).waitFor();
  const drop = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["dragged content"], "existing.txt", { type: "text/plain" }));
    return data;
  });
  await page
    .getByRole("button", {
      name: "Arraste arquivos para cá ou clique para selecionar",
      exact: true,
    })
    .dispatchEvent("drop", { dataTransfer: drop });
  await page.getByRole("progressbar").waitFor();
  await expect.poll(() => typeof pending.finish).toBe("function");
  await page.getByRole("link", { name: "reports/", exact: true }).click();
  requiredValue(pending.finish, "pending conflict")();
  await page.getByRole("alertdialog").waitFor();
  assertCondition(
    (await page.getByRole("alertdialog").innerText()).includes("documents/"),
    "Replace must identify original destination",
  );
  await page.getByRole("button", { name: "Substituir", exact: true }).click();
  await page.getByRole("alertdialog").waitFor({ state: "hidden" });
  assertCondition(
    uploads.length === 2 && new URLSearchParams(uploads[1]).get("name") === "existing.txt",
    "Replace must retain original folder after navigation",
  );
  await page.unroute("**/admin/api/storage/buckets/documents/upload?*", upload);
}
