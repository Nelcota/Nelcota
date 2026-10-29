import { NelcotaUsageError } from "../core/client.errors.js";
import { isRecord } from "../core/json.js";

/** Runtime callers include JavaScript consumers without static input checks. */
export function requireFileBody(value: unknown): void {
  if (value == null) throw new NelcotaUsageError("A file body is required");
}

export function requireCompleteSettings(value: unknown): void {
  if (
    isRecord(value) === false ||
    typeof value["public"] !== "boolean" ||
    value["file_size_limit"] === undefined ||
    value["allowed_mime_types"] === undefined
  )
    throw new NelcotaUsageError(
      "updateBucket needs public, file_size_limit and allowed_mime_types (null clears limits)",
    );
}
