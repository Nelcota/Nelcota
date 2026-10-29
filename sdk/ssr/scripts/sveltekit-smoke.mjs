import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
// Real SvelteKit/browser smoke: production adapter-node build of examples/sveltekit,
// a browser, and a local auth fixture. The fixture is NOT RLS evidence.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { chromium, firefox, webkit } from "playwright-core";

import { KitAuth } from "./kit-auth-smoke.mjs";
const delayInMs = 100;

const example = fileURLToPath(new URL("../examples/sveltekit/", import.meta.url));
const engine = process.env.NELCOTA_SSR_BROWSER ?? "chromium";
if (engine !== "chromium" && engine !== "firefox" && engine !== "webkit") {
  throw new Error("Unknown NELCOTA_SSR_BROWSER");
}
// The build and server inherit the Node or Bun runtime running this smoke.
const runtimeName = () =>
  Object.hasOwn(process.versions, "bun") === false
    ? `node ${process.version}`
    : `bun ${process.versions.bun}`;
const auth = new KitAuth();
const { user, password, counts } = auth;
const api = createServer((request, response) => {
  void auth.handle(request, response).catch((error) => {
    response.destroy(
      error instanceof Error ? error : new Error("Request handler failed", { cause: error }),
    );
  });
});

let app,
  browser,
  page,
  log = "";
try {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  assert(address !== null && typeof address !== "string");
  const apiOrigin = `http://127.0.0.1:${address.port}`;
  // SvelteKit 3 fixes the trusted origin (CSRF checks, url.origin) at build time.
  const port = 20000 + Math.floor(Math.random() * 20000),
    origin = `http://127.0.0.1:${port}`;
  const build = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
    cwd: example,
    env: { ...process.env, ORIGIN: origin },
    encoding: "utf8",
    timeout: 180000,
  });
  assert.equal(build.status, 0, `SvelteKit build failed:\n${build.stdout}\n${build.stderr}`);

  // Use the explicit path: Bun treats `bun build` as its bundler subcommand.
  app = spawn(process.execPath, ["build/index.js"], {
    cwd: example,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      ORIGIN: origin,
      NELCOTA_URL: apiOrigin,
      NELCOTA_SESSION_KEY: randomBytes(32).toString("base64url"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (chunk) => {
    log += chunk;
  });
  app.stderr.on("data", (chunk) => {
    log += chunk;
  });
  await waitForSvelteKit(origin);

  browser = await { chromium, firefox, webkit }[engine].launch(
    engine === "chromium" &&
      process.env.PLAYWRIGHT_CHROMIUM !== undefined &&
      process.env.PLAYWRIGHT_CHROMIUM !== ""
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
      : {},
  );
  page = await browser.newPage();
  // A protected page without a session goes to the login page, keeping its target.
  await page.goto(`${origin}/dashboard`);
  assert.equal(new URL(page.url()).pathname, "/login");
  assert.equal(new URL(page.url()).searchParams.get("next"), "/dashboard");
  const bootstrap = (await page.context().cookies()).find((cookie) =>
    cookie.name.includes("nelcota"),
  );
  assert(bootstrap?.httpOnly === true, "the login page issues an HttpOnly bootstrap cookie");

  // Wrong password: the form action reports it, no session is published.
  await page.fill("input[name=email]", user.email);
  await page.fill("input[name=password]", "wrong-password");
  await page.click("button[type=submit]");
  await page.waitForSelector("[role=alert]");
  assert.equal(new URL(page.url()).pathname, "/login");

  // The failed POST rendered a fresh form; its required email is empty again.
  await page.fill("input[name=email]", user.email);
  await page.fill("input[name=password]", password);
  await page.click("button[type=submit]");
  await page.waitForURL(`${origin}/dashboard`);
  assert.equal(await page.textContent("[data-testid=email]"), user.email);
  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name === bootstrap.name);
  assert(
    session?.httpOnly === true && session.sameSite === "Lax",
    "the session cookie is HttpOnly and SameSite=Lax",
  );
  assert.notEqual(session.value, bootstrap.value, "sign-in rotates the bootstrap ID");
  assert(
    Boolean(cookies.some((cookie) => cookie.value.includes("private"))) === false,
    "no token reaches a browser cookie",
  );
  assert(
    Boolean((await page.content()).includes("private")) === false,
    "no token reaches the rendered page",
  );
  const response = await page.request.get(`${origin}/dashboard`);
  assert.match(response.headers()["cache-control"] ?? "", /private, no-store/);

  // An expired access token: the guard sends the browser through the refresh route
  // (a POST that rotates the session) and back to the page it asked for.
  auth.expired = true;
  await page.goto(`${origin}/dashboard`);
  await page.waitForURL(`${origin}/dashboard`);
  assert.equal(counts.refresh, 1);
  assert.equal(await page.textContent("[data-testid=email]"), user.email);

  // A cross-site form post is refused by the session core (and SvelteKit's own check).
  const forged = await fetch(`${origin}/logout`, {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      cookie: `${session.name}=${session.value}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "",
    redirect: "manual",
  });
  assert(forged.status >= 400, `cross-site logout must fail, got ${forged.status}`);
  assert.equal(counts.logout, 0);

  await page.click("text=Sign out");
  await page.waitForURL((url) => new URL(url).pathname === "/login");
  assert.equal(counts.logout, 1);
  await page.goto(`${origin}/dashboard`);
  assert.equal(
    new URL(page.url()).pathname,
    "/login",
    "signed out: the dashboard is protected again",
  );

  console.log(
    JSON.stringify(
      {
        framework: "SvelteKit 3 production adapter-node build",
        runtime: runtimeName(),
        browser: `${engine} ${browser.version()}`,
        counts,
        authorization: "not tested: local auth fixture",
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    `server log:\n${log}\npage ${page?.url()}:\n${await page?.content().catch(() => "")}`,
  );
  throw error;
} finally {
  await browser?.close();
  app?.kill();
  api.close();
}

/** @param {string} origin @returns {Promise<void>} */
async function waitForSvelteKit(origin) {
  for (let attempt = 0; ; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- Wait for the current readiness attempt before retrying the owned application.
    const response = await fetch(origin).catch(() => null);
    if (response !== null) return;
    if (attempt > 100) throw new Error(`SvelteKit server did not start:\n${log}`);
    // oxlint-disable-next-line no-await-in-loop -- Wait for the current readiness attempt before retrying the owned application.
    await new Promise((resolve) => setTimeout(resolve, delayInMs));
  }
}
