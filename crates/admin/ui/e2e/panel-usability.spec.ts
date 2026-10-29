import { expect } from "@playwright/test";

import { gate as controlGate } from "./gate";
import { test, openUser, fits } from "./panel-fixture";
import { requestObject } from "./request-json";

for (const bytes of [1, 1000, 16384, null]) {
  test(`bucket settings preserve an untouched ${bytes}-byte limit`, async ({ page }) => {
    await page.route("**/admin/api/storage", (route) =>
      route.fulfill({
        json: bucketOverview(bytes),
      }),
    );
    const writes: unknown[] = [];
    await page.route("**/admin/api/storage/buckets/documents", async (route) => {
      writes.push(requestObject(route.request()));
      await route.fulfill({ json: {} });
    });
    await page.goto("/admin/storage");
    await page.getByRole("button", { name: "Actions for documents", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit…", exact: true }).click();
    await page.locator("#bucket-types").fill("image/*");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({ file_size_limit: bytes, allowed_mime_types: ["image/*"] });
    // Editing and explicitly clearing the limit remain separate user actions.
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Actions for documents", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit…", exact: true }).click();
    await page.locator("#bucket-limit").fill("0.5");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1]).toMatchObject({ file_size_limit: 524288 });
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Actions for documents", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit…", exact: true }).click();
    await page.locator("#bucket-limit").fill("");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => writes.length).toBe(3);
    expect(writes[2]).toMatchObject({ file_size_limit: null });
  });
}

test("Back and Forward protect dirty drafts and preserve history after cancelling", async ({
  page,
}) => {
  await page.goto("/admin/storage");
  await page.locator(".panel-sidebar").getByRole("button", { name: "Users", exact: true }).click();
  await page
    .locator(".panel-sidebar")
    .getByRole("link", { name: "User list", exact: true })
    .click();
  await page.getByRole("button", { name: "New user", exact: true }).first().click();
  await page.locator("#new-user-email").fill("draft@example.test");
  await page.evaluate(() => history.back());
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.locator("#new-user-email")).toHaveValue("draft@example.test");
  await page.evaluate(() => history.back());
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/storage$/);
  await page.evaluate(() => history.forward());
  await expect(page).toHaveURL(/\/admin\/users$/);
  await page.getByRole("button", { name: "New user", exact: true }).first().click();
  await page.locator("#new-user-email").fill("second@example.test");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
});

test("global search cannot take focus or discard a draft behind an active dialog", async ({
  page,
}) => {
  await openUser(page);
  await page.locator("#new-user-email").fill("draft@example.test");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.locator("#new-user-email")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.locator("#new-user-email")).toHaveValue("draft@example.test");
});

test("internal navigation and reload respect the active draft and explicit discard", async ({
  page,
}) => {
  await openUser(page);
  await page.locator("#new-user-email").fill("draft@example.test");
  expect(
    await page.evaluate(
      () => window.dispatchEvent(new Event("beforeunload", { cancelable: true })) === false,
    ),
  ).toBe(true);
  // Dispatch the same link action used by shell navigation while the modal is
  // active; the shared router must also guard programmatic navigation.
  const storage = page.locator('[data-panel-navigation] a[href="/admin/storage"]').first();
  await storage.evaluate((e) => (e as HTMLAnchorElement).click());
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.locator("#new-user-email")).toHaveValue("draft@example.test");
  await storage.evaluate((e) => (e as HTMLAnchorElement).click());
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/storage$/);
  expect(
    await page.evaluate(
      () => window.dispatchEvent(new Event("beforeunload", { cancelable: true })) === false,
    ),
  ).toBe(false);
});

test("discard confirmation preserves a history jump across hash entries", async ({ page }) => {
  await page.goto("/admin/connect");
  // The page no longer links to its own sections (the sidebar does); a hash change adds the same history entry.
  await page.evaluate(() => {
    location.hash = "api-sdk";
  });
  await expect(page).toHaveURL(/#api-sdk$/);
  await page.locator(".panel-sidebar").getByRole("button", { name: "Users", exact: true }).click();
  await page
    .locator(".panel-sidebar")
    .getByRole("link", { name: "User list", exact: true })
    .click();
  await page.getByRole("button", { name: "New user", exact: true }).first().click();
  await page.locator("#new-user-email").fill("history-draft@example.test");
  await page.evaluate(() => history.go(-2));
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page.evaluate(() => history.go(-2));
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/connect$/);
  await page.evaluate(() => history.go(2));
  await expect(page).toHaveURL(/\/admin\/users$/);
});

test("a pending save blocks navigation and a successful save releases the guard", async ({
  page,
}) => {
  const { promise: held, open: release } = controlGate();
  await page.route("**/admin/api/users", async (route) => {
    await held;
    await route.fulfill({
      json: { id: "00000000-0000-4000-8000-000000000099", email: "saved@example.test" },
    });
  });
  try {
    await openUser(page);
    await page.locator("#new-user-email").fill("saved@example.test");
    await page.locator("#new-user-password").fill("A sufficiently long password 42!");
    const sent = page.waitForRequest(
      (r) => r.method() === "POST" && new URL(r.url()).pathname === "/admin/api/users",
    );
    await page.getByRole("dialog").locator('button[type="submit"]').click();
    await sent;
    await page
      .locator('[data-panel-navigation] a[href="/admin/storage"]')
      .first()
      .evaluate((e) => (e as HTMLAnchorElement).click());
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    release();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.locator('[data-panel-navigation] a[href="/admin/storage"]:visible').click();
    await expect(page).toHaveURL(/\/admin\/storage$/);
  } finally {
    release();
  }
});

test("command palette and its last option fit a short landscape viewport", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Account", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await page.getByRole("combobox").press("End");
  await expect(dialog.getByRole("option").last()).toBeInViewport({ ratio: 1 });
});

test("long bucket identities wrap inside a narrow dialog", async ({ page }) => {
  const name = "b".repeat(63);
  await page.route("**/admin/api/storage", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        backend: "disk",
        max_file_size: 52428800,
        max_total_size: null,
        public_url: null,
        buckets: [
          {
            id: name,
            public: false,
            file_size_limit: null,
            allowed_mime_types: null,
            created_at: "2026-10-08T10:30:00Z",
            files: 0,
            bytes: 0,
          },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/admin/storage");
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit…", exact: true }).click();
  await fits(page.getByRole("dialog"));
  await expect(page.getByRole("dialog")).toContainText(name);
});

function bucketOverview(bytes: number | null) {
  return {
    enabled: true,
    backend: "disk",
    max_file_size: 52428800,
    max_total_size: null,
    public_url: null,
    buckets: [
      {
        id: "documents",
        public: false,
        file_size_limit: bytes,
        allowed_mime_types: null,
        created_at: "2026-10-08T10:30:00Z",
        files: 0,
        bytes: 0,
      },
    ],
  };
}
