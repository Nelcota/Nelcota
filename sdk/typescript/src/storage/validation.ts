/** Minimum storage response shapes; null remains valid only in nullable fields. */
import { isRecord } from "../core/json.js";

export function item(value: unknown): boolean {
  return isRecord(value) && typeof value["id"] === "string" && value["id"].length > 0;
}

export function items(value: unknown): boolean {
  return Array.isArray(value) && value.every(item);
}

export function listing(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value["folders"]) &&
    value["folders"].every((folder: unknown) => typeof folder === "string") &&
    items(value["objects"])
  );
}
