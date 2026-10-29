import type { Page } from "@playwright/test";
/** Marks only the owned panel document as a controller page. */
export async function controllerPage(page: Page): Promise<void> {
  await page.route("**/admin/", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace(
        "<head>",
        '<head><meta name="nelcota-updates-controller" content="1">',
      ),
    });
  });
}
