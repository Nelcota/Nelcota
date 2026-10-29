/** URL pages must be complete, non-negative integers that JavaScript can represent exactly. */
export function parsePage(value: string | null): number {
  if (value === null || /^\d+$/.test(value) === false) return 0;
  const page = Number(value);
  if (Number.isSafeInteger(page) === false) return 0;
  return page;
}

/**
 * Page to show after a page past the first came back empty (its last rows were
 * deleted, or a stale `_page` link): the last page when the total is exact,
 * otherwise the previous one. `null` keeps the page: the first page being
 * empty means the table itself is empty.
 */
export function pageAfterEmpty({
  page,
  size,
  total,
  exact,
}: {
  page: number;
  size: number;
  total: number | null;
  exact: boolean;
}): number | null {
  if (page <= 0) return null;
  if (exact && total !== null && size > 0) {
    const last = Math.max(0, Math.ceil(total / size) - 1);
    return Math.min(page - 1, last);
  }
  return page - 1;
}
