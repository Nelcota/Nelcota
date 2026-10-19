/** Download an already-encoded document and release its object URL. */
export function downloadText(fileName: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const link = Object.assign(document.createElement('a'), { href: url, download: fileName })
  link.click()
  // The click already started the download; the URL can be released on the next tick.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
