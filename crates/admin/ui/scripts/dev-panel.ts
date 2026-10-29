import { readFile } from "node:fs/promises";

// Consumer smoke against a real disposable dev server, including generated UI contracts.
import { chromium, expect } from "@playwright/test";
const [base, stateFile] = process.argv.slice(2);
if (base === undefined || base === "" || stateFile === undefined || stateFile === "")
  throw new Error("Provide the disposable API origin and dev.env path");
const entries = (await readFile(stateFile, "utf8"))
  .split("\n")
  .filter((line) => line.includes("=") && line.startsWith("#") === false);
const state = Object.fromEntries(
  entries.map((line) => {
    const index = line.indexOf("=");
    return [
      line.slice(0, index),
      line
        .slice(index + 1)
        .replaceAll(/^'|'$/g, "")
        .replaceAll("'\\''", "'"),
    ];
  }),
);
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  const login = await context.request.post(`${base}/admin/api/login`, {
    data: { email: state.ADMIN_EMAIL, password: state.ADMIN_PASSWORD },
  });
  expect(login.ok()).toBe(true);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  await page.goto(`${base}/admin/connect?section=api-ai`);
  await expect(
    page.getByText("No tables are exposed yet. Apply migrations and regenerate the context."),
  ).toBeVisible();
  await expect(page.getByText("Context migration: none applied")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy context", exact: true })).toBeEnabled();
  await page.goto(`${base}/admin/connect?section=api-token`);
  await expect(page.getByRole("heading", { name: "Deployment tokens", exact: true })).toBeVisible();
  await page.getByLabel("Token name", { exact: true }).fill("browser-deploy");
  await page.getByRole("button", { name: "Create deployment token", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Copy deployment token", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  await page.goto(`${base}/admin/migrations`);
  await page.getByLabel("Migration SQL files").setInputFiles({
    name: "V1__browser.sql",
    mimeType: "application/sql",
    buffer: Buffer.from("CREATE TABLE public.browser_fixture(id int4);"),
  });
  await page.getByRole("button", { name: "Preview migrations", exact: true }).click();
  const history = page.getByRole("table", { name: "Migration status", exact: true });
  await expect(history.getByRole("row", { name: "V1 browser Pending", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apply migrations", exact: true }).click();
  await expect(page.getByText("Newly applied migrations: 1.", { exact: true })).toBeVisible();
  await expect(history.getByRole("row", { name: "V1 browser Applied", exact: true })).toBeVisible();
  await page.goto(`${base}/admin/connect?section=api-ai`);
  await expect(page.getByText("Context migration: V1", { exact: true })).toBeVisible();
  const applied = await context.request.post(`${base}/admin/api/migrations/apply`, {
    data: {
      files: [
        { filename: "V1__browser.sql", sql: "CREATE TABLE public.browser_fixture(id int4);" },
        {
          filename: "V2__browser_next.sql",
          sql: "ALTER TABLE public.browser_fixture ADD COLUMN title text;",
        },
      ],
    },
  });
  expect(applied.ok()).toBe(true);
  await page.evaluate('window.dispatchEvent(new Event("focus"))');
  await expect(page.getByText("This context is outdated:", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy context", exact: true })).toBeDisabled();
  await page.locator("#api-ai").getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Context migration: V2", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy context", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
  console.log(
    "PASS: browser token issuance/revocation, migration preview/apply, empty schema warning and stale-context regeneration",
  );
} finally {
  await browser.close();
}
