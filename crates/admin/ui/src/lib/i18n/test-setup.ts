// Vitest setup: the panel loads one language before mounting (main.ts); tests
// render and translate in both, so both catalogs are loaded up front.
import { LOCALES, loadLocale } from './index.svelte'

await Promise.all(LOCALES.map((locale) => loadLocale(locale)))
