import { Buffer } from "node:buffer";

import { expect, test } from "@playwright/test";

import { fixtureData } from "./fixture/data";
import { fixture } from "./fixtures";
import { requestObject } from "./request-json";

const stamp = "2026-10-29T18:00:00Z";
const migration = (state: "pending" | "applied") => ({
  version: 1,
  name: "notes",
  checksum: "42",
  applied_on: state === "applied" ? stamp : null,
  state,
});
const sqlFile = (name = "V1__notes.sql") => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from("CREATE TABLE notes(id int PRIMARY KEY);"),
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("nelcota.locale", "en"));
  await fixture(page, "en");
  await page.route("**/admin/api/typescript", (route) =>
    route.fulfill({
      headers: { "x-nelcota-migration-version": "2" },
      contentType: "text/plain",
      body: "export type Database = { public: { Tables: {} } };\n",
    }),
  );
});

test("the completed setup still leads to access verification, deployment and recovery", async ({
  page,
}) => {
  const data = fixtureData("en");
  await page.route("**/admin/api/overview", (route) =>
    route.fulfill({
      json: {
        schema: "public",
        counts: { tables: 3, users: 2, signed_in_users: 2, policies: 3, functions: 0 },
        exposed_without_rls: [],
        tables: data.tables.map((table) => ({
          name: table.name,
          kind: table.kind,
          rls: table.rls,
          comment: null,
          rows: 0,
          rows_exact: true,
          grants: data.grants,
        })),
      },
    }),
  );
  await page.goto("/admin/");
  await page.getByText("Project journey", { exact: false }).click();
  await expect(page.getByText("Initial setup: 4 of 4 observed steps")).toBeVisible();
  await expect(
    page.getByText("A successful sign-in does not prove", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Review recovery steps", exact: true }),
  ).toHaveAttribute("href", "/admin/guides/backup?section=restore");
  await page.screenshot({ path: "test-results/journey-desktop.png", fullPage: true });
  await page.getByRole("link", { name: "Prepare deployment", exact: true }).click();
  await expect(page).toHaveURL(/section=api-deploy$/);
  await expect(
    page.getByRole("heading", { name: "Deploy to this environment", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Environment name", { exact: true }).fill("staging");
  const guide = page.locator("#api-deploy");
  await expect(guide).toContainText("nelcota migrate --env staging --dry-run");
  await expect(guide).not.toContainText("--env production");
  await page.getByLabel("Environment name", { exact: true }).fill("production; echo secret");
  await expect(guide.getByRole("alert")).toBeVisible();
});

test("migration uploads require a matching preview and render committed results without a replay", async ({
  page,
}) => {
  const writes: boolean[] = [];
  await page.route("**/admin/api/migrations/apply", async (route) => {
    const body = requestObject(route.request());
    const dry = body.dry_run === true;
    writes.push(dry);
    await route.fulfill({
      json: {
        report: {
          migrations: [migration(dry ? "pending" : "applied")],
          applied: dry ? [] : [1],
          dry_run: dry,
          ...(dry ? {} : { backup: "nelcota-shop-20261029T180000Z.dump" }),
        },
        catalog_pending: dry === false,
      },
    });
  });
  await page.goto("/admin/migrations");
  await page.locator('input[type="file"]').setInputFiles(sqlFile());
  const apply = page.getByRole("button", { name: "Apply migrations", exact: true });
  await expect(apply).toBeDisabled();
  await page.getByRole("button", { name: "Preview migrations", exact: true }).click();
  await expect(page.getByText("Preview only: no migrations were applied.")).toBeVisible();
  await expect(apply).toBeEnabled();
  await page.locator('input[type="file"]').setInputFiles(sqlFile("V1__changed.sql"));
  await expect(apply).toBeDisabled();
  await page.getByRole("button", { name: "Preview migrations", exact: true }).click();
  await apply.click();
  await expect(page.getByText("Newly applied migrations: 1.")).toBeVisible();
  await expect(
    page.getByText("SQL committed, but the API schema refresh is still pending.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Verified recovery backup:", { exact: false })).toContainText(
    "nelcota-shop-20261029T180000Z.dump",
  );
  await expect(apply).toBeDisabled();
  expect(writes).toEqual([true, true, false]);
});

test("a failed production backup offers remediation and requires reconciliation before another apply", async ({
  page,
}) => {
  let applies = 0;
  await page.route("**/admin/api/migrations/apply", async (route) => {
    const body = requestObject(route.request());
    if (body.dry_run === true) {
      await route.fulfill({
        json: {
          report: { migrations: [migration("pending")], applied: [], dry_run: true },
          catalog_pending: false,
        },
      });
      return;
    }
    applies++;
    await route.fulfill({
      status: 503,
      json: { code: "migration_backup_required", error: "Configure the project backup agent" },
    });
  });
  await page.goto("/admin/migrations");
  await page.locator('input[type="file"]').setInputFiles(sqlFile());
  await page.getByRole("button", { name: "Preview migrations", exact: true }).click();
  const apply = page.getByRole("button", { name: "Apply migrations", exact: true });
  await apply.click();
  await expect(page.getByRole("alert")).toContainText("automatic backup agent");
  await expect(
    page.getByRole("link", { name: "Configure automatic migration backups", exact: true }),
  ).toBeVisible();
  await expect(apply).toBeDisabled();
  expect(applies).toBe(1);
});

test("Connect uses the selected table's UUID primary key in mutation examples", async ({
  page,
}) => {
  const data = fixtureData("en");
  await page.route("**/admin/api/tables/notes?*", (route) =>
    route.fulfill({
      json: {
        table: {
          name: "notes",
          kind: "table",
          comment: null,
          primary_key: ["user_key"],
          editable: true,
          insertable: true,
          exposed_without_rls: false,
          rls: data.tables[0]?.rls,
          columns: data.columns.map((column) =>
            column.name === "id" ? Object.assign({}, column, { name: "user_key" }) : column,
          ),
        },
        rows: [],
        page: 0,
        size: 1,
        has_next: false,
        total: 0,
        total_exact: true,
      },
    }),
  );
  await page.goto("/admin/connect?table=notes");
  await expect(page.getByRole("heading", { name: "Delete", exact: true })).toBeVisible();
  await expect(page.locator("main")).toContainText(
    '.eq("user_key", "00000000-0000-0000-0000-000000000000")',
  );
  await expect(page.locator("main")).not.toContainText(".eq('id', 1)");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("the project journey remains readable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/admin/");
  await expect(page.getByText("Project journey", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Prepare deployment", exact: true })).toBeVisible();
  const overflow = await page
    .locator("main")
    .evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: "test-results/journey-mobile.png", fullPage: true });
});

test("access review opens the existing table preview as a visitor", async ({ page }) => {
  const roles: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/admin/api/tables/notes")
      roles.push(url.searchParams.get("as") ?? "owner");
  });
  await page.goto("/admin/policies");
  const preview = page.getByRole("link", { name: "Preview as visitor", exact: true }).first();
  await expect(preview).toHaveAttribute("href", "/admin/tables/notes?_preview=anon");
  await preview.click();
  await expect(page).toHaveURL(/_preview=anon$/);
  await expect(page.getByRole("button", { name: "View as: Visitor", exact: true })).toBeVisible();
  await expect.poll(() => roles.includes("anon")).toBe(true);
});

test("exporting panel changes preserves dirty-form protection and downloads the migration", async ({
  page,
}) => {
  await page.goto("/admin/migrations");
  await page.getByRole("button", { name: "Generate migration", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Generate migration", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill("notes_update");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const discard = page.getByRole("alertdialog", { name: "Discard changes?", exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(dialog).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Generate and download", exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe("V3__changes.sql");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("V3__changes.sql").first()).toBeVisible();
});
