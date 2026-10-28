import { test, expect, type Page } from '@playwright/test'
import { fixture } from './fixtures'

type Saved = { image: string; source: string; crop: { x: number; y: number; zoom: number; rotation: number } }
const imageUrl = (encoded: string) => `data:${Buffer.from(encoded, 'base64').subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : 'image/png'};base64,${encoded}`

test.use({ locale: 'en-US' })

async function setup(page: Page) {
  await fixture(page, 'en')
  const state = { saved: null as Saved | null, requests: 0, fail: false }
  await page.route('**/health', route => route.fulfill({ json: { status: 'healthy' } }))
  await page.route('**/admin/api/profile', route => route.fulfill({ json: { avatar: state.saved ? 123 : null } }))
  await page.route('**/admin/api/profile/avatar**', async route => {
    const request = route.request()
    if (request.method() === 'PUT') {
      state.requests++
      if (state.fail) { await route.fulfill({ status: 503, json: { error: 'Temporarily unavailable', code: 'unavailable' } }); return }
      state.saved = request.postDataJSON() as Saved
      await route.fulfill({ json: { avatar: 123 } })
      return
    }
    if (request.method() === 'DELETE') { state.saved = null; await route.fulfill({ json: { avatar: null } }); return }
    if (!state.saved) { await route.fulfill({ status: 404, json: { error: 'No photo', code: 'no_profile_photo' } }); return }
    if (new URL(request.url()).pathname.endsWith('/editor')) {
      await route.fulfill({ json: { source: imageUrl(state.saved.source), crop: state.saved.crop } })
      return
    }
    await route.fulfill({ contentType: imageUrl(state.saved.image).split(';')[0]!.slice(5), body: Buffer.from(state.saved.image, 'base64') })
  })
  return state
}

async function photo(page: Page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 600; canvas.height = 300
    const context = canvas.getContext('2d')!
    const gradient = context.createLinearGradient(0, 0, 600, 300)
    gradient.addColorStop(0, '#ef4444'); gradient.addColorStop(0.5, '#22c55e'); gradient.addColorStop(1, '#3b82f6')
    context.fillStyle = gradient; context.fillRect(0, 0, 600, 300)
    context.strokeStyle = '#ffffff'; context.lineWidth = 8; context.strokeRect(260, 100, 80, 100)
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  return { name: 'portrait.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') }
}

async function open(page: Page) {
  await page.getByRole('button', { name: 'Account', exact: true }).click()
  await page.getByRole('menuitem', { name: /Add photo|Change photo/ }).click()
  await expect(page.getByRole('dialog', { name: 'Profile photo', exact: true })).toBeVisible()
}

const preview = (page: Page) => page.getByRole('img', { name: 'Account menu preview', exact: true }).locator('canvas')
const pixels = (page: Page) => preview(page).evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())

async function dimensions(page: Page, encoded: string) {
  return page.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode()
    return [image.naturalWidth, image.naturalHeight]
  }, imageUrl(encoded))
}

test('live framing is saved with its full source and reopened after reload', async ({ page }) => {
  const state = await setup(page)
  await open(page)
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles(await photo(page))
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport()
  const framing = page.getByRole('button', { name: 'Photo framing', exact: true })
  await expect(framing).toBeVisible()
  const initial = await pixels(page)
  await page.getByRole('slider', { name: 'Zoom', exact: true }).press('End')
  await expect.poll(() => pixels(page)).not.toBe(initial)
  const zoomed = await pixels(page)
  await framing.press('ArrowRight')
  await expect.poll(() => pixels(page)).not.toBe(zoomed)
  const moved = await pixels(page)
  await page.getByRole('button', { name: 'Rotate 90°', exact: true }).click()
  await expect.poll(() => pixels(page)).not.toBe(moved)
  expect(state.requests).toBe(0)
  await page.screenshot({ path: '/tmp/nelcota-avatar-editor-desktop.png' })
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(state.saved!.crop).toMatchObject({ zoom: 4, rotation: 90 })
  expect(await dimensions(page, state.saved!.source)).toEqual([600, 300])
  expect(await dimensions(page, state.saved!.image)).toEqual([256, 256])
  const retained = state.saved!.source
  const framingBeforeReload = { ...state.saved!.crop }
  await page.reload()
  await open(page)
  await expect(page.getByRole('slider', { name: 'Zoom', exact: true })).toHaveValue('4')
  await page.getByRole('button', { name: 'Rotate 90°', exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(state.saved!.source).toBe(retained)
  expect(state.saved!.crop.rotation).toBe((framingBeforeReload.rotation + 90) % 360)
  expect(state.requests).toBe(2)
})

test('cancel, failed save and removal preserve the expected source lifecycle', async ({ page }) => {
  const state = await setup(page)
  await open(page)
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles(await photo(page))
  await expect(preview(page)).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(state.requests).toBe(0)
  expect(state.saved).toBeNull()
  await open(page)
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles(await photo(page))
  await page.getByRole('button', { name: 'Rotate 90°', exact: true }).click()
  state.fail = true
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => state.requests).toBe(1)
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  expect(state.saved).toBeNull()
  state.fail = false
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(state.saved!.crop.rotation).toBe(90)
  await open(page)
  await expect(preview(page)).toBeVisible()
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.getByRole('slider', { name: 'Zoom', exact: true })).toHaveValue('1')
  await page.getByRole('button', { name: 'Remove photo', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(state.saved).toBeNull()
  await open(page)
  await expect(preview(page)).toHaveCount(0)
})

test('the mobile editor supports drag, pinch and dark mode without horizontal overflow', async ({ page, context }) => {
  await setup(page)
  await page.setViewportSize({ width: 320, height: 800 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await open(page)
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles(await photo(page))
  const framing = page.getByRole('button', { name: 'Photo framing', exact: true })
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport()
  await framing.scrollIntoViewIfNeeded()
  const box = (await framing.boundingBox())!
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const client = await context.newCDPSession(page)
  const point = (id: number, offset: number) => ({ id, x: centre.x + offset, y: centre.y })
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(0, -20), point(1, 20)] })
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(0, -55), point(1, 55)] })
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect.poll(async () => Number(await page.getByRole('slider', { name: 'Zoom', exact: true }).inputValue())).toBeGreaterThan(1.5)
  const before = await pixels(page)
  await page.mouse.move(centre.x, centre.y)
  await page.mouse.down(); await page.mouse.move(centre.x + 25, centre.y + 10, { steps: 5 }); await page.mouse.up()
  await expect.poll(() => pixels(page)).not.toBe(before)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/nelcota-avatar-editor-mobile.png' })
  await client.detach()
})

for (const action of ['save', 'remove'] as const) {
  test(`a pending ${action} refreshes a reopened avatar editor`, async ({ page }) => {
    const state = await setup(page)
    await open(page)
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles(await photo(page))
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await open(page)
    await expect(page.getByRole('slider', { name: 'Zoom', exact: true })).toHaveValue('1')
    let finish: (() => Promise<void>) | undefined
    let released = false
    await page.route('**/admin/api/profile/avatar', route => {
      if (route.request().method() !== (action === 'save' ? 'PUT' : 'DELETE')) return route.fallback()
      return new Promise<void>(resolve => {
        finish = async () => {
          if (released) return
          released = true
          state.saved = action === 'save' ? route.request().postDataJSON() as Saved : null
          try { await route.fulfill({ json: { avatar: action === 'save' ? 124 : null } }) }
          finally { resolve() }
        }
      })
    })
    if (action === 'save') await page.getByRole('slider', { name: 'Zoom', exact: true }).press('End')
    await page.getByRole('button', { name: action === 'save' ? 'Save' : 'Remove photo', exact: true }).click()
    await expect.poll(() => typeof finish).toBe('function')
    try {
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await open(page)
      await expect(page.getByRole('slider', { name: 'Zoom', exact: true })).toHaveValue('1')
      await finish!()
      await expect(page.getByRole('dialog')).toBeVisible()
      if (action === 'save') await expect(page.getByRole('slider', { name: 'Zoom', exact: true })).toHaveValue('4', { timeout: 2000 })
      if (action === 'remove') await expect(page.getByRole('button', { name: 'Photo framing', exact: true })).toHaveCount(0, { timeout: 2000 })
    } finally { await finish?.() }
  })
}
