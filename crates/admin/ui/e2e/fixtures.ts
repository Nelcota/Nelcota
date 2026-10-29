import type { Page } from "@playwright/test";

import { fixtureData } from "./fixture/data.js";
import { dispatchFixture } from "./fixture/dispatch.js";
export async function fixture(page: Page, contentLanguage: "pt-BR" | "en" = "pt-BR") {
  const data = fixtureData(contentLanguage);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route("**/admin/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    await dispatchFixture(route, {
      path: url.pathname.slice("/admin/api".length),
      method: request.method(),
      url,
      prefix: url.searchParams.get("prefix") ?? "",
      search: url.searchParams.get("q") ?? "",
      data,
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/");
}
