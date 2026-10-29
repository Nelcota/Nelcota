// Exercise the shipped Notes example against the documented quickstart schema.
import { randomUUID } from "node:crypto";

import { chromium, firefox, webkit } from "playwright-core";

const [api, demo] = process.argv.slice(2);
if (api == null || api === "" || demo == null || demo === "")
  throw new Error("usage: notes.mjs <api url> <demo url>");
const apiUrl = api,
  demoUrl = demo;
const engine = process.env.NELCOTA_SDK_BROWSER ?? "chromium";
if (engine !== "chromium" && engine !== "firefox" && engine !== "webkit")
  throw new Error("Unknown browser engine");
const browser = await { chromium, firefox, webkit }[engine].launch(
  engine === "chromium" &&
    process.env.PLAYWRIGHT_CHROMIUM !== undefined &&
    process.env.PLAYWRIGHT_CHROMIUM !== ""
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
    : {},
);

/** @param {import("playwright-core").Page} page
 * @param {string} text */
async function result(page, text) {
  await page.waitForFunction(
    (expected) => document.querySelector("#result")?.textContent.includes(expected) === true,
    text,
  );
}

/** @param {import("playwright-core").Page} page
 * @param {string} email
 * @param {string} password */
async function credentials(page, email, password) {
  await page.goto(demoUrl);
  await page.getByLabel("API URL", { exact: true }).fill(apiUrl);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
}

try {
  const page = await browser.newPage();
  const other = await browser.newPage();
  const email = `notes-browser-${randomUUID()}@example.com`;
  const password = randomUUID() + randomUUID();
  const marker = "Private browser note " + randomUUID();
  await credentials(page, email, password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await result(page, "Account created. You are signed in.");
  await page.getByLabel("Note", { exact: true }).fill(marker);
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await result(page, marker);
  await page.getByRole("button", { name: "List notes", exact: true }).click();
  await result(page, marker);
  await page.getByLabel("File", { exact: true }).setInputFiles({
    name: "browser-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Notes upload bytes"),
  });
  await page.getByRole("button", { name: "Upload file", exact: true }).click();
  await result(page, "browser-notes.txt");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await result(page, "You are signed out.");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await result(page, "You are signed in.");
  await page.getByRole("button", { name: "List notes", exact: true }).click();
  await result(page, marker);

  // Separate contexts retain independent sessions for the two users.
  await credentials(other, `notes-browser-other-${randomUUID()}@example.com`, password);
  await other.getByRole("button", { name: "Create account", exact: true }).click();
  await result(other, "Account created. You are signed in.");
  await other.getByRole("button", { name: "List notes", exact: true }).click();
  await other.waitForFunction(() => document.querySelector("#result")?.textContent === "[]");
  await other.getByRole("button", { name: "Sign out", exact: true }).click();
  await result(other, "You are signed out.");
  console.log("PASS: Notes browser signup, login, save/list, upload, RLS and logout");
} finally {
  await browser.close();
}
