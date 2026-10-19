import type { Body, Meta } from '@uppy/core'
import { httpError } from './api-error'
import { guardUploadResponse } from './upload-response'

const RESPONSE_BYTES = 64 * 1024
const responseError = (status: number) => httpError(status >= 400 ? status : 502)

/** Uppy owns the XHR lifecycle; Nelcota owns its JSON and session contract. */
export async function upload<T>(path: string, file: File, parse: (response: Response) => Promise<T>, progress?: (loaded: number, total: number) => void): Promise<T> {
  const [{ default: Uppy }, { default: XHRUpload }] = await Promise.all([import('@uppy/core'), import('@uppy/xhr-upload')])
  const uppy = new Uppy<Meta, Body>({ autoProceed: false, allowMultipleUploadBatches: false })
  let result!: T
  let failure: unknown
  let responseCleanup = () => {}
  uppy.use(XHRUpload, {
    endpoint: `/admin/api${path}`, method: 'POST', formData: false, withCredentials: true,
    headers: { 'content-type': file.type || 'application/octet-stream' },
    // Blob reception avoids allocating an unbounded JavaScript responseText.
    responseType: 'blob',
    onBeforeRequest: xhr => {
      responseCleanup = guardUploadResponse(xhr, RESPONSE_BYTES, () => {
        failure = responseError(xhr.status)
        // Uppy owns the abort signal; aborting XHR alone leaves its promise pending.
        uppy.cancelAll()
      })
    },
    // POST can commit before a connection fails. A retry must remain an
    // explicit action so an ambiguous upload never overwrites an object.
    shouldRetry: () => false,
    onAfterResponse: async xhr => {
      const body: Blob | null = xhr.response
      // Progress events can be coalesced or count compressed transfer bytes.
      if (body && body.size > RESPONSE_BYTES) throw responseError(xhr.status)
      result = await parse(new Response([204, 205, 304].includes(xhr.status) ? null : body, { status: xhr.status }))
    },
    getResponseData: () => ({}),
  })
  const onProgress = (_file: unknown, status: { bytesUploaded?: number; bytesTotal?: number | null }) => progress?.(status.bytesUploaded ?? 0, status.bytesTotal ?? file.size)
  const onError = (_file: unknown, error: unknown) => { failure ??= error }
  uppy.on('upload-progress', onProgress)
  uppy.on('upload-error', onError)
  try {
    uppy.addFile({ name: file.name, type: file.type, data: file })
    const outcome = await uppy.upload()
    if (failure) throw failure
    if (!outcome?.successful?.length) throw new Error('Upload failed')
    progress?.(file.size, file.size)
    return result
  } catch (error) { throw failure ?? error }
  finally {
    responseCleanup()
    // Uppy can retain itself briefly through its notification timers after
    // destroy. Remove our listeners so those timers cannot retain the File.
    uppy.off('upload-progress', onProgress)
    uppy.off('upload-error', onError)
    uppy.destroy()
  }
}
