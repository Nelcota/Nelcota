/** Bound XHR reception before its completed response reaches the JSON parser. */
export function guardUploadResponse(xhr: XMLHttpRequest, limit: number, overflow: () => void): () => void {
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    cleanup()
    overflow()
  }
  const headers = () => {
    if (xhr.readyState < 2) return
    const length = xhr.getResponseHeader('content-length')?.trim()
    if (length && /^\d+$/.test(length) && Number(length) > limit) stop()
  }
  const progress = (event: ProgressEvent) => { if (event.loaded > limit) stop() }
  const cleanup = () => {
    xhr.removeEventListener('readystatechange', headers)
    xhr.removeEventListener('progress', progress)
    xhr.removeEventListener('loadend', cleanup)
  }
  xhr.addEventListener('readystatechange', headers)
  xhr.addEventListener('progress', progress)
  xhr.addEventListener('loadend', cleanup, { once: true })
  return cleanup
}
