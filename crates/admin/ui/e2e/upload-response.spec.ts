import { expect, test } from "@playwright/test";

import type * as SessionModule from "../src/lib/resources/session.svelte";
import type * as ApiModule from "../src/lib/transport/api";
import type * as UploadModule from "../src/lib/transport/upload";
import { fixture } from "./fixtures";

for (const declared of [true, false]) {
  test(`oversized upload reply is rejected before parsing (declared: ${declared})`, async ({
    page,
  }) => {
    await fixture(page);
    await page.route("**/admin/api/upload-test", (route) =>
      route.fulfill({ status: 503, contentType: "text/plain", body: "x".repeat(1024 * 1024) }),
    );
    await page.goto("/admin/storage/documents");
    const result = await page.evaluate(probeOversizedReply, declared);
    expect(result).toEqual({ parsed: 0, textReads: 0, status: 503, code: "server_unreachable" });
  });
}

test("blob reception preserves normal upload responses and conflict errors", async ({ page }) => {
  await fixture(page);
  let calls = 0;
  await page.route("**/admin/api/upload-test", (route) =>
    ++calls === 1
      ? route.fulfill({ json: { saved: true } })
      : route.fulfill({ status: 409, json: { code: "object_exists", error: "Already exists" } }),
  );
  await page.goto("/admin/storage/documents");
  const result = await page.evaluate(async () => {
    const { upload } = (await import(
      new URL("/admin/src/lib/transport/upload.ts", location.href).href
    )) as typeof UploadModule;
    const { parseResponse } = (await import(
      new URL("/admin/src/lib/transport/api.ts", location.href).href
    )) as typeof ApiModule;
    const send = () =>
      upload("/upload-test", new File(["test"], "test.txt"), {
        parse: (response: Response) => parseResponse(response, "/upload-test", { method: "POST" }),
      });
    const saved = await send();
    try {
      await send();
      return { saved, status: 200, code: "" };
    } catch (error) {
      const reply = error as { status?: number; code?: string };
      return { saved, status: reply.status, code: reply.code };
    }
  });
  expect(result).toEqual({ saved: { saved: true }, status: 409, code: "object_exists" });
});

test("an oversized unauthorized upload expires the panel session", async ({ page }) => {
  await fixture(page);
  await page.route("**/admin/api/upload-test", (route) =>
    route.fulfill({ status: 401, body: "x".repeat(1024 * 1024) }),
  );
  await page.goto("/admin/storage/documents");
  const result = await page.evaluate(async () => {
    const { uploadFile } = (await import(
      new URL("/admin/src/lib/transport/api.ts", location.href).href
    )) as typeof ApiModule;
    const { session } = (await import(
      new URL("/admin/src/lib/resources/session.svelte.ts", location.href).href
    )) as typeof SessionModule;
    session.email = "admin@example.test";
    try {
      await uploadFile("/upload-test", new File(["test"], "test.txt"));
    } catch (error) {
      return {
        status: (error as { status?: number }).status,
        email: session.email,
        expired: session.expired,
      };
    }
    return null;
  });
  expect(result).toEqual({ status: 401, email: null, expired: true });
});

for (const bytes of [32, 1024 * 1024]) {
  test(`a late unauthorized upload of ${bytes} bytes cannot expire a newer login`, async ({
    page,
  }) => {
    await fixture(page);
    let finish!: () => Promise<void>;
    await page.route(
      "**/admin/api/upload-test",
      (route) =>
        new Promise<void>((resolve) => {
          finish = async () => {
            await route.fulfill({ status: 401, body: "x".repeat(bytes) });
            resolve();
          };
        }),
    );
    await page.goto("/admin/storage/documents");
    await page.evaluate(async () => {
      const { uploadFile } = (await import(
        new URL("/admin/src/lib/transport/api.ts", location.href).href
      )) as typeof ApiModule;
      Object.assign(window, {
        oldUpload: uploadFile("/upload-test", new File(["test"], "test.txt")).catch(() => null),
      });
    });
    await expect.poll(() => typeof finish).toBe("function");
    await page.evaluate(async () => {
      const { api } = (await import(
        new URL("/admin/src/lib/transport/api.ts", location.href).href
      )) as typeof ApiModule;
      const { session } = (await import(
        new URL("/admin/src/lib/resources/session.svelte.ts", location.href).href
      )) as typeof SessionModule;
      const me = await api.post<{ email: string }>("/login");
      session.email = me.email;
      session.expired = false;
    });
    await finish();
    const result = await page.evaluate(async () => {
      await window.oldUpload;
      const { session } = (await import(
        new URL("/admin/src/lib/resources/session.svelte.ts", location.href).href
      )) as typeof SessionModule;
      return { email: session.email, expired: session.expired };
    });
    expect(result).toEqual({ email: "admin@example.test", expired: false });
  });
}

async function probeOversizedReply(declared: boolean) {
  // Browser callbacks cannot capture imports from the test runner.
  const { upload } = (await import(
    new URL("/admin/src/lib/transport/upload.ts", location.href).href
  )) as typeof UploadModule;
  const descriptor = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText");
  if (descriptor === undefined) throw new TypeError("Missing property descriptor");
  // oxlint-disable-next-line typescript/unbound-method -- Instrumentation explicitly invokes this saved method with .call(this).
  const getHeader = XMLHttpRequest.prototype.getResponseHeader;
  let textReads = 0,
    parsed = 0;
  Object.defineProperty(XMLHttpRequest.prototype, "responseText", {
    ...descriptor,
    get() {
      textReads++;
      // oxlint-disable-next-line typescript/unbound-method -- Instrumentation explicitly invokes this saved method with .call(this).
      const getter = descriptor.get;
      if (getter === undefined) throw new TypeError("Missing property descriptor");
      const text: unknown = getter.call(this);
      if (typeof text !== "string") throw new TypeError("Expected an XHR response string");
      return text;
    },
  });
  if (declared === false)
    XMLHttpRequest.prototype.getResponseHeader = function (name) {
      return name.toLowerCase() === "content-length" ? null : getHeader.call(this, name);
    };
  try {
    await upload("/upload-test", new File(["test"], "test.txt"), {
      parse: () => {
        return new Promise((resolve) => {
          parsed++;
          resolve({});
        });
      },
    });
    return { parsed, textReads, status: 200, code: "" };
  } catch (error) {
    const reply = error as { status?: number; code?: string };
    return { parsed, textReads, status: reply.status, code: reply.code };
  } finally {
    Object.defineProperty(XMLHttpRequest.prototype, "responseText", descriptor);
    XMLHttpRequest.prototype.getResponseHeader = getHeader;
  }
}
