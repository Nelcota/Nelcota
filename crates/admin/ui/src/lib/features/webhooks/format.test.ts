import { i18n, errorMessage } from "$lib/i18n/index.svelte";
import { ApiError } from "$lib/transport/api";
import { afterEach, expect, it } from "vitest";

import { failureLabel } from "./format";

const HTTP_CONFLICT = 409;

afterEach(() => {
  i18n.locale = "en";
});

it.each(["en", "pt-BR"] as const)("labels queue and DNS failures in %s", (locale) => {
  i18n.locale = locale;
  for (const code of ["dns_busy", "queue_full", "payload_too_large"]) {
    expect(failureLabel(code)).not.toBe(code);
  }
  const queueFull = new ApiError("queue full", HTTP_CONFLICT, { code: "webhook_queue_full" });
  expect(errorMessage(queueFull)).not.toBe("queue full");
});

it("shows an unknown failure code as sent", () => {
  expect(failureLabel("future_code")).toBe("future_code");
  expect(failureLabel(null)).toBe("");
});
