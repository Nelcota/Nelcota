import { type Page } from "@playwright/test";

import { jsonObject } from "./request-json";

export const id = "a".repeat(64),
  digest = "b".repeat(64);
export const base = {
  email: "operator@example.test",
  host_management: true,
  projects: [],
  jobs: [],
  release: null,
  enabled: false,
  checking: false,
  check_error: null,
};
const project = {
  name: "shop",
  domain: "api.shop.test",
  version: "0.4.0",
  app: "healthy",
  database: "healthy",
  backups: ["nelcota-shop-pair.dump"],
};
export const host = {
  receipt: null as object | null,
  enabled: true,
  projects: [project],
  jobs: [] as object[],
  max_projects: 32,
  ram_mb: 8192,
  free_bytes: 10000000000,
};
export { controllerPage as mount } from "./controller-page";

export function plan(operation: unknown, confirmation: string, blockers: string[] = []) {
  return {
    id,
    operation: jsonObject(operation),
    confirmation,
    blockers,
    expires_at: Math.floor(Date.now() / 1000) + 300,
    version: "0.4.0",
    image_digest: digest,
    project_count: 1,
    ram_mb: 8192,
    free_bytes: 10000000000,
    destructive: confirmation.startsWith("RESTORE") || confirmation.startsWith("REMOVE"),
  };
}
export async function confirm(page: Page, phrase: string) {
  await page.getByLabel("Conferi o projeto, o domínio e o impacto desta operação.").check();
  await page.getByLabel("Tenho acesso SSH e compreendo como recuperar a VPS.").check();
  await page.getByLabel("Digite exatamente a confirmação abaixo").fill(phrase);
  await page.getByLabel("Confirme a senha do operador").fill("operator-test-password");
}
