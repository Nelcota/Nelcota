import { i18n, translate } from "$lib/i18n/index.svelte";

import { ControllerError } from "../../updates/controller";
import type { Operation } from "../controller";
export const hostText = (key: string) => {
  const value = translate(i18n.locale, `host.${key}`);
  if (value !== `host.${key}`) return value;
  const server = translate(i18n.locale, `server.${key}`);
  return server === `server.${key}` ? value : server;
};
export const serverText = (key: string) => translate(i18n.locale, `server.${key}`);
export function label(value: string) {
  const translated = hostText(value);
  return translated === `host.${value}` ? hostText("unknown") : translated;
}
export function steps(op: Operation): string[] {
  if (op.kind === "create")
    return [
      "accepted",
      "validating",
      "provisioning",
      "starting",
      "applying",
      "verifying",
      "completed",
    ];
  if (["configure", "restart"].includes(op.kind))
    return ["accepted", "validating", "applying", "starting", "verifying", "completed"];
  if (["test_smtp", "test_backup", "test_alerts"].includes(op.kind))
    return ["accepted", "validating", "applying", "verifying", "completed"];
  return [
    "accepted",
    "validating",
    "backing_up",
    ...(op.kind === "backup" ? [] : ["applying"]),
    "verifying",
    "completed",
  ];
}
/** Uses a controller detail only when a matching translation exists. */
export function previewFailure(error: unknown): string {
  if (error instanceof ControllerError) {
    const detail = serverText(error.code);
    if (detail !== "" && detail !== `server.${error.code}`) return detail;
  }
  return hostText("error");
}
