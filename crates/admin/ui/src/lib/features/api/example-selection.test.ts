import { expect, it } from "vitest";

import { sampleRow, tableSnippets, type SnippetColumn } from "./api-examples";
import { exampleSelection } from "./example-selection";

const column = (
  name: string,
  type = "text",
  extra: Partial<SnippetColumn> = {},
): SnippetColumn => ({
  name,
  type,
  nullable: false,
  has_default: false,
  generated: false,
  ...extra,
});
it("includes every required field even beyond the optional sample budget", () => {
  const required = Array.from({ length: 6 }, (_, index) => column(`required_${index}`));
  expect(
    Object.keys(sampleRow([...required, column("optional", "text", { nullable: true })])),
  ).toEqual(required.map((field) => field.name));
});
it("uses all UUID/text composite key parts and never updates those keys", () => {
  const fields = [column("tenant", "uuid"), column("slug"), column("body")];
  const key = ["tenant", "slug"];
  const selection = exampleSelection(fields, key);
  expect(selection?.sdk).toContain('.eq("tenant", "00000000-0000-0000-0000-000000000000")');
  expect(selection?.sdk).toContain('.eq("slug", "example")');
  const query = new URLSearchParams(selection?.query);
  expect([...query.keys()]).toEqual(key);
  expect(query.get("tenant")).toBe("eq.00000000-0000-0000-0000-000000000000");
  const update = tableSnippets("https://example.test", "notes", {
    columns: fields,
    primaryKey: key,
  }).find((item) => item.id === "update");
  expect(update?.code.ts).toContain(".update({\n    body: 'example',\n  })");
  expect(update?.code.ts).not.toContain(".eq('id'");
});
it("puts reserved key names in a logical group instead of treating them as modifiers", () => {
  const selection = exampleSelection(
    [column("limit", "integer"), column("tenant")],
    ["limit", "tenant"],
  );
  const query = new URLSearchParams(selection?.query);
  expect(query.has("limit")).toBe(false);
  expect(query.get("and")).toBe('(limit.eq."1")');
  expect(query.get("tenant")).toBe("eq.example");
});
it.each([{ key: [] }, { key: ["missing"] }, { key: ["key.part"] }])(
  "omits mutations when the complete key is unavailable (%j)",
  ({ key }) => {
    const snippets = tableSnippets("https://example.test", "notes", {
      columns: [column("body")],
      primaryKey: key,
    });
    expect(snippets.some((snippet) => snippet.id === "update" || snippet.id === "delete")).toBe(
      false,
    );
  },
);
it("does not generate an empty update for a key-only table", () => {
  const snippets = tableSnippets("https://example.test", "keys", {
    columns: [column("key")],
    primaryKey: ["key"],
  });
  expect(snippets.some((snippet) => snippet.id === "update")).toBe(false);
  expect(snippets.some((snippet) => snippet.id === "delete")).toBe(true);
});
it("uses actual enum members in inserts and selectors", () => {
  const fields = [column("status", "order_status", { enum_values: ["new", "paid"] })];
  expect(sampleRow(fields)).toEqual({ status: "new" });
  expect(exampleSelection(fields, ["status"])?.sdk).toContain('.eq("status", "new")');
});

it("does not suggest inserts into a read-only relation", () => {
  const snippets = tableSnippets("https://example.test", "view", {
    columns: [column("name")],
    insertable: false,
  });
  expect(snippets.map((snippet) => snippet.id)).toEqual(["list", "filter"]);
});
