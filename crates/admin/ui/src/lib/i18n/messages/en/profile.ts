// Profile photo dialog.
import type { Messages } from '../../index.svelte'
import type ptBR from '../pt-BR/profile'

const en: Messages<typeof ptBR> = {
  title: 'Profile photo',
  description: 'Frame your photo with crop, zoom and rotation. Preview changes before saving.',
  reading: 'Reading the image…',
  pick: 'Click to choose or drop an image here',
  remove: 'Remove photo',
  notAnImage: 'Choose an image file.',
  unreadable: 'Could not read that image. Try PNG, JPEG or WebP.',
  saved: 'Photo updated',
  framing: 'Photo framing',
  dragHint: 'Drag to position. Pinch to zoom. Use arrow keys to move, or Enter to centre.',
  preview: 'Live preview',
  previewLarge: 'Large avatar preview',
  previewMenu: 'Account menu preview',
  previewSmall: 'Small avatar preview',
  zoom: 'Zoom',
  rotate: 'Rotate 90°',
  reset: 'Reset',
  chooseAnother: 'Choose another photo',
  retained: 'Your source image and framing are saved privately so you can edit again later. Removing the photo deletes both.',
  tooLarge: 'Choose an image smaller than {max_mb} MB.',
  tooManyPixels: 'Choose an image no larger than 40 megapixels.',
  removed: 'Photo removed',
}

export default en
