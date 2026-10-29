import { expect, type Locator } from "@playwright/test";

export async function expectReadable(element: Locator): Promise<void> {
  await expect(element).toBeVisible();
  const ratio = await element.evaluate((e) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (context == null) throw new Error("Canvas unavailable for contrast measurement");
    context.fillStyle = "white";
    context.fillRect(0, 0, 1, 1);
    const parents: Element[] = [];
    for (let p: Element | null = e; p != null; p = p.parentElement) parents.unshift(p);
    for (const p of parents) {
      context.fillStyle = getComputedStyle(p).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const luminance = () => {
      const [red = 0, green = 0, blue = 0] = [...context.getImageData(0, 0, 1, 1).data]
        .slice(0, 3)
        .map((value) => {
          const c = value / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return red * 0.2126 + green * 0.7152 + blue * 0.0722;
    };
    const background = luminance();
    context.fillStyle = getComputedStyle(e).color;
    context.fillRect(0, 0, 1, 1);
    const foreground = luminance();
    return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
}
