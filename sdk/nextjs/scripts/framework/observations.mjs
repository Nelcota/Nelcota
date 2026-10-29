import { chromium, firefox, webkit } from "playwright-core";
/** @param {import("playwright-core").Page} page
 * @param {string} email */
export const signIn = (page, email) =>
  page
    .evaluate(
      async (email) =>
        (
          await fetch("/api/login", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password: "fixture-password" }),
          })
        ).status,
      email,
    )
    .catch(() => "lost");
/** Signed-in email shown by the verified Server Component, or null when signed out. */
/** @param {import("playwright-core").Page} page
 * @param {string} origin */
export async function shown(page, origin) {
  await page.goto(origin + "/profile");
  if ((await page.getByRole("heading", { name: "Signed out" }).count()) > 0) return null;
  return await page.getByTestId("email").textContent();
}

/** Launches the explicitly selected installed browser for the local fixture. */
export async function launchFixtureBrowser() {
  const engine = process.env.NELCOTA_NEXT_BROWSER ?? "chromium";
  const launcher = { chromium, firefox, webkit }[engine];
  if (launcher === undefined) throw new Error("Unknown NELCOTA_NEXT_BROWSER");
  const browser = await launcher.launch({
    headless: true,
    ...(engine === "chromium"
      ? {
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
          ...(process.env.CHROMIUM_PATH !== undefined && process.env.CHROMIUM_PATH !== ""
            ? { executablePath: process.env.CHROMIUM_PATH }
            : {}),
        }
      : {}),
  });

  return { browser, engine };
}
