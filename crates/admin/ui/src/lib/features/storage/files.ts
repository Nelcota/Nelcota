// Storage page helpers: sizes, folders and file URLs.

import { numberFormat } from '$lib/formatting/intl'

// Sizes are binary multiples, as everywhere else in the panel and the docs
// (the bucket limit is asked in MiB, alert thresholds in GiB).
const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const
const BYTES_PER_UNIT = 1024
const BYTES_PER_GIBIBYTE = BYTES_PER_UNIT ** 3

/** `48213` → `47.1 KiB`, in the viewer's language. */
export function formatBytes(bytes: number, locale: string): string {
  let value = bytes
  let unit = 0
  while (value >= BYTES_PER_UNIT && unit < BINARY_UNITS.length - 1) {
    value /= BYTES_PER_UNIT
    unit++
  }
  // Intl has no binary units: the number is localized, the symbol is not.
  return `${numberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${BINARY_UNITS[unit]}`
}

/** Host memory and disk, always in GiB like the alert thresholds: `8589934592` → `8.0 GiB`. */
export function formatGibibytes(bytes: number, locale: string): string {
  const value = numberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / BYTES_PER_GIBIBYTE)
  return `${value} GiB`
}

/** `'a/b/'` → `[{ name: 'a', prefix: 'a/' }, { name: 'b', prefix: 'a/b/' }]` */
export function folderTrail(prefix: string): { name: string; prefix: string }[] {
  const parts = prefix.split('/').filter(Boolean)
  return parts.map((name, i) => ({ name, prefix: parts.slice(0, i + 1).join('/') + '/' }))
}

/** Last segment of a path: `'a/b/c.png'` → `'c.png'`. */
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** Each segment percent-encoded, slashes kept. */
export const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

/** Public URL of a file in a public bucket. */
export function publicUrl(origin: string, bucket: string, name: string): string {
  return `${origin.replace(/\/$/, '')}/storage/v1/object/public/${encodeURIComponent(bucket)}/${encodePath(name)}`
}

/** `'image/*, application/pdf'` → `['image/*', 'application/pdf']` */
export function parseTypes(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
}

/** Bucket names the server accepts (and the route words it refuses). */
export function validBucketName(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(id) && !['public', 'sign', 'list'].includes(id)
}

/** Only passive formats are previewed; other files remain available for download. */
export function previewKind(mime: string, size: number): 'image' | 'pdf' | 'text' | null {
  if (size > 20 * 1024 * 1024) return null
  if (['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'].includes(mime)) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (size <= 1024 * 1024 && ['text/plain', 'text/csv', 'application/json'].includes(mime)) return 'text'
  return null
}
