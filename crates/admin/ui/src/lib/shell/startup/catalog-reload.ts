interface ReloadTarget {
  readonly sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly location: Pick<Location, "reload">;
}
const RELOAD_KEY = "nelcota.catalogReload";

/**
 * Recover a cached module-download failure once per language before showing the fallback.
 * The marker must be stored before reloading; unavailable storage disables automatic reload.
 */
export function reloadCatalogOnce(target: ReloadTarget, locale: string): boolean {
  try {
    if (target.sessionStorage.getItem(RELOAD_KEY) === locale) return false;
    target.sessionStorage.setItem(RELOAD_KEY, locale);
    target.location.reload();
    return true;
  } catch {
    return false;
  }
}

/** A successful download permits recovery from a later, independent startup failure. */
export function clearCatalogReload(target: ReloadTarget): void {
  try {
    target.sessionStorage.removeItem(RELOAD_KEY);
  } catch {
    /* Retry bookkeeping is optional when browser storage is unavailable. */
  }
}
