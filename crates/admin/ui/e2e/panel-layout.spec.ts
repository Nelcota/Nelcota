import { expect } from "@playwright/test";

import { expectReadable } from "./accessibility";
import { gate as controlGate } from "./gate";
import { test, openUser, fits, visibleHitTarget } from "./panel-fixture";

test("long account identities and password controls fit a narrow dialog", async ({ page }) => {
  const email = `${"a".repeat(64)}@${"b".repeat(60)}.example.test`;
  await page.route("**/admin/api/users?*", (route) =>
    route.fulfill({
      json: {
        page: 0,
        total: 1,
        has_next: false,
        users: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            email,
            created_at: "2026-10-08T10:30:00Z",
            last_sign_in_at: null,
            email_confirmed_at: null,
            sessions: 0,
            has_password: true,
            providers: [],
          },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/admin/users");
  await page.getByRole("button", { name: `Actions for ${email}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Reset password…", exact: true }).click();
  await fits(page.getByRole("dialog"));
  expect((await page.locator("#reset-password").boundingBox())?.width).toBeGreaterThan(180);
});

test("account and project remain readable at intermediate widths in both languages", async ({
  page,
}) => {
  for (const locale of ["en", "pt-BR"]) {
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await page.evaluate((locale) => localStorage.setItem("nelcota.locale", locale), locale);
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await page.reload();
    for (const width of [768, 1024, 1100, 1280]) {
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      await page.setViewportSize({ width, height: 900 });
      const account = page.getByRole("button", {
        name: locale === "en" ? "Account" : "Conta",
        exact: true,
      });
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      expect((await account.boundingBox())?.width).toBeGreaterThanOrEqual(44);
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      await visibleHitTarget(account);
      // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
      await fits(page.locator("header"));
    }
  }
  await page.setViewportSize({ width: 320, height: 740 });
  await expect(
    page.locator("header").getByText("nelcota-demo", { exact: true }).first(),
  ).toBeVisible();
  await fits(page.locator("header"));
});

test("enlarged text reflows the header and overview without occluding controls", async ({
  page,
}) => {
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
  for (const link of await page.locator("header a:visible").all()) await visibleHitTarget(link);
  await visibleHitTarget(page.getByRole("button", { name: "Account", exact: true }));
  const headline = page
    .getByRole("heading", { name: "Overview", exact: true })
    .locator("..")
    .locator("..");
  await fits(headline);
  // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
  for (const link of await headline.getByRole("link").all()) await visibleHitTarget(link);
});

test("webhook status and help links have readable contrast in the light theme", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.route("**/admin/api/webhooks**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/deliveries")
        ? { deliveries: [], next_cursor: null }
        : {
            endpoints: [
              {
                id: "00000000-0000-4000-8000-000000000001",
                name: "Orders",
                schema: "public",
                table: "notes",
                table_available: true,
                url: "https://example.test/hook",
                events: ["INSERT"],
                enabled: true,
                max_attempts: 6,
                created_at: "2026-10-08T10:30:00Z",
              },
            ],
            tables: ["notes"],
            allow_loopback: false,
            outstanding: 0,
            retained: 0,
          },
    }),
  );
  await page.goto("/admin/webhooks");
  const elements = [
    page.getByText("Active", { exact: true }),
    page.locator('main a[href="/admin/guides/webhooks"]').last(),
  ];
  for (const element of elements) {
    // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
    await expectReadable(element);
  }
});

test("updates distinguishes loading, enrollment and a retryable failure", async ({ page }) => {
  const { promise: held, open: release } = controlGate();
  let fail = false;
  let version = "0.5.0";
  let origin: string | null = "https://updates.example.test";
  await page.route("**/admin/api/updates", async (route) => {
    await held;
    if (fail) {
      await route.fulfill({ status: 503, json: { error: "Unavailable" } });
      return;
    }
    await route.fulfill({ json: { version, controller_origin: origin } });
  });
  try {
    await page.goto("/admin/updates");
    await expect(page.getByRole("heading", { name: "Updates", exact: true })).toBeVisible();
    await expect(
      page.getByText("This host has not been enrolled for panel updates.", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("Loading");
    release();
    await expect(
      page.getByRole("link", { name: "Open update management (opens in a new tab)", exact: true }),
    ).toBeVisible();
    origin = null;
    await page.reload();
    await expect(
      page.getByText("This host has not been enrolled for panel updates.", { exact: true }),
    ).toBeVisible();
    version = "";
    await page.reload();
    await expect(page.locator("main strong")).toHaveText("…");
    fail = true;
    await page.reload();
    await expect(page.getByRole("alert")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(
      page.getByText("This host has not been enrolled for panel updates.", { exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
});

test("password entry gets a full row on a small phone", async ({ page }) => {
  await openUser(page);
  await page.setViewportSize({ width: 320, height: 740 });
  await fits(page.getByRole("dialog"));
  expect((await page.locator("#new-user-password").boundingBox())?.width).toBeGreaterThan(180);
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.locator("#new-user-password")).not.toHaveValue("");
  await expect(page.getByRole("button", { name: "Copy password", exact: true })).toBeEnabled();
});
