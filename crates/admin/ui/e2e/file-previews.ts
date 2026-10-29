import type { Page } from "@playwright/test";

import { assertCondition } from "./condition";

export async function verifyFilePreviews(page: Page) {
  await page.goto("/admin/storage/documents");
  await page.getByRole("button", { name: "readme.txt", exact: true }).click();
  await page
    .getByText("Arquivo de exemplo\nPrévia em texto com acentos.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Fechar", exact: true }).first().click();
  await page.getByRole("button", { name: "screenshot.png", exact: true }).click();
  await page.getByRole("img", { name: "screenshot.png", exact: true }).waitFor();
  assertCondition(
    await page
      .getByRole("img", { name: "screenshot.png", exact: true })
      .evaluate((el) => el instanceof HTMLImageElement && el.complete && el.naturalWidth === 1),
    "Image preview must load",
  );
  await page.getByRole("button", { name: "Fechar", exact: true }).first().click();
  await page.getByRole("button", { name: "report.pdf", exact: true }).click();
  await page.getByRole("link", { name: "Abrir PDF", exact: true }).waitFor();
  assertCondition(
    (
      await page.getByRole("link", { name: "Abrir PDF", exact: true }).getAttribute("href")
    )?.startsWith("blob:") === true,
    "PDF must use browser viewer",
  );
  await page.getByRole("button", { name: "Fechar", exact: true }).first().click();
}
