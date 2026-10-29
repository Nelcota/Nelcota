import { test, expect, type Page, type Locator } from "@playwright/test";

import { fixture } from "./fixtures";

const locales = {
  "pt-BR": {
    viewAs: /^Ver como:/,
    visitor: /Visitante/,
    user: /Usuário logado/,
    reload: "Recarregar",
  },
  en: { viewAs: /^View as:/, visitor: /Visitor/, user: /Signed-in user/, reload: "Reload" },
};

async function switchViewer(
  page: Page,
  picker: Locator,
  { viewer, labels, email }: { viewer: string; labels: typeof locales.en; email: string },
): Promise<void> {
  if (viewer === "owner") return;
  await picker.click();
  await page
    .getByRole("menuitem", { name: viewer === "visitor" ? labels.visitor : labels.user })
    .click();
  if (viewer === "user") await page.getByRole("option", { name: new RegExp(email) }).click();
}

for (const width of [320, 390]) {
  for (const [locale, labels] of Object.entries(locales)) {
    test(`table tools remain reachable at ${width}px in ${locale} for every viewer`, async ({
      page,
    }) => {
      await page.addInitScript((locale) => localStorage.setItem("nelcota.locale", locale), locale);
      await fixture(page);
      const email = "a-user-with-a-very-long-email-address@example.test";
      await viewerUser(page, email);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/admin/tables/notes");
      await page.locator('[data-cell="0:1"]').waitFor();
      const toolbar = page
        .getByRole("heading", { level: 1, name: "notes" })
        .locator("..")
        .locator("..");
      const picker = toolbar.getByRole("button", { name: labels.viewAs });
      const reload = toolbar.getByRole("button", { name: labels.reload, exact: true });

      for (const viewer of ["owner", "visitor", "user"]) {
        // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
        await switchViewer(page, picker, { viewer, labels, email });
        // Visible controls can still be clipped by a parent with overflow hidden.
        // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
        await expect.poll(() => toolbar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
        // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
        await Promise.all(
          // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
          (await toolbar.getByRole("button").all()).map((button) =>
            expect(button).toBeInViewport({ ratio: 1 }),
          ),
        );
        const response = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/admin/api/tables/notes",
        );
        // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
        await reload.click();
        // oxlint-disable-next-line no-await-in-loop -- The next browser assertion depends on the navigation or interaction state from this step.
        expect((await response).ok()).toBe(true);
      }
    });
  }
}

async function viewerUser(page: Page, email: string) {
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
}
