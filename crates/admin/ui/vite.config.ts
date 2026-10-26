/// <reference types="vitest/config" />
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

// .env.example exports NELCOTA_API_URL empty, which is not a proxy target.
const apiTarget = process.env.NELCOTA_API_URL || 'http://127.0.0.1:8000'

// src/theme-init.js must run before the first paint, so it is a classic
// blocking script at the end of <head> (after the bundle's module script,
// which the server tests expect first). Vite only bundles module scripts, and the CSP
// forbids inline ones: emit it as a hashed file under assets/ (served as
// immutable) and point a <script> tag at it.
function themeInit(): Plugin {
  const source = readFileSync(fileURLToPath(new URL('./src/theme-init.js', import.meta.url)), 'utf8')
  const fileName = `assets/theme-init-${createHash('sha256').update(source).digest('hex').slice(0, 8)}.js`
  let base = '/'
  let dev = false
  return {
    name: 'nelcota-theme-init',
    configResolved(config) {
      base = config.base
      dev = config.command === 'serve'
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName, source })
    },
    transformIndexHtml: {
      order: 'post',
      // Only the panel; the API reference page has its own look.
      handler: (_html, ctx) => (ctx.filename.endsWith('assets/reference.html') ? [] : [{ tag: 'script', attrs: { src: `${base}${dev ? 'src/theme-init.js' : fileName}` }, injectTo: 'head' }]),
    },
  }
}

// The build goes to dist/ and is embedded in the binary (rust-embed) under /admin/.
export default defineConfig({
  base: '/admin/',
  define: { __VUE_OPTIONS_API__: false, __VUE_PROD_DEVTOOLS__: false, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false },
  plugins: [themeInit(), tailwindcss(), svelte()],
  resolve: {
    alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        reference: fileURLToPath(new URL('./assets/reference.html', import.meta.url)),
      },
    },
    // Fonts and icons as files (CSP: no data: in scripts).
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
  server: {
    // `bun run dev`: both the panel API and health checks come from Nelcota.
    // Keep Host aligned with the browser's Origin for the panel's CSRF check.
    proxy: {
      '/admin/api': { target: apiTarget, changeOrigin: false },
      '/health': { target: apiTarget, changeOrigin: false },
      '/rest/v1': { target: apiTarget, changeOrigin: false },
    },
    // Pages are lazy modules; transforming them up front keeps the first visit
    // to each page fast (the e2e tests open many pages in parallel).
    warmup: { clientFiles: ['./src/main.ts', './src/lib/shell/**/*.svelte', './src/lib/features/**/*.svelte'] },
  },
  // The default (CPUs - 1 workers) saturates dev machines when Rust tests run too.
  test: { maxWorkers: 2 },
})
