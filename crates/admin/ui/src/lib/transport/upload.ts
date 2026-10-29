import type Uppy from "@uppy/core";
import type { Body, Meta } from "@uppy/core";
import type { XHRUploadOptions } from "@uppy/xhr-upload";

import { httpError } from "./api-error";
import { HTTP_STATUS } from "./http-status";
import { guardUploadResponse } from "./upload-response";

const RESPONSE_BYTES = 65_536;
const responseError = (status: number) =>
  httpError(status >= HTTP_STATUS.clientErrorStart ? status : HTTP_STATUS.badGateway);

/** Uppy owns the XHR lifecycle; Nelcota owns its JSON and session contract. */
export async function upload<T>(
  path: string,
  file: File,
  {
    parse,
    progress,
  }: {
    parse: (response: Response) => Promise<T>;
    progress?: ((loaded: number, total: number) => void) | undefined;
  },
): Promise<T> {
  const [{ default: Uppy }, { default: XHRUpload }] = await Promise.all([
    import("@uppy/core"),
    import("@uppy/xhr-upload"),
  ]);
  const uppy = new Uppy<Meta, Body>({ autoProceed: false, allowMultipleUploadBatches: false });
  const state = new UploadState(parse);
  uppy.use(XHRUpload, state.options(uppy, path, file));
  const onProgress = (
    _file: unknown,
    status: { bytesUploaded?: number; bytesTotal?: number | null },
  ) => progress?.(status.bytesUploaded ?? 0, status.bytesTotal ?? file.size);
  const onError = (_file: unknown, error: unknown) => {
    state.failure ??= error;
  };
  uppy.on("upload-progress", onProgress);
  uppy.on("upload-error", onError);
  try {
    uppy.addFile({ name: file.name, type: file.type, data: file });
    const outcome = await uppy.upload();
    if (state.failure instanceof Error) throw state.failure;
    if (state.failure != null) throw new Error("Upload failed", { cause: state.failure });
    const successful = outcome?.successful;
    if (successful === undefined || successful.length === 0) throw new Error("Upload failed");
    progress?.(file.size, file.size);
    return state.result;
  } catch (error) {
    throw state.failure ?? error;
  } finally {
    state.responseCleanup();
    // Uppy can retain itself briefly through its notification timers after
    // destroy. Remove our listeners so those timers cannot retain the File.
    uppy.off("upload-progress", onProgress);
    uppy.off("upload-error", onError);
    uppy.destroy();
  }
}

function uploadResponse(xhr: XMLHttpRequest): Response {
  const received: unknown = xhr.response;
  if (received !== null && received instanceof Blob === false)
    throw new TypeError("Expected a binary upload response");
  // Progress events can be coalesced or count compressed transfer bytes.
  if (received !== null && received.size > RESPONSE_BYTES) throw responseError(xhr.status);
  const empty = [HTTP_STATUS.noContent, HTTP_STATUS.resetContent, HTTP_STATUS.notModified].some(
    (candidate) => candidate === xhr.status,
  );
  return new Response(empty ? null : received, { status: xhr.status });
}
class UploadState<T> {
  result!: T;
  failure: unknown;
  responseCleanup = () => {};
  constructor(private readonly parse: (response: Response) => Promise<T>) {}
  options(uppy: Uppy<Meta, Body>, path: string, file: File): XHRUploadOptions<Meta, Body> {
    return {
      endpoint: `/admin/api${path}`,
      method: "POST",
      formData: false,
      withCredentials: true,
      headers: { "content-type": file.type === "" ? "application/octet-stream" : file.type },
      // Blob reception avoids allocating an unbounded JavaScript responseText.
      responseType: "blob",
      onBeforeRequest: (xhr: XMLHttpRequest) => {
        this.responseCleanup = guardUploadResponse(xhr, RESPONSE_BYTES, () => {
          this.failure = responseError(xhr.status);
          // Uppy owns the abort signal; aborting XHR alone leaves its promise pending.
          uppy.cancelAll();
        });
      },
      // POST can commit before a connection fails. A retry must remain an
      // explicit action so an ambiguous upload never overwrites an object.
      shouldRetry: () => false,
      onAfterResponse: async (xhr: XMLHttpRequest) => {
        this.result = await this.parse(uploadResponse(xhr));
      },
      getResponseData: () => ({}),
    };
  }
}
