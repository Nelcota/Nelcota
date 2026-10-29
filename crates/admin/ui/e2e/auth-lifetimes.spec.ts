import { expect, test, type Page } from "@playwright/test";

import type * as AuthModule from "../src/lib/features/auth/auth";
import type * as ProfileModule from "../src/lib/features/profile/profile.svelte";
import type * as SessionModule from "../src/lib/resources/session.svelte";
import type * as ApiModule from "../src/lib/transport/api";
import { fixture } from "./fixtures";

for (const timedOut of [false, true]) {
  test(`a ${timedOut ? "timed-out" : "delayed"} logout cannot remove the next login cookie or profile`, async ({
    page,
    context,
  }) => {
    await fixture(page);
    if (timedOut) await page.clock.install();
    let logins = 0;
    const pendingLogout = await heldLogout(page, timedOut);
    await page.route("**/admin/api/login", async (route) => {
      logins++;
      await route.fulfill({
        json: { email: "new@example.test" },
        headers: {
          "set-cookie": "nelcota_admin=new-session; Path=/admin; HttpOnly; SameSite=Strict",
        },
      });
    });
    await page.evaluate(async () => {
      const { logout } = (await import(
        new URL("/admin/src/lib/features/auth/auth.ts", location.href).href
      )) as typeof AuthModule;
      Object.assign(window, { oldLogout: logout() });
    });
    await expect.poll(() => typeof pendingLogout.finish).toBe("function");
    await page.evaluate(startNextLogin);
    try {
      expect(logins).toBe(0);
      if (timedOut) {
        await page.clock.fastForward(60_001);
        await expect.poll(() => logins).toBe(1);
      }
    } finally {
      await pendingLogout.finish();
    }
    const result = await page.evaluate(async () => {
      await Promise.all([window.oldLogout, window.newLogin]);
      const { session } = (await import(
        new URL("/admin/src/lib/resources/session.svelte.ts", location.href).href
      )) as typeof SessionModule;
      const { profile } = (await import(
        new URL("/admin/src/lib/features/profile/profile.svelte.ts", location.href).href
      )) as typeof ProfileModule;
      return { email: session.email, expired: session.expired, avatar: profile.avatar };
    });
    expect(result).toEqual({ email: "new@example.test", expired: false, avatar: 42 });
    expect((await context.cookies()).find((cookie) => cookie.name === "nelcota_admin")?.value).toBe(
      "new-session",
    );
  });
}

async function startNextLogin() {
  const { api } = (await import(
    new URL("/admin/src/lib/transport/api.ts", location.href).href
  )) as typeof ApiModule;
  const { session } = (await import(
    new URL("/admin/src/lib/resources/session.svelte.ts", location.href).href
  )) as typeof SessionModule;
  const { profile } = (await import(
    new URL("/admin/src/lib/features/profile/profile.svelte.ts", location.href).href
  )) as typeof ProfileModule;
  Object.assign(window, {
    newLogin: api.post<{ email: string }>("/login").then((me: { email: string }) => {
      session.email = me.email;
      session.expired = false;
      profile.avatar = 42;
    }),
  });
}

async function heldLogout(page: Page, timedOut: boolean) {
  let finish!: () => Promise<void>;
  await page.route(
    "**/admin/api/logout",
    (route) =>
      new Promise<void>((resolve) => {
        finish = async () => {
          await route
            .fulfill({
              json: { ok: true },
              headers: {
                "set-cookie": "nelcota_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0",
              },
            })
            .catch((error) => {
              if (timedOut === false) throw error;
            });
          resolve();
        };
      }),
  );

  return {
    get finish() {
      return finish;
    },
  };
}
