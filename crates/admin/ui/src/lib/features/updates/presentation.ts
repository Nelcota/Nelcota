import { translate, i18n, t } from "$lib/i18n/index.svelte";
/** Localizes a known controller blocker with a safe fallback for unknown codes. */
export function blocker(code: string): string {
  const value = translate(i18n.locale, `updates.${code}`);
  return value === `updates.${code}` ? t("updates.blocked") : value;
}
/** Visible progress for forward deployment phases; recovery has its own status. */
export const progress: Record<string, number> = {
  preparing: 0,
  pausing: 1,
  capturing: 2,
  backup_verified: 3,
  activating: 4,
  validating: 5,
  committing: 6,
  succeeded: 7,
};
