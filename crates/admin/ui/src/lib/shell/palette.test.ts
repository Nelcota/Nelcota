import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handlePaletteShortcut, palette } from "./palette.svelte";

function press(init: { key: string; ctrlKey?: boolean; metaKey?: boolean }) {
  const event = { ctrlKey: false, metaKey: false, ...init, preventDefault: vi.fn() };
  handlePaletteShortcut(event as unknown as KeyboardEvent);
  return event;
}

function openDialog(present: boolean) {
  vi.stubGlobal("document", { querySelector: () => (present ? {} : null) });
}

describe("handlePaletteShortcut", () => {
  beforeEach(() => {
    palette.open = false;
    openDialog(false);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("toggles the palette with Ctrl+K or Cmd+K, in either case", () => {
    expect(press({ key: "k", ctrlKey: true }).preventDefault).toHaveBeenCalled();
    expect(palette.open).toBe(true);
    press({ key: "K", metaKey: true });
    expect(palette.open).toBe(false);
  });

  it("ignores K without a modifier and other keys with one", () => {
    expect(press({ key: "k" }).preventDefault).not.toHaveBeenCalled();
    expect(press({ key: "j", ctrlKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(palette.open).toBe(false);
  });

  it("does not open over another dialog, but still claims the shortcut", () => {
    openDialog(true);
    expect(press({ key: "k", ctrlKey: true }).preventDefault).toHaveBeenCalled();
    expect(palette.open).toBe(false);
  });

  it("closes an open palette even though it is itself a dialog", () => {
    palette.open = true;
    openDialog(true);
    press({ key: "k", ctrlKey: true });
    expect(palette.open).toBe(false);
  });
});
