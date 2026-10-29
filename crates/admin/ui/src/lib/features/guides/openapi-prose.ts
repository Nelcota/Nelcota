import catalog from "../../../../../../../docs/i18n/pt-BR/openapi.json";
import { requiredValue } from "../../contracts/required-value.js";
import {
  object,
  text,
  operations,
  type Json,
  type JsonObject,
  type OpenApiDocument,
} from "./openapi";

const translations: Record<string, string> = catalog;
const group = requiredValue(
  Object.keys(catalog).find((key) => key.startsWith("Group of filters")),
  "guide content",
);
const fill = (template: string, logic: string) =>
  template.replace("{}", logic.toUpperCase()).replaceAll("{logic}", logic);
function description(value: Json | undefined): Json | undefined {
  if (typeof value !== "string") return value;
  if (Object.hasOwn(translations, value)) return translations[value];
  for (const logic of ["and", "or"])
    if (value === fill(group, logic)) return fill(translations[group] ?? group, logic);
  return value;
}

function translateDescriptions(items: Json[]): void {
  for (const value of items) {
    const item = object(value);
    if ("description" in item)
      item.description = requiredValue(description(item.description), "guide content");
  }
}

function* schemaNodes(item: JsonObject): Generator<JsonObject> {
  yield item;
  for (const property of Object.values(object(item.properties)))
    yield* schemaNodes(object(property));
  if (item.items !== undefined) yield* schemaNodes(object(item.items));
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const variants = item[key];
    if (Array.isArray(variants) === false) continue;
    for (const child of variants) yield* schemaNodes(object(child));
  }
}

function* documentSchemas(definitions: JsonObject): Generator<JsonObject> {
  for (const model of Object.values(definitions)) yield* schemaNodes(object(model));
}

/** Localize generated prose for presentation; keep the downloaded contract untouched. */
export function translateOpenApi(source: OpenApiDocument, locale: string): OpenApiDocument {
  if (locale !== "pt-BR") return source;
  const doc = structuredClone(source);
  const info = object(doc.info);
  for (const key of ["title", "description"])
    if (key in info) info[key] = requiredValue(description(info[key]), "guide content");
  for (const { operation } of operations(doc)) {
    translateDescriptions(Array.isArray(operation.parameters) ? operation.parameters : []);
    translateDescriptions(Object.values(object(operation.responses)));
  }

  for (const item of documentSchemas(object(object(doc.components).schemas))) {
    const value = text(item.description);
    // Preserve user-authored comments; only the generated type suffix changes.
    if (value === "") continue;
    item.description = value.replace(
      /(^|\n\n)Postgres type: ([^\n]+)$/,
      (_, prefix: string, type: string) =>
        `${prefix}${(translations["Postgres type: {}"] ?? "Postgres type: {}").replace("{}", type)}`,
    );
  }
  return doc;
}
