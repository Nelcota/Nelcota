import { dateTimeFormat } from "./intl";

/** Missing dates have no label; malformed text stays visible without throwing from Intl. */
export function dateText(
  value: string | number | null | undefined,
  format: (date: Date) => string,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  if (Number.isFinite(date.getTime()) === false) {
    if (typeof value === "string") return value;
    return "—";
  }
  return format(date);
}

// What Date#toLocaleString shows by default: numeric date and time with seconds.
const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

/** Date and time in the viewer's language, from a cached formatter; invalid values get the dateText fallback. */
export function dateTimeText(value: string | number | null | undefined, locale: string): string {
  return dateText(value, (date) => dateTimeFormat(locale, DATE_TIME).format(date));
}
