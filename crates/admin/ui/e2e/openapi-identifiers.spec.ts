import { expect, test } from '@playwright/test'
import { fixture } from './fixtures'

test('OpenAPI presentation retains schema and property names inherited by plain objects', async ({ page }) => {
  await fixture(page)
  const document = JSON.parse('{"openapi":"3.0.3","info":{"title":"Fixture","version":"1"},"paths":{"/records":{"get":{"responses":{"200":{"description":"Rows"}}}}},"components":{"schemas":{"__proto__":{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"}}}}}}')
  await page.route('**/rest/v1/', route => route.fulfill({ json: document }))
  // Observe the exact document delivered to the same-origin frame. Scalar
  // rendering is covered separately; this receiver isolates the transport.
  await page.route('**/admin/assets/reference.html', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><body><script>addEventListener("message",event=>{if(event.origin===location.origin&&event.data.type==="nelcota:openapi")document.body.textContent=JSON.stringify(event.data.document.components.schemas)})</script>',
  }))
  await page.goto('/admin/guides/openapi')
  await expect(page.frameLocator('iframe').locator('body')).toHaveText(JSON.stringify(document.components.schemas))
})
