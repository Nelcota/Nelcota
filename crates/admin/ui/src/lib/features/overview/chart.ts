// Pure geometry for the overview's charts: scales, clean ticks and a
// monotone curve (it never overshoots the data, so a count never dips below
// zero between two points).

import { requiredValue } from "../../contracts/required-value.js";
const DECIMAL_RADIX = 10;
const HALF_DECADE = 5;
const TICK_SIGNIFICANT_DIGITS = 12;
const BEZIER_CONTROL_DIVISOR = 3;
const MAX_ROUNDED_COORDINATE = 1e21;

const DEFAULT_TICK_COUNT = 4;

export interface Point {
  x: number;
  y: number;
}

/** Ticks from 0 to a clean maximum (1, 2 or 5 times a power of ten). */
export function niceTicks(max: number, count = DEFAULT_TICK_COUNT): number[] {
  if (Number.isFinite(max) === false || max <= 0) return [0, 1];
  const tickCount = usableTickCount(count);
  const raw = max / tickCount;
  const power = DECIMAL_RADIX ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, HALF_DECADE, DECIMAL_RADIX].map((m) => m * power).find((s) => s >= raw) ??
    DECIMAL_RADIX * power;
  if (Number.isFinite(step) === false || step <= 0) return [0, max];
  const intervals = Math.ceil(max / step);
  if (
    Number.isSafeInteger(intervals) === false ||
    intervals > 100 ||
    Number.isFinite(intervals * step) === false
  )
    return [0, max];
  // An index bounds the loop and avoids accumulating a step too small to advance.
  return Array.from({ length: intervals + 1 }, (_, index) =>
    Number((index * step).toPrecision(TICK_SIGNIFICANT_DIGITS)),
  );
}

function usableTickCount(count: number): number {
  return Number.isSafeInteger(count) && count >= 1 && count <= 100 ? count : DEFAULT_TICK_COUNT;
}

/** Fritsch–Carlson monotone cubic through the points (sorted by x), as SVG path commands. */
export function monotonePath(points: readonly Point[] | null | undefined): string {
  if (points?.length == null || points.length === 0) return "";
  if (
    points.some(
      (point) =>
        Boolean(point) === false ||
        Number.isFinite(point.x) === false ||
        Number.isFinite(point.y) === false,
    )
  )
    return "";
  const n = points.length;
  const first = requiredValue(points[0], "bounded operation item");
  if (n === 1) return `M${first.x},${first.y}`;
  const segments = curveSegments(points);
  if (segments === null) return "";
  const { dx, slope } = segments;
  const tangent = curveTangents(dx, slope);
  let path = `M${round(first.x)},${round(first.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = requiredValue(points[i], "bounded operation item");
    const b = requiredValue(points[i + 1], "bounded operation item");
    const h = requiredValue(dx[i], "bounded operation item") / BEZIER_CONTROL_DIVISOR;
    const controls = [
      a.x + h,
      a.y + requiredValue(tangent[i], "bounded operation item") * h,
      b.x - h,
      b.y - requiredValue(tangent[i + 1], "bounded operation item") * h,
    ];
    if (controls.some((value) => Number.isFinite(value) === false)) return "";
    path += `C${controls.map(round).join(",")},${round(b.x)},${round(b.y)}`;
  }
  return path;
}

function curveSegments(points: readonly Point[]): { dx: number[]; slope: number[] } | null {
  const n = points.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = requiredValue(points[i], "bounded operation item");
    const b = requiredValue(points[i + 1], "bounded operation item");
    const delta = b.x - a.x;
    if (Number.isFinite(delta) === false || delta < 0) return null;
    const gradient = delta === 0 ? 0 : (b.y - a.y) / delta;
    if (Number.isFinite(gradient) === false) return null;
    dx.push(delta);
    slope.push(gradient);
  }
  return { dx, slope };
}

function curveTangents(dx: readonly number[], slope: readonly number[]): number[] {
  const n = dx.length + 1;
  const tangent: number[] = [requiredValue(slope[0], "bounded operation item")];
  for (let i = 1; i < n - 1; i++) {
    const s0 = requiredValue(slope[i - 1], "bounded operation item");
    const s1 = requiredValue(slope[i], "bounded operation item");
    if (s0 * s1 <= 0) {
      tangent.push(0);
      continue;
    }
    const w0 =
      2 * requiredValue(dx[i], "bounded operation item") +
      requiredValue(dx[i - 1], "bounded operation item");
    const w1 =
      requiredValue(dx[i], "bounded operation item") +
      2 * requiredValue(dx[i - 1], "bounded operation item");
    tangent.push((w0 + w1) / (w0 / s0 + w1 / s1));
  }
  tangent.push(requiredValue(slope[n - 2], "bounded operation item"));
  return tangent;
}

/** The same curve closed down to the baseline, for an area fill. */
export function areaPath(points: readonly Point[] | null | undefined, baseline: number): string {
  if (points?.length == null || points.length === 0 || Number.isFinite(baseline) === false)
    return "";
  const path = monotonePath(points);
  if (path === "") return "";
  const first = requiredValue(points[0], "bounded operation item");
  const last = requiredValue(points.at(-1), "required operation value");
  return `${path}L${round(last.x)},${round(baseline)}L${round(first.x)},${round(baseline)}Z`;
}

/** Index of the point nearest to `x` among evenly spaced points. */
export function nearestIndex(
  x: number,
  { left, width, count }: { left: number; width: number; count: number },
): number {
  if (
    Number.isSafeInteger(count) === false ||
    count <= 1 ||
    Number.isFinite(width) === false ||
    width <= 0
  )
    return 0;
  if (Number.isFinite(x) === false || Number.isFinite(left) === false) return 0;
  const ratio = (x - left) / width;
  return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
}

/** Sums of consecutive groups of `size` values (the last group may be shorter). */
export function groupSums(values: readonly number[] | null | undefined, size: number): number[] {
  if (
    values?.length == null ||
    values.length === 0 ||
    Number.isSafeInteger(size) === false ||
    size <= 0
  )
    return [];
  const out: number[] = [];
  for (let i = 0; i < values.length; i += size) {
    const sum = values.slice(i, i + size).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    out.push(Number.isFinite(sum) ? sum : 0);
  }
  return out;
}

/** A share in whole percent, 0 when there is nothing to share. */
export function percent(part: number, whole: number): number {
  if (Number.isFinite(part) === false || Number.isFinite(whole) === false || part < 0 || whole <= 0)
    return 0;
  const share = Math.round((part / whole) * 100);
  if (Number.isFinite(share) === false) return 0;
  return share;
}

const round = (v: number) =>
  Math.abs(v) >= MAX_ROUNDED_COORDINATE ? v : Math.round(v * 100) / 100;
