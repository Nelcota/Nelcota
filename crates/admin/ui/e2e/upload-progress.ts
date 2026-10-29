import { expect, type Page, type Route } from "@playwright/test";

import { requiredValue } from "../src/lib/contracts/required-value";
import { assertCondition } from "./condition";

export async function verifyUploadProgress(page: Page) {
  const pending: { uploaded?: { url: string; size?: number }; finish?: () => void } = {};
  const upload = async (route: Route) => {
    pending.uploaded = {
      url: route.request().url(),
      size: route.request().postDataBuffer()?.length,
    };
    await new Promise<void>((resolve) => {
      pending.finish = resolve;
    });
    await route.fulfill({ json: {} });
  };
  await page.route("**/admin/api/storage/buckets/documents/upload?*", upload);
  await page.locator("input[type=file]").setInputFiles({
    name: "new-file.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("arquivo novo"),
  });
  await page.getByRole("progressbar").waitFor();
  assertCondition(
    (await page.getByRole("progressbar").getAttribute("max")) === "12",
    "Upload progress must use byte size",
  );
  await page.waitForFunction(() => document.querySelector("progress") !== null);
  await expect.poll(() => typeof pending.finish).toBe("function");
  requiredValue(pending.finish, "pending upload")();
  await page.getByText("Enviado", { exact: true }).waitFor();
  assertCondition(
    pending.uploaded?.size === 12 &&
      new URL(pending.uploaded.url).searchParams.get("name") === "new-file.txt",
    "Upload must preserve binary body and destination",
  );
  assertCondition(
    (await page.getByRole("progressbar").count()) === 0,
    "Completed upload must leave pending progress state",
  );
  await page.unroute("**/admin/api/storage/buckets/documents/upload?*", upload);
}
