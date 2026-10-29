import { expect, it } from "vitest";

import { formatCell } from "./format";

const ptBR = { locale: "pt-BR" };

it.each(["0001-01-02", "0099-12-31"])(
  "dates in the grid: does not shift the stored year %s into the twentieth century",
  (raw) => {
    const instant = new Date(`${raw}T00:00:00Z`);
    const expected = new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeZone: "UTC",
    }).format(instant);
    expect(formatCell(raw, "date", ptBR)).toEqual({ text: expected, raw });
  },
);

it.each(["2026-02-29", "2026-01-01 trailing text", "0001-01-01 BC"])(
  "dates in the grid: preserves unrecognized calendar values without normalizing %s",
  (raw) => {
    expect(formatCell(raw, "date", ptBR)).toEqual({ text: raw, raw: null });
  },
);

it("dates in the grid: timestamptz goes to the viewer's time zone, exact value in the tooltip", () => {
  const raw = "2026-10-06T22:26:15.177028+00:00";
  expect(formatCell(raw, "timestamp with time zone", { ...ptBR, timeZone: "UTC" })).toEqual({
    text: "06/10/2026, 22:26:15",
    raw,
  });
  expect(
    formatCell(raw, "timestamp with time zone", { ...ptBR, timeZone: "America/Sao_Paulo" }).text,
  ).toBe("06/10/2026, 19:26:15");
});

it("dates in the grid: timestamp without time zone stays as stored (no conversion)", () => {
  expect(formatCell("2026-10-06T22:26:15.5", "timestamp without time zone", ptBR).text).toBe(
    "06/10/2026, 22:26:15",
  );
  expect(formatCell("2026-01-02T03:04", "timestamp without time zone", ptBR).text).toBe(
    "02/01/2026, 03:04:00",
  );
});

it("dates in the grid: date in the viewer's format", () => {
  expect(formatCell("2026-10-06", "date", ptBR)).toEqual({
    text: "06/10/2026",
    raw: "2026-10-06",
  });
  expect(formatCell("2026-10-06", "date", { locale: "en" }).text).toBe("10/6/26");
});

it("dates in the grid: follows the language without shifting the stored time", () => {
  expect(
    formatCell("2026-10-06T22:26:15", "timestamp without time zone", { locale: "en" }).text,
  ).toBe("10/6/26, 10:26:15 PM");
});

it("dates in the grid: reads the short type names too (timestamptz, timestamp)", () => {
  const raw = "2026-10-08T10:30:00Z";
  expect(formatCell(raw, "timestamptz", { ...ptBR, timeZone: "UTC" })).toEqual({
    text: "08/10/2026, 10:30:00",
    raw,
  });
  expect(formatCell("2026-10-08T10:30:00", "timestamp", ptBR).text).toBe("08/10/2026, 10:30:00");
});

it("dates in the grid: unknown value or another type is shown as it came", () => {
  expect(formatCell("infinity", "timestamp with time zone")).toEqual({
    text: "infinity",
    raw: null,
  });
  expect(formatCell("infinity", "date")).toEqual({ text: "infinity", raw: null });
  expect(formatCell("2026-10-06", "text")).toEqual({ text: "2026-10-06", raw: null });
});
