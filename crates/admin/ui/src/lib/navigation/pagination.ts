/** URL pages must be complete, non-negative integers that JavaScript can represent exactly. */
export function parsePage(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return 0
  const page = Number(value)
  if (!Number.isSafeInteger(page)) return 0
  return page
}
