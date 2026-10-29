export const id = "a".repeat(64);
export const planId = "b".repeat(64);
export const status = {
  email: "operator@example.test",
  projects: [{ name: "shop", version: "0.4.0", update_available: true }],
  jobs: [] as object[],
  release: { version: "0.5.0" },
  enabled: true,
  checking: false,
  check_error: null,
};
export const job = {
  id,
  project: "shop",
  current: "0.4.0",
  target: "0.5.0",
  phase: "preparing",
  sequence: 1,
  updated_at: 123,
  committed: false,
  error: null,
};
export { controllerPage as controller } from "./controller-page";
