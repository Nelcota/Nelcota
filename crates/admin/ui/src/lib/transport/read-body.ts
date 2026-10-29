/** Reads a byte budget, even when the declared content length is missing or stale. */
export async function readBody(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Blob | null> {
  signal?.throwIfAborted();
  const body = response.body;
  if (body == null) return new Blob();
  if (exceedsDeclaredBudget(response.headers.get("content-length"), limit)) {
    // A tee branch or custom source can keep cleanup pending indefinitely.
    void body.cancel().catch(() => {});
    return null;
  }

  const reader = body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await readChunks(reader, {
      limit,
      signal,
      type: response.headers.get("content-type") ?? "",
    });
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

async function readChunks(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>,
  { limit, signal, type }: { limit: number; signal?: AbortSignal | undefined; type: string },
): Promise<Blob | null> {
  const chunks: BlobPart[] = [];
  let bytes = 0;
  signal?.throwIfAborted();
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- Read one chunk at a time so the byte budget can stop the stream before another read.
    const { done, value } = await reader.read();
    signal?.throwIfAborted();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type });
}

function exceedsDeclaredBudget(length: string | null, limit: number): boolean {
  const declared = length?.trim();
  return declared != null && declared !== "" && /^\d+$/.test(declared) && Number(declared) > limit;
}
