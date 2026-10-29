import type { Page } from "@playwright/test";

import { assertCondition } from "./condition";

async function seedQueries(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem(
      "nelcota:sql-saved",
      JSON.stringify({
        v: 1,
        items: [
          { id: "a", name: "Consulta A", sql: "select 1;", updatedAt: 1 },
          { id: "b", name: "Consulta B", sql: "select 2;", updatedAt: 2 },
        ],
      }),
    );
    localStorage.removeItem("nelcota:sql-workspace");
    localStorage.setItem("nelcota:sql-draft", "select now();");
  });
}

export async function verifyQueryDrafts(page: Page) {
  await seedQueries(page);
  await page.reload();
  await page.getByRole("button", { name: "Consulta A", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Editor SQL", exact: true });
  await editor.click();
  await editor.press("Control+a");
  await page.keyboard.insertText("select 42; -- rascunho A");
  await page.getByRole("button", { name: "Consulta B", exact: true }).click();
  assertCondition((await editor.innerText()) === "select 2;", "Opening second query must work");
  await page.getByRole("button", { name: "Consulta A", exact: true }).click();
  assertCondition(
    (await editor.innerText()) === "select 42; -- rascunho A",
    "Saved query draft must survive switching",
  );
  await page.getByRole("button", { name: "Nova consulta", exact: true }).click();
  await editor.click();
  await page.keyboard.insertText("select 7; -- rascunho solto");
  await page.getByRole("button", { name: "Criar tabela com RLS", exact: true }).click();
  await page.getByRole("button", { name: "select 7; -- rascunho solto", exact: true }).click();
  assertCondition(
    (await editor.innerText()) === "select 7; -- rascunho solto",
    "Template must preserve loose draft",
  );
  await page.reload();
  await editor.waitFor();
  assertCondition(
    (await editor.innerText()) === "select 7; -- rascunho solto",
    "Active draft must survive browser refresh",
  );
}

export async function verifyResultResize(page: Page) {
  await page.getByRole("button", { name: "Executar", exact: true }).click();
  await page.getByRole("button", { name: "Exportar", exact: true }).waitFor();
  const separator = page.getByRole("separator", { name: "Redimensionar editor e resultados" });
  const before = await separator.getAttribute("aria-valuenow");
  await separator.focus();
  await separator.press("ArrowUp");
  assertCondition(
    (await separator.getAttribute("aria-valuenow")) !== before,
    "SQL resize must work by keyboard",
  );
}
