import { afterEach, describe, expect, it, vi } from "vitest";

import { promiseResult } from "../../contracts/promise-result.js";
import { requiredValue } from "../../contracts/required-value.js";
import {
  base64Bytes,
  cropGeometry,
  DEFAULT_CROP,
  moveCrop,
  parseDataUrl,
  prepareSource,
  rotateCrop,
} from "./avatar";

afterEach(() => vi.unstubAllGlobals());

it.each([0, 90, 180, 270])(
  "editable framing: keeps the entire crop inside a rectangular source at %i degrees",
  (rotation) => {
    for (const zoom of [1, 2, 4]) {
      for (const [x, y] of [
        [-20, 20],
        [20, -20],
      ]) {
        const result = cropGeometry(600, 200, {
          x: requiredValue(x, "test fixture item"),
          y: requiredValue(y, "test fixture item"),
          zoom,
          rotation,
        });
        expect(result.crop.x * result.width - result.size / 2).toBeGreaterThanOrEqual(0);
        expect(result.crop.x * result.width + result.size / 2).toBeLessThanOrEqual(result.width);
        expect(result.crop.y * result.height - result.size / 2).toBeGreaterThanOrEqual(0);
        expect(result.crop.y * result.height + result.size / 2).toBeLessThanOrEqual(result.height);
      }
    }
  },
);

it("editable framing: moves the same visible distance at different zoom levels", () => {
  const dimensions = { width: 400, height: 200 };
  expect(moveCrop(dimensions, { ...DEFAULT_CROP }, { dx: 0.1, dy: 0 })).toMatchObject({
    x: 0.45,
    y: 0.5,
  });
  expect(moveCrop(dimensions, { ...DEFAULT_CROP, zoom: 2 }, { dx: 0.1, dy: 0.1 })).toMatchObject({
    x: 0.475,
    y: 0.45,
  });
});

it("editable framing: retains an off-centre subject across rotation and four turns", () => {
  const dimensions = { width: 400, height: 200 };
  const initial = { ...DEFAULT_CROP, x: 0.75, zoom: 2 };
  let crop = rotateCrop(dimensions, initial);
  expect(crop).toEqual({ x: 0.5, y: 0.75, zoom: 2, rotation: 90 });
  for (let turn = 0; turn < 3; turn++) crop = rotateCrop(dimensions, crop);
  expect(crop).toEqual(initial);
});

it("editable framing: bounds invalid numbers and unsupported rotations before rendering", () => {
  expect(cropGeometry(400, 200, { x: NaN, y: Infinity, zoom: NaN, rotation: 45 }).crop).toEqual(
    DEFAULT_CROP,
  );
  expect(cropGeometry(400, 200, { ...DEFAULT_CROP, zoom: 20 }).crop.zoom).toBe(4);
});

it("editable framing: closes a decoded image rejected for excessive dimensions", async () => {
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", () =>
    promiseResult(() => ({ width: 10_000, height: 10_000, close })),
  );
  await expect(prepareSource(new Blob(["image"]))).rejects.toThrow("Image dimensions too large");
  expect(close).toHaveBeenCalledOnce();
});

describe("base64Bytes", () => {
  it("discounts the padding", () => {
    expect(base64Bytes(btoa("abc"))).toBe(3);
    expect(base64Bytes(btoa("ab"))).toBe(2);
    expect(base64Bytes(btoa("a"))).toBe(1);
  });
});

describe("parseDataUrl", () => {
  it("splits type and data", () => {
    expect(parseDataUrl("data:image/webp;base64,UklGRg==")).toEqual({
      type: "image/webp",
      base64: "UklGRg==",
    });
  });

  it("rejects anything that is not base64", () => {
    expect(parseDataUrl("data:image/svg+xml,<svg/>")).toBeNull();
    expect(parseDataUrl("https://example.com/photo.png")).toBeNull();
  });
});
