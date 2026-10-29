import { describe, expect, it } from "vitest";

import { migrationStatus, needsAction, newestFirst, type Migration } from "./timeline";

const migration = (patch: Partial<Migration>): Migration => ({
  version: 1,
  name: "initial_schema",
  applied_on: "2026-10-08T10:30:00Z",
  in_folder: true,
  from_panel: false,
  ...patch,
});

describe("migrationStatus", () => {
  it("marks a migration applied in this database and present in the folder as applied", () => {
    expect(migrationStatus(migration({}))).toBe("applied");
  });

  it("treats an unknown folder as applied, since only the database can be checked", () => {
    expect(migrationStatus(migration({ in_folder: null }))).toBe("applied");
  });

  it("flags an applied migration whose file is missing from the folder", () => {
    expect(migrationStatus(migration({ in_folder: false }))).toBe("outsideFolder");
  });

  it("flags a file that was never applied here, even if it is missing from the folder", () => {
    expect(migrationStatus(migration({ applied_on: null, in_folder: false }))).toBe("notApplied");
  });
});

describe("needsAction", () => {
  it("only asks for action when the migration is not fully applied", () => {
    expect(needsAction("applied")).toBe(false);
    expect(needsAction("notApplied")).toBe(true);
    expect(needsAction("outsideFolder")).toBe(true);
  });
});

describe("newestFirst", () => {
  it("orders by version from newest to oldest without changing the input", () => {
    const input = [
      migration({ version: 1 }),
      migration({ version: 10 }),
      migration({ version: 2 }),
    ];
    expect(newestFirst(input).map((item) => item.version)).toEqual([10, 2, 1]);
    expect(input.map((item) => item.version)).toEqual([1, 10, 2]);
  });

  it("returns an empty list when there are no migrations", () => {
    expect(newestFirst([])).toEqual([]);
  });
});
