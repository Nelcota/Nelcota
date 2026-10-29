import { test, expect } from "@playwright/test";

import { fixture } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await fixture(page);
});

test("preview refuses a replaced file before buffering its oversized body", async ({ page }) => {
  await page.addInitScript(() => {
    const sizes: number[] = [];
    Object.assign(window, { previewBodySizes: sizes });
    // oxlint-disable-next-line typescript/unbound-method -- Instrumentation explicitly invokes this saved method with .call(this).
    const original = Response.prototype.blob;
    Response.prototype.blob = async function () {
      const blob = await original.call(this);
      if (this.url.includes("/storage/buckets/documents/file")) sizes.push(blob.size);
      return blob;
    };
  });
  await page.route("**/admin/api/storage/buckets/documents/file?*", (route) =>
    route.fulfill({
      contentType: "text/plain",
      body: "x".repeat(8 * 1024 * 1024),
    }),
  );
  await page.goto("/admin/storage/documents");
  await page.getByRole("button", { name: "readme.txt", exact: true }).click();
  await expect(
    page.getByText(
      "A prévia não está disponível para este formato ou tamanho. Baixe o arquivo para abri-lo.",
    ),
  ).toBeVisible();
  expect(await page.evaluate(() => window.previewBodySizes)).toEqual([]);
  await expect(page.getByRole("link", { name: "Baixar", exact: true })).toBeVisible();
});

for (const length of [null, "1"]) {
  test(`preview cancels an oversized stream with ${length != null && length !== "" ? "understated" : "missing"} length`, async ({
    page,
  }) => {
    await page.addInitScript((declared) => {
      const stats = { bytes: 0, cancelled: false };
      Object.assign(window, { previewStream: stats });
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/storage/buckets/documents/file") === false)
          return await original(input, init);
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              stats.bytes += 65536;
              if (stats.bytes > 8 * 1024 * 1024) return controller.close();
              controller.enqueue(new Uint8Array(65536));
            },
            cancel() {
              stats.cancelled = true;
            },
          },
          { highWaterMark: 0 },
        );
        const headers = new Headers({ "content-type": "text/plain" });
        if (declared != null && declared !== "") headers.set("content-length", declared);
        return new Response(body, { headers });
      };
    }, length);
    await page.goto("/admin/storage/documents");
    await page.getByRole("button", { name: "readme.txt", exact: true }).click();
    await expect(
      page.getByText(
        "A prévia não está disponível para este formato ou tamanho. Baixe o arquivo para abri-lo.",
      ),
    ).toBeVisible();
    expect(await page.evaluate(() => window.previewStream)).toEqual({
      bytes: 1024 * 1024 + 65536,
      cancelled: true,
    });
  });
}

test("closing a preview cancels its pending read and allows a fresh preview", async ({ page }) => {
  await page.addInitScript(() => {
    const stats = { calls: 0, cancelled: false };
    Object.assign(window, { previewPending: stats });
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/storage/buckets/documents/file") === false)
        return await original(input, init);
      if (++stats.calls > 1)
        return new Response("Nova prévia segura", { headers: { "content-type": "text/plain" } });
      return new Response(
        new ReadableStream({
          cancel() {
            stats.cancelled = true;
          },
        }),
      );
    };
  });
  await page.goto("/admin/storage/documents");
  await page.getByRole("button", { name: "readme.txt", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.previewPending.calls)).toBe(1);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Fechar", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.previewPending.cancelled)).toBe(true);
  await page.getByRole("button", { name: "readme.txt", exact: true }).click();
  await expect(page.getByText("Nova prévia segura", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a cancelled preview failure cannot replace a successful retry", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { calls: 0, fail: () => {} };
    Object.assign(window, { oldPreview: state });
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/storage/buckets/documents/file") === false)
        return await original(input, init);
      if (++state.calls > 1)
        return new Response("Current preview", { headers: { "content-type": "text/plain" } });
      // A non-cooperative adapter reports a transport failure after cancellation.
      return await new Promise<Response>((_resolve, reject) => {
        state.fail = () => reject(new Error("obsolete failure"));
      });
    };
  });
  await page.goto("/admin/storage/documents");
  await page.getByRole("button", { name: "readme.txt", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.oldPreview.calls)).toBe(1);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Fechar", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "readme.txt", exact: true }).click();
  await expect(page.getByText("Current preview", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    window.oldPreview.fail();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(page.getByText("Current preview", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
