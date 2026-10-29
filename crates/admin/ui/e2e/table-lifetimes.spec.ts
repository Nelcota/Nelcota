import { test, expect, type Page } from "@playwright/test";

import type * as RouterModule from "../src/lib/navigation/router.svelte";
import type * as DdlModule from "../src/lib/shared/schema/ddl";
import type * as ApiModule from "../src/lib/transport/api";
import { fixture } from "./fixtures";

async function prepareRename(page: Page, pauseReload = false) {
  await fixture(page);
  await page.goto("/admin/tables/notes/structure");
  await page.locator("#settings-name").waitFor();
  await page.evaluate(async (paused) => {
    const { ddl } = (await import(
      new URL("/admin/src/lib/shared/schema/ddl.ts", location.href).href
    )) as typeof DdlModule;
    const { api } = (await import(
      new URL("/admin/src/lib/transport/api.ts", location.href).href
    )) as typeof ApiModule;
    const original = api.get;
    const tables = await original("/tables");
    const state = { saving: false, reloading: false, finish: () => {}, finishReload: () => {} };
    Object.assign(window, { pendingRename: state });
    ddl.alterTable = () =>
      new Promise((resolve) => {
        state.saving = true;
        state.finish = () => resolve({ sql: [], applied: true, catalog_pending: false });
      });
    // Keep the callback's refresh deterministic after the controlled write.
    api.get = <T>(
      path: string,
      ...args: [options?: { signal?: AbortSignal; freshForMs?: number }]
    ) => {
      if (path !== "/tables") return original<T>(path, ...args);
      if (paused === false) return Promise.resolve(tables as T);
      return new Promise<T>((resolve) => {
        state.reloading = true;
        state.finishReload = () => resolve(tables as T);
      });
    };
  }, pauseReload);
  await page.locator("#settings-name").fill("notes_renamed");
  await page
    .locator("#settings-name")
    .locator("xpath=ancestor::form")
    .getByRole("button", { name: /Salvar/ })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Renomear", exact: true })
    .click();
  await expect.poll(() => page.evaluate(() => window.pendingRename.saving)).toBe(true);
}

async function navigate(page: Page, path: string) {
  await page.evaluate(async (target) => {
    const { navigate } = (await import(
      new URL("/admin/src/lib/navigation/router.svelte.ts", location.href).href
    )) as typeof RouterModule;
    navigate(target);
  }, path);
  await expect(page).toHaveURL(new RegExp(`/admin${path}$`));
  await expect(page.locator('[data-cell="0:1"]')).toBeVisible();
}

async function finish(page: Page, field: "finish" | "finishReload") {
  await page.evaluate(async (key) => {
    window.pendingRename[key]();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  }, field);
}

for (const target of ["/tables/notes", "/tables/tasks"]) {
  test(`a rename completed after navigating to ${target} cannot redirect the current page`, async ({
    page,
  }) => {
    await prepareRename(page);
    await navigate(page, target);
    await finish(page, "finish");
    await expect(page).toHaveURL(new RegExp(`/admin${target}$`));
    await expect(page.locator('[data-cell="0:1"]')).toBeVisible();
  });
}

test("navigation during the rename callback refresh remains in the chosen view", async ({
  page,
}) => {
  await prepareRename(page, true);
  await finish(page, "finish");
  await expect.poll(() => page.evaluate(() => window.pendingRename.reloading)).toBe(true);
  await navigate(page, "/tables/notes");
  await finish(page, "finishReload");
  await expect(page).toHaveURL(/\/admin\/tables\/notes$/);
});

test("returning to the original view does not revive its old rename callback", async ({ page }) => {
  await prepareRename(page, true);
  await finish(page, "finish");
  await expect.poll(() => page.evaluate(() => window.pendingRename.reloading)).toBe(true);
  await navigate(page, "/tables/notes");
  await page.evaluate(async () => {
    const { navigate } = (await import(
      new URL("/admin/src/lib/navigation/router.svelte.ts", location.href).href
    )) as typeof RouterModule;
    navigate("/tables/notes/structure");
  });
  await expect(page.locator("#settings-name")).toHaveValue("notes");
  await finish(page, "finishReload");
  await expect(page).toHaveURL(/\/admin\/tables\/notes\/structure$/);
});

test("navigation queued after a rename response still retires the original operation", async ({
  page,
}) => {
  await prepareRename(page);
  await page.evaluate(async () => {
    const { navigate } = (await import(
      new URL("/admin/src/lib/navigation/router.svelte.ts", location.href).href
    )) as typeof RouterModule;
    // Resolve the write before navigation, but run its continuation afterwards.
    window.pendingRename.finish();
    navigate("/tables/notes");
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(page).toHaveURL(/\/admin\/tables\/notes$/);
});

test("an active rename still follows its new table name", async ({ page }) => {
  await prepareRename(page);
  await finish(page, "finish");
  await expect(page).toHaveURL(/\/admin\/tables\/notes_renamed\/structure$/);
  await expect(page.locator("#settings-name")).toHaveValue("notes_renamed");
});

for (const leave of [false, true]) {
  test(`a table drop ${leave ? "cannot redirect a later view" : "still returns its active view to the table list"}`, async ({
    page,
  }) => {
    await fixture(page);
    await page.goto("/admin/tables/notes/structure");
    await page.locator("#settings-name").waitFor();
    await page.evaluate(async () => {
      const { ddl } = (await import(
        new URL("/admin/src/lib/shared/schema/ddl.ts", location.href).href
      )) as typeof DdlModule;
      const state = { saving: false, finish: () => {} };
      Object.assign(window, { pendingDrop: state });
      ddl.dropTable = () =>
        new Promise((resolve) => {
          state.saving = true;
          state.finish = () => resolve({ sql: [], applied: true, catalog_pending: false });
        });
    });
    await page.getByRole("button", { name: "Apagar tabela", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("textbox").fill("notes");
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Apagar tabela", exact: true })
      .click();
    await expect.poll(() => page.evaluate(() => window.pendingDrop.saving)).toBe(true);
    if (leave) await navigate(page, "/tables/notes");
    await page.evaluate(async () => {
      window.pendingDrop.finish();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    await expect(page).toHaveURL(leave ? /\/admin\/tables\/notes$/ : /\/admin\/tables$/);
  });
}

test("a late structure reload cannot erase the schema returned by a newer edit", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/admin/tables/notes/structure");
  await page.locator("#settings-name").waitFor();
  await page.evaluate(installDelayedStructure);
  await page.locator("#settings-comment").fill("Changed description");
  await page
    .locator("#settings-name")
    .locator("xpath=ancestor::form")
    .getByRole("button", { name: "Salvar", exact: true })
    .click();
  await expect.poll(() => page.evaluate(() => window.oldStructure.calls)).toBe(1);
  await page.getByRole("button", { name: "Nova coluna", exact: true }).click();
  await page.getByRole("dialog").locator('input[id$="-name"]').fill("added_column");
  await page.getByRole("button", { name: "Adicionar coluna", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("added_column", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    window.oldStructure.finish();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(page.getByText("added_column", { exact: true })).toBeVisible();
});

async function installDelayedStructure() {
  // Browser callbacks cannot capture imports from the test runner.
  function promiseResult<T>(work: () => T | PromiseLike<T>): Promise<T> {
    return new Promise<T>((resolve) => {
      resolve(work());
    });
  }

  const { ddl } = (await import(
    new URL("/admin/src/lib/shared/schema/ddl.ts", location.href).href
  )) as typeof DdlModule;
  const original = await ddl.structure("notes");
  const state = { calls: 0, finish: () => {} };
  Object.assign(window, { oldStructure: state });
  ddl.alterTable = () => promiseResult(() => ({ sql: [], applied: true, catalog_pending: false }));
  ddl.structure = () => {
    if (++state.calls === 1)
      return new Promise((resolve) => {
        state.finish = () => resolve(original);
      });
    return Promise.resolve({
      ...original,
      columns: [
        ...original.columns,
        {
          ...(() => {
            const column = original.columns[1];
            if (column === undefined) throw new Error("Missing structure fixture column");
            return column;
          })(),
          name: "added_column",
        },
      ],
    });
  };
}
