import { expect, it } from "vitest";

import { areaPath, groupSums, monotonePath, nearestIndex, niceTicks, percent } from "./chart";

it("chart geometry: ticks end on a clean number above the maximum", () => {
  expect(niceTicks(87)).toEqual([0, 50, 100]);
  expect(niceTicks(70)).toEqual([0, 20, 40, 60, 80]);
  expect(niceTicks(4)).toEqual([0, 1, 2, 3, 4]);
  expect(niceTicks(1234)).toEqual([0, 500, 1000, 1500]);
  expect(niceTicks(0)).toEqual([0, 1]);
});

it("chart geometry: the monotone curve never overshoots between points", () => {
  const points = [
    { x: 0, y: 100 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 30, y: 50 },
  ];
  const path = monotonePath(points);
  expect(path.startsWith("M0,100C")).toBe(true);
  // Control points stay within the data's y range [0, 100].
  const ys = [...path.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));
  expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...ys)).toBeLessThanOrEqual(100);
});

it("chart geometry: an area closes down to the baseline", () => {
  expect(
    areaPath(
      [
        { x: 0, y: 5 },
        { x: 10, y: 1 },
      ],
      20,
    ),
  ).toMatch(/L10,20L0,20Z$/);
  expect(monotonePath([])).toBe("");
  expect(monotonePath([{ x: 3, y: 4 }])).toBe("M3,4");
});

it("chart geometry: finds the nearest of evenly spaced points", () => {
  expect(nearestIndex(0, { left: 0, width: 100, count: 5 })).toBe(0);
  expect(nearestIndex(60, { left: 0, width: 100, count: 5 })).toBe(2);
  expect(nearestIndex(500, { left: 0, width: 100, count: 5 })).toBe(4);
  expect(nearestIndex(-5, { left: 0, width: 100, count: 5 })).toBe(0);
});

it("chart geometry: groups and shares", () => {
  expect(groupSums([1, 2, 3, 4, 5], 2)).toEqual([3, 7, 5]);
  expect(percent(1, 3)).toBe(33);
  expect(percent(1, 0)).toBe(0);
});

it.each([NaN, Infinity, -Infinity])(
  "chart geometry: keeps invalid numbers out of chart geometry (%s)",
  (value) => {
    expect(niceTicks(value)).toEqual([0, 1]);
    expect(monotonePath([{ x: 0, y: value }])).toBe("");
    expect(monotonePath([{ x: value, y: 1 }])).toBe("");
    expect(areaPath([{ x: 0, y: 1 }], value)).toBe("");
    expect(nearestIndex(value, { left: 0, width: 100, count: 5 })).toBe(0);
    expect(nearestIndex(0, { left: value, width: 100, count: 5 })).toBe(0);
    expect(nearestIndex(0, { left: 0, width: value, count: 5 })).toBe(0);
    expect(nearestIndex(0, { left: 0, width: 100, count: value })).toBe(0);
    expect(groupSums([1, value, 3], 2)).toEqual([1, 3]);
    expect(percent(value, 10)).toBe(0);
    expect(percent(1, value)).toBe(0);
  },
);

it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
  "chart geometry: bounds tick generation for invalid count %s",
  (count) => {
    expect(niceTicks(87, count)).toEqual([0, 50, 100]);
  },
);

it.each([0, -1, 0.5, NaN, Infinity])(
  "chart geometry: does not loop with invalid group size %s",
  (size) => {
    expect(groupSums([1, 2], size)).toEqual([]);
  },
);

it("chart geometry: handles missing series and numeric overflow without invalid SVG paths", () => {
  expect(monotonePath(null)).toBe("");
  expect(areaPath(undefined, 0)).toBe("");
  expect(groupSums(null, 2)).toEqual([]);
  expect(
    monotonePath([
      { x: 0, y: 1 },
      { x: -1, y: 2 },
    ]),
  ).toBe("");
  expect(
    monotonePath([
      { x: -Number.MAX_VALUE, y: 1 },
      { x: Number.MAX_VALUE, y: 2 },
    ]),
  ).toBe("");
  expect(groupSums([Number.MAX_VALUE, Number.MAX_VALUE], 2)).toEqual([0]);
  for (const max of [Number.MIN_VALUE, 1e-300, Number.MAX_VALUE]) {
    const ticks = niceTicks(max);
    expect(ticks.length).toBeLessThanOrEqual(101);
    expect(ticks.every(Number.isFinite)).toBe(true);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(max);
  }
});
