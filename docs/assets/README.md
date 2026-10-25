# Documentation assets

The README uses the official vector wordmark from the brand kit:
`logo-dark.svg` for dark backgrounds and `logo-light.svg` for light backgrounds.
Avatar images and their generation prompts are retained branding drafts, not
the current product logo.

## Interface screenshots

`panel-{overview,table,storage,login}-{light,dark}.png` are browser captures of
the actual Svelte application in this checkout, including unreleased changes.
They use English UI text at a 1440 × 1000 viewport. API responses come from the
disposable browser-test fixtures in `crates/admin/ui/e2e/fixtures.ts`; the sample
accounts, counts, traffic and files are demonstration data, not production
measurements or evidence of a live backend validation.

Regenerate from the repository root after installing the UI dependencies and
Playwright Chromium, with no other test suite running:

```sh
cd crates/admin/ui
npx playwright test e2e/readme-screenshots.spec.ts --workers=1
```

Inspect all eight images in `crates/admin/ui/test-results/`, then copy them to
this directory from the repository root:

```sh
find crates/admin/ui/test-results -type f -name 'panel-*.png' -exec cp -t docs/assets {} +
```

The overview and table images are also bundled in panel guides. After replacing
them, rebuild the UI with `npm --prefix crates/admin/ui run build` as described
in [contributing](../../CONTRIBUTING.md).

Keep historical drafts identified by version. Use disposable project data in
new screenshots and inspect for credentials, personal data and private host
details before committing. Screenshots do not certify a release or performance.

Related: [index](../README.md) and [panel](../panel.md).
