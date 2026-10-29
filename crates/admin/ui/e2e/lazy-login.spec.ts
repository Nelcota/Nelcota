import { test, expect, type Page } from "@playwright/test";

import { fixture } from "./fixtures";

// The signed-in panel's code is fetched alongside the session check only when
// this browser was signed in last time (src/lib/shell/prefetch.ts). Otherwise
// the login never downloads panel code (D54). Either way, nothing private
// renders and no private data is requested before signing in.
const panelModule =
  /authenticated-shell|(?:table-editor|storage-bucket|code-block|sql-editor)(?:\.svelte|-)/;

async function signedOutDeepLink(page: Page, { signedInBefore }: { signedInBefore: boolean }) {
  await fixture(page);
  // Finish the fixture's initial authenticated navigation before recording requests.
  await expect(page.locator(".panel-rail")).toBeVisible();
  if (signedInBefore === false)
    await page.evaluate(() => localStorage.removeItem("nelcota.signedIn"));
  await page.route("**/admin/api/session", (route) =>
    route.fulfill({ status: 401, json: { code: "session_expired", message: "Sign in" } }),
  );
  await page.route("**/admin/api/login", (route) =>
    route.fulfill({ json: { email: "admin@example.test" } }),
  );
  // Leave the signed-in page first, so its late requests are not counted.
  await page.goto("about:blank");
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const identity = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/api/whoami",
  );
  await page.goto("/admin/storage/documents");
  await expect(page.getByRole("heading", { name: "Entrar no Nelcota" })).toBeVisible();
  await (await identity).finished();
  await expect(page.locator(".panel-rail")).toHaveCount(0);
  const apiPaths = requests
    .map((url) => new URL(url).pathname)
    .filter((path) => path.startsWith("/admin/api/"));
  expect(
    apiPaths.filter((path) => path !== "/admin/api/session" && path !== "/admin/api/whoami"),
  ).toEqual([]);
  // Only the active language's texts are downloaded.
  expect(requests.filter((url) => url.includes("/i18n/messages/en/"))).toEqual([]);
  expect(requests.some((url) => url.includes("/i18n/messages/pt-BR/"))).toBe(true);
  return requests;
}

async function signIn(page: Page) {
  await page.getByLabel("E-mail", { exact: true }).fill("admin@example.test");
  await page.getByLabel("Senha", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("documents");
}

test("a first visit downloads panel code only after signing in", async ({ page }) => {
  const requests = await signedOutDeepLink(page, { signedInBefore: false });
  // Lists the offending URLs, so an intermittent CI failure says what loaded.
  expect(requests.filter((url) => panelModule.test(url))).toEqual([]);
  await signIn(page);
  expect(requests.some((url) => url.includes("authenticated-shell"))).toBe(true);
  expect(requests.some((url) => /storage-bucket(?:\.svelte|-)/.test(url))).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("nelcota.signedIn"))).toBe("1");
});

test("a browser that was signed in prefetches the panel but still shows only the login", async ({
  page,
}) => {
  const requests = await signedOutDeepLink(page, { signedInBefore: true });
  expect(requests.some((url) => url.includes("authenticated-shell"))).toBe(true);
  expect(requests.some((url) => /storage-bucket(?:\.svelte|-)/.test(url))).toBe(true);
  // The expired session clears the hint: the next visit loads like a first one.
  expect(await page.evaluate(() => localStorage.getItem("nelcota.signedIn"))).toBeNull();
  await signIn(page);
});

test("switching the language loads the other catalog before the text changes", async ({ page }) => {
  await page.route("**/admin/api/session", (route) =>
    route.fulfill({ status: 401, json: { code: "session_expired", message: "Sign in" } }),
  );
  await page.route("**/admin/api/whoami", (route) => route.fulfill({ json: { project: "demo" } }));
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/admin/");
  await expect(page.getByRole("heading", { name: "Entrar no Nelcota" })).toBeVisible();
  expect(requests.filter((url) => url.includes("/i18n/messages/en/"))).toEqual([]);
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Nelcota" })).toBeVisible();
  expect(requests.some((url) => url.includes("/i18n/messages/en/"))).toBe(true);
});

test("the language download is retried before the panel gives up", async ({ page }) => {
  await page.route("**/admin/api/session", (route) =>
    route.fulfill({ status: 401, json: { code: "session_expired", message: "Sign in" } }),
  );
  await page.route("**/admin/api/whoami", (route) => route.fulfill({ json: { project: "demo" } }));
  let failures = 1;
  await page.route("**/i18n/messages/pt-BR/index.ts*", (route) => {
    if (failures === 0) return route.continue();
    failures--;
    return route.abort();
  });
  await page.goto("/admin/");
  await expect(page.getByRole("heading", { name: "Entrar no Nelcota" })).toBeVisible();
  await expect(page.locator("#startup-failure")).toBeHidden();
});

test("without its texts the panel shows a bilingual retry screen", async ({ page }) => {
  await page.route("**/admin/api/session", (route) =>
    route.fulfill({ status: 401, json: { code: "session_expired", message: "Sign in" } }),
  );
  await page.route("**/i18n/messages/pt-BR/index.ts*", (route) => route.abort());
  await page.goto("/admin/");
  const failure = page.locator("#startup-failure");
  await expect(failure).toBeVisible();
  await expect(
    failure.getByText("Não foi possível carregar o painel.", { exact: false }),
  ).toBeVisible();
  await expect(failure.getByText("The panel could not be loaded.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Entrar no Nelcota" })).toHaveCount(0);
  await page.unroute("**/i18n/messages/pt-BR/index.ts*");
  await failure.getByRole("button").click();
  await expect(page.getByRole("heading", { name: "Entrar no Nelcota" })).toBeVisible();
});
