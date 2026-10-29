import { copyText } from "$lib/browser/clipboard";
import { downloadText } from "$lib/browser/download";

import { formatBytes } from "../storage/files.js";

/** Copies only the prepared project context through the browser's explicit action. */
export function copyContext(context: string, message: string): Promise<boolean> {
  return copyText(context, message);
}
/** Downloads the same context that is displayed and copied by the panel. */
export function downloadContext(context: string): void {
  downloadText("llms.txt", context, "text/markdown;charset=utf-8");
}
/** Counts UTF-8 bytes before formatting the prepared context size. */
export function contextSizeLabel(context: string | undefined, locale: string): string {
  return context !== undefined && context !== ""
    ? formatBytes(new Blob([context]).size, locale)
    : "";
}
