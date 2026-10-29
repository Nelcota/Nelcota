/** Reads the UTC time encoded in a standard backup filename without guessing on invalid dates. */
export function backupTime(filename: string): string | null {
  const match = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/.exec(filename);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== iso) return null;
  return date.toISOString();
}
