import { readText, write } from "$lib/browser/local-storage";

const KEY = "nelcota.technical";

// Access rules read in plain language by default; the technical form (RLS,
// roles, grants, SQL) appears when the person asks for it (D93). Remembered
// across pages and visits.
export const technical = $state({ on: readText(KEY, "off") === "on" });

export function toggleTechnical() {
  technical.on = technical.on === false;
  write(KEY, technical.on ? "on" : "off");
}
