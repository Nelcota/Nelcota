// Plain-language reading of a bucket's file access rules (D93): the policies
// on storage.objects that the panel's templates create, recognized back from
// the way Postgres prints them. Anything else is a custom rule, with its SQL
// one click away.
import type { StoragePolicy } from "$lib/contracts/types";

/** The templates the server builds (`storage_access::Template`). */
export const TEMPLATES = [
  "public_read",
  "signed_in_read",
  "signed_in_upload",
  "own_folder",
  "own_files",
] as const;
export type TemplateId = (typeof TEMPLATES)[number];

export type RuleMeaning = { kind: TemplateId } | { kind: "custom" };

/**
 * An expression without casts, parentheses, spaces or case, so the text the
 * panel sent and the text Postgres prints back compare equal.
 */
export function canonical(expression: string | null): string | null {
  if (expression === null) return null;
  return expression
    .toLowerCase()
    .replaceAll("::text", "")
    .replaceAll(/[()\s]/g, "");
}

export function describeRule(policy: StoragePolicy, bucket: string): RuleMeaning {
  if (policy.all_buckets) return { kind: "custom" };
  const command = policy.command.toLowerCase();
  const audience = ruleAudience(policy.roles);
  const using = canonical(policy.using);
  const check = canonical(policy.check);
  const inBucket = `bucket_id='${bucket}'`;
  if (command === "select" && using === inBucket && check === null) return readMeaning(audience);
  if (audience !== "signedIn") return { kind: "custom" };
  if (command === "insert" && using === null && check === inBucket)
    return { kind: "signed_in_upload" };
  if (command === "all") return ownedMeaning(using, check, inBucket);
  return { kind: "custom" };
}

/** Nobody but the panel and service_role reaches the files through the API. */
export const locked = (policies: readonly StoragePolicy[], isPublic: boolean) =>
  policies.length === 0 && isPublic === false;

type RuleAudience = "everyone" | "signedIn" | "custom";
function ruleAudience(values: readonly string[]): RuleAudience {
  const roles = values.map((role) => role.toLowerCase());
  if (roles.includes("anon") || roles.includes("public")) return "everyone";
  return roles.length === 1 && roles[0] === "authenticated" ? "signedIn" : "custom";
}
function readMeaning(audience: RuleAudience): RuleMeaning {
  if (audience === "everyone") return { kind: "public_read" };
  return audience === "signedIn" ? { kind: "signed_in_read" } : { kind: "custom" };
}
function ownedMeaning(using: string | null, check: string | null, bucket: string): RuleMeaning {
  if (using !== check) return { kind: "custom" };
  if (using === `${bucket}andstorage.foldernamename[1]=auth.uid`) return { kind: "own_folder" };
  if (using === `${bucket}andowner=auth.uid`) return { kind: "own_files" };
  return { kind: "custom" };
}
