import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { errorRange } from "./error-marker";

const doc = Text.of(["select *", "from notess", "where id = ;"]);
const text = (r: { from: number; to: number }) => doc.sliceString(r.from, r.to);

describe("errorRange", () => {
  it("covers the word Postgres points at", () => {
    expect(text(errorRange(doc, doc.toString().indexOf("notess")))).toBe("notess");
  });

  it("marks one character for punctuation and stays inside the document", () => {
    expect(text(errorRange(doc, doc.toString().lastIndexOf(";")))).toBe(";");
    expect(errorRange(doc, 10_000).to).toBeLessThanOrEqual(doc.length);
    expect(errorRange(doc, -5).from).toBe(0);
  });
});
