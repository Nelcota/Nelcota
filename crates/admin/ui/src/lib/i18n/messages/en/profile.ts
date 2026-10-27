// Profile photo dialog.
import type { Messages } from '../../index.svelte'
import type ptBR from '../pt-BR/profile'

const en: Messages<typeof ptBR> = {
  title: 'Profile photo',
  description: "Shows in this panel's sidebar. The centre of the image becomes a circle.",
  reading: 'Reading the image…',
  pick: 'Click to choose or drop an image here',
  remove: 'Remove photo',
  notAnImage: 'Choose an image file.',
  unreadable: 'Could not read that image. Try PNG, JPEG or WebP.',
  saved: 'Photo updated',
  removed: 'Photo removed',
}

export default en
