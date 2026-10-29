import { t } from "$lib/i18n/index.svelte";
import { toast } from "svelte-sonner";

/** Report success only after the browser has accepted the copy. */
export async function copyText(value: string, message = t("common.copied")): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(message);
    return true;
  } catch {
    toast.error(t("common.copyFailed"));
    return false;
  }
}
