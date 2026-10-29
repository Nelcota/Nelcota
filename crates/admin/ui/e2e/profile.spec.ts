import { test, expect, type Page } from "@playwright/test";

import { fixture } from "./fixtures";

const photo = {
  name: "photo.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
};

async function openPhoto(page: Page) {
  await page.getByRole("button", { name: "Conta", exact: true }).click();
  await page.getByRole("menuitem", { name: /Adicionar foto|Alterar foto/ }).click();
  await expect(page.getByRole("dialog", { name: "Foto de perfil" })).toBeVisible();
}

for (const outcome of ["success", "failure"]) {
  test(`a photo read ${outcome} from a closed dialog cannot change a new draft`, async ({
    page,
  }) => {
    await fixture(page);
    await page.addInitScript((result) => {
      const state = { ready: false, finish: () => {} };
      Object.assign(window, { oldPhotoRead: state });
      const original = window.createImageBitmap.bind(window);
      window.createImageBitmap = async (file: ImageBitmapSource) => {
        const bitmap = await original(file);
        return await new Promise<ImageBitmap>((resolve, reject) => {
          state.finish = () => {
            if (result === "success") {
              resolve(bitmap);
              return;
            }
            bitmap.close();
            reject(new Error("obsolete photo failure"));
          };
          state.ready = true;
        });
      };
    }, outcome);
    await page.goto("/admin/");
    await openPhoto(page);
    await page.getByRole("dialog").locator("input[type=file]").setInputFiles(photo);
    await expect.poll(() => page.evaluate(() => window.oldPhotoRead.ready)).toBe(true);
    await page.getByRole("dialog").getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openPhoto(page);
    await page.evaluate(async () => {
      window.oldPhotoRead.finish();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByText("Não foi possível ler essa imagem. Tente PNG, JPEG ou WebP."),
    ).toHaveCount(0);
  });
}

test("a completed avatar save updates the profile without closing a reopened dialog", async ({
  page,
}) => {
  await fixture(page);
  let finish!: () => Promise<void>;
  await page.route(
    "**/admin/api/profile/avatar",
    (route) =>
      new Promise<void>((resolve) => {
        finish = async () => {
          await route.fulfill({ json: { avatar: 123 } });
          resolve();
        };
      }),
  );
  await openPhoto(page);
  await page.getByRole("dialog").locator("input[type=file]").setInputFiles(photo);
  await page.getByRole("dialog").getByRole("button", { name: "Salvar", exact: true }).click();
  await expect.poll(() => typeof finish).toBe("function");
  await page.getByRole("dialog").getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await openPhoto(page);
  await finish();
  await expect(page.getByText("Foto atualizada", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Foto de perfil" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Foto de perfil" })).toHaveAttribute(
    "data-state",
    "open",
  );
});
