import type { AvatarCrop } from '$lib/contracts/types'

export const AVATAR_SIZE = 256
export const MAX_BYTES = 256 * 1024
export const MAX_SOURCE_BYTES = 1024 * 1024
export const MAX_INPUT_BYTES = 20 * 1024 * 1024
const MAX_PIXELS = 40_000_000
const SOURCE_SIZE = 2048
export const DEFAULT_CROP: Readonly<AvatarCrop> = { x: 0.5, y: 0.5, zoom: 1, rotation: 0 }

/** A normalized, metadata-free source retained independently of its final crop. */
export interface AvatarSource {
  image: CanvasImageSource
  width: number
  height: number
  dataUrl: string
  base64: string
}

/** Largest centred square that fits the image. */
export function centerSquare(width: number, height: number): { sx: number; sy: number; size: number } {
  const size = Math.min(width, height)
  return { sx: Math.floor((width - size) / 2), sy: Math.floor((height - size) / 2), size }
}

export function base64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length * 3) / 4 - padding
}

/** Splits a base64 data URL without decoding its image. */
export function parseDataUrl(url: string): { type: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/.exec(url)
  return match ? { type: match[1], base64: match[2] } : null
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Keeps the square crop inside the rotated source, including after zooming out. */
export function cropGeometry(width: number, height: number, input: AvatarCrop) {
  const rotation = [0, 90, 180, 270].includes(input.rotation) ? input.rotation : 0
  const zoom = Number.isFinite(input.zoom) ? clamp(input.zoom, 1, 4) : 1
  const w = rotation % 180 ? height : width
  const h = rotation % 180 ? width : height
  const size = Math.min(w, h) / zoom
  const x = clamp(Number.isFinite(input.x) ? input.x : 0.5, size / (2 * w), 1 - size / (2 * w))
  const y = clamp(Number.isFinite(input.y) ? input.y : 0.5, size / (2 * h), 1 - size / (2 * h))
  return { width: w, height: h, size, crop: { x, y, zoom, rotation } }
}

/** Rotates clockwise while keeping the same subject at the crop's centre. */
export function rotateCrop(source: Pick<AvatarSource, 'width' | 'height'>, crop: AvatarCrop): AvatarCrop {
  return cropGeometry(source.width, source.height, {
    ...crop, x: 1 - crop.y, y: crop.x, rotation: (crop.rotation + 90) % 360,
  }).crop
}

/** Converts movement in crop-viewport units into source coordinates. */
export function moveCrop(source: Pick<AvatarSource, 'width' | 'height'>, crop: AvatarCrop, dx: number, dy: number): AvatarCrop {
  const geometry = cropGeometry(source.width, source.height, crop)
  return cropGeometry(source.width, source.height, {
    ...geometry.crop,
    x: geometry.crop.x - dx * geometry.size / geometry.width,
    y: geometry.crop.y - dy * geometry.size / geometry.height,
  }).crop
}

/** Draws the same framing into the editor, live previews and saved avatar. */
export function drawAvatar(canvas: HTMLCanvasElement, source: AvatarSource, input: AvatarCrop): void {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas unavailable')
  const { width, height, size, crop } = cropGeometry(source.width, source.height, input)
  const scale = canvas.width / size
  context.resetTransform()
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.imageSmoothingQuality = 'high'
  context.translate(canvas.width / 2, canvas.height / 2)
  context.scale(scale, scale)
  context.translate(width / 2 - crop.x * width, height / 2 - crop.y * height)
  context.rotate(crop.rotation * Math.PI / 180)
  context.drawImage(source.image, -source.width / 2, -source.height / 2)
  context.resetTransform()
}

function encode(canvas: HTMLCanvasElement, limit: number) {
  for (const [type, quality] of [['image/webp', 0.92], ['image/jpeg', 0.9], ['image/jpeg', 0.75], ['image/jpeg', 0.6]] as const) {
    if (type === 'image/jpeg') {
      const context = canvas.getContext('2d')!
      context.save()
      context.globalCompositeOperation = 'destination-over'
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.restore()
    }
    const dataUrl = canvas.toDataURL(type, quality)
    const parsed = parseDataUrl(dataUrl)
    if (parsed?.type === type && base64Bytes(parsed.base64) <= limit) return { dataUrl, base64: parsed.base64 }
  }
  throw new Error('Could not shrink the image')
}

/** Bounds the source dimensions and encoded size, preserving pixels outside the crop. */
export async function prepareSource(file: Blob): Promise<AvatarSource> {
  if (file.size > MAX_INPUT_BYTES) throw new Error('Image file too large')
  const bitmap = await createImageBitmap(file)
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_PIXELS) throw new RangeError('Image dimensions too large')
    const ratio = Math.min(1, SOURCE_SIZE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio))
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas unavailable')
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return { image: canvas, width: canvas.width, height: canvas.height, ...encode(canvas, MAX_SOURCE_BYTES) }
  } finally { bitmap.close() }
}

/** Reopens the retained source without re-encoding it on every edit. */
export async function reopenSource(dataUrl: string): Promise<AvatarSource> {
  const parsed = parseDataUrl(dataUrl)
  if (!parsed || !['image/png', 'image/jpeg', 'image/webp'].includes(parsed.type) || base64Bytes(parsed.base64) > MAX_SOURCE_BYTES) throw new Error('Invalid image source')
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > MAX_PIXELS) throw new Error('Image dimensions too large')
  return { image, width: image.naturalWidth, height: image.naturalHeight, dataUrl, base64: parsed.base64 }
}

/** Encodes the live framing at the avatar's existing size and upload budget. */
export function renderAvatar(source: AvatarSource, crop: AvatarCrop) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = AVATAR_SIZE
  drawAvatar(canvas, source, crop)
  return encode(canvas, MAX_BYTES)
}
