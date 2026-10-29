// Display of values in the grid. Display only: editing, export and the
// tooltip keep the exact text Postgres returned.

import { dateTimeFormat } from "$lib/formatting/intl";
import { intlLocale } from "$lib/i18n/index.svelte";

import { canonicalType } from "./rows/grid";

export interface CellDisplay {
  text: string;
  /** Original value, for the tooltip (`null` when it equals the displayed one). */
  raw: string | null;
}

/** `2026-10-06T22:26:15.177028` → parts, without any time zone conversion. */
const WALL_CLOCK = /^(\d{4,6})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?)?$/;

/**
 * Dates in the viewer's language. `timestamptz` goes to the viewer's time
 * zone (it is an instant); `timestamp` and `date` stay as stored (they have
 * no time zone). A value that is not recognised is shown as it came.
 */
export function formatCell(
  value: string,
  inputType: string,
  options: { timeZone?: string; locale?: string } = {},
): CellDisplay {
  const locale = options.locale ?? intlLocale();
  const type = canonicalType(inputType);
  if (type === "timestamp with time zone") return formatInstant(value, locale, options.timeZone);
  if (type === "timestamp without time zone" || type === "date")
    return formatWallClock(value, locale, type === "date");
  return { text: value, raw: null };
}

function formatInstant(value: string, locale: string, timeZone: string | undefined): CellDisplay {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return { text: value, raw: null };
  const text = dateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone,
  }).format(instant);
  return { text, raw: value };
}

function formatWallClock(value: string, locale: string, date: boolean): CellDisplay {
  const m = WALL_CLOCK.exec(value);
  if (m == null) return { text: value, raw: null };
  const [, year, month, day, hour, minute, second] = m;
  // Formatted in UTC from the stored parts, so no conversion happens.
  const parts = [
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0),
  ] as const;
  if (parts[0] === 0) return { text: value, raw: null };
  // Date.UTC maps years 0–99 to 1900–1999. Set the literal full year and
  // reject normalized overflows instead of displaying a different date.
  const wallClock = new Date(0);
  wallClock.setUTCFullYear(parts[0], parts[1], parts[2]);
  const [, , , clockHour, clockMinute, clockSecond] = parts;
  wallClock.setUTCHours(clockHour, clockMinute, clockSecond, 0);
  const actual = [
    wallClock.getUTCFullYear(),
    wallClock.getUTCMonth(),
    wallClock.getUTCDate(),
    wallClock.getUTCHours(),
    wallClock.getUTCMinutes(),
    wallClock.getUTCSeconds(),
  ];
  if (actual.some((part, index) => part !== parts[index])) return { text: value, raw: null };
  const dateOnly = date || hour === undefined;
  const text = dateTimeFormat(locale, {
    dateStyle: "short",
    ...(dateOnly ? {} : { timeStyle: "medium" }),
    timeZone: "UTC",
  }).format(wallClock);
  return { text, raw: value };
}
