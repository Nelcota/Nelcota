import type { ColumnInfo } from "$lib/shared/schema/ddl";
import { describe, expect, it } from "vitest";

import { guessOwnerColumn } from "./owner-column";

const column = (name: string, data_type: string, primary_key = false): ColumnInfo => ({
  name,
  data_type,
  primary_key,
  nullable: true,
  default: null,
  identity: null,
  generated: false,
  unique: null,
  references: null,
  comment: null,
});

describe("owner column", () => {
  it("prefers a uuid with a known name", () => {
    expect(
      guessOwnerColumn([
        column("id", "uuid", true),
        column("ref", "uuid"),
        column("owner", "uuid"),
      ]),
    ).toBe("owner");
  });

  it("else the first uuid that is not the PK; else user_id", () => {
    expect(guessOwnerColumn([column("id", "uuid", true), column("author", "uuid")])).toBe("author");
    expect(guessOwnerColumn([column("id", "bigint", true)])).toBe("user_id");
  });
});
