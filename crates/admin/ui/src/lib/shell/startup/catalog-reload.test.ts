import { expect, it, vi } from "vitest";

import { clearCatalogReload, reloadCatalogOnce } from "./catalog-reload";

function reloadTarget() {
  const values = new Map<string, string>();
  return {
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
    location: { reload: vi.fn() },
  };
}

it("allows one reload, stops a persistent failure and resets after success", () => {
  const target = reloadTarget();
  expect(reloadCatalogOnce(target, "en")).toBe(true);
  expect(reloadCatalogOnce(target, "en")).toBe(false);
  expect(target.location.reload).toHaveBeenCalledTimes(1);
  clearCatalogReload(target);
  expect(reloadCatalogOnce(target, "en")).toBe(true);
  expect(target.location.reload).toHaveBeenCalledTimes(2);
});

it("never reloads when it cannot persist the loop guard", () => {
  const target = reloadTarget();
  vi.spyOn(target.sessionStorage, "setItem").mockImplementation(() => {
    throw new Error("Storage denied");
  });
  expect(reloadCatalogOnce(target, "pt-BR")).toBe(false);
  expect(target.location.reload).not.toHaveBeenCalled();
});

it("tolerates inaccessible storage without changing the caller's startup flow", () => {
  const target = {
    get sessionStorage(): Storage {
      throw new Error("Opaque origin");
    },
    location: { reload: vi.fn() },
  };
  expect(reloadCatalogOnce(target, "en")).toBe(false);
  expect(() => clearCatalogReload(target)).not.toThrow();
  expect(target.location.reload).not.toHaveBeenCalled();
});
