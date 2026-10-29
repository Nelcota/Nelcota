import { copyText } from "$lib/browser/clipboard";
import { t } from "$lib/i18n/index.svelte";

import type { BucketInfo } from "../browser.svelte.js";
import { publicUrl } from "../files.js";
export type { StoredFile } from "$lib/contracts/types";

/** Copies a public file URL only while its bucket metadata is available. */
export function copyPublicFile(
  info: BucketInfo | undefined,
  bucket: string,
  name: string,
): Promise<boolean> {
  if (info == null) return Promise.resolve(false);
  return copyText(publicUrl(info.publicOrigin, bucket, name), t("storage.browser.urlCopied"));
}
/** Copies an object's complete stored name, including its folder prefix. */
export function copyFilePath(name: string): Promise<boolean> {
  return copyText(name, t("storage.browser.pathCopied"));
}
