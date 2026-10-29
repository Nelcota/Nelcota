import { expect, it, vi } from "vitest";

import { readPreview } from "./preview";

const signal = () => new AbortController().signal;

function streamed(sizes: number[], headers?: HeadersInit) {
  let reads = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const size = sizes[reads++];
        if (size === undefined) return controller.close();
        controller.enqueue(new Uint8Array(size));
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(body, { headers }), cancel, reads: () => reads };
}

it("bounded file previews: cancels an oversized declared body without reading it", async () => {
  const file = streamed([8 * 1024 * 1024], { "content-length": "8388608" });
  expect(await readPreview(file.response, 1024 * 1024, signal())).toBeNull();
  expect(file.reads()).toBe(0);
  expect(file.cancel).toHaveBeenCalledOnce();
});

it.each([undefined, { "content-length": "1" }, { "content-length": "invalid" }])(
  "bounded file previews: cancels overflow with missing, understated or invalid length %j",
  async (headers) => {
    const file = streamed([512, 512, 1, 1024, 1024], headers);
    expect(await readPreview(file.response, 1024, signal())).toBeNull();
    expect(file.reads()).toBe(3);
    expect(file.cancel).toHaveBeenCalledOnce();
  },
);

it("bounded file previews: accepts the exact budget and preserves the content type", async () => {
  const file = streamed([512, 512], {
    "content-length": "1024",
    "content-type": "application/pdf",
  });
  const blob = await readPreview(file.response, 1024, signal());
  expect(blob?.size).toBe(1024);
  expect(blob?.type).toBe("application/pdf");
  expect(file.cancel).not.toHaveBeenCalled();
});

it("bounded file previews: preserves text bytes and handles an empty response", async () => {
  const text = "Texto com acentos: prévia.";
  const blob = await readPreview(new Response(text), 1024, signal());
  expect(await blob?.text()).toBe(text);
  expect((await readPreview(new Response(null), 1024, signal()))?.size).toBe(0);
});

it("bounded file previews: cancels a pending read when the dialog aborts", async () => {
  const cancel = vi.fn();
  const abort = new AbortController();
  const response = new Response(new ReadableStream({ cancel }));
  const pending = readPreview(response, 1024, abort.signal);
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
});

it("bounded file previews: refuses an already aborted request", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(readPreview(new Response("late"), 1024, abort.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
});

it("bounded file previews: propagates a broken stream and releases its reader", async () => {
  const error = new Error("network disconnected");
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    }),
  );
  await expect(readPreview(response, 1024, signal())).rejects.toBe(error);
  expect(response.body?.locked).toBe(false);
});
