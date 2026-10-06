# Deploying Price Converter to GitHub Pages

This app is a browser-only static site. Deployment is handled by the GitHub
Actions workflow in [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml),
which builds `dist/` and publishes it with GitHub Pages.

Everything in this document is an **external prerequisite** that neither the
source code nor the workflow can perform on its own. Complete these once, on
GitHub, before the first automated deploy.

## Prerequisites (do these on GitHub)

1. **Create the repository.** Create a GitHub repository named `price-converter`
   (the public URL will be `https://<owner>.github.io/price-converter/`). The
   app's Vite `base` is `/price-converter/`, which must match the repository
   name. Push this repository's default branch (`main`) to it.
2. **Set the Pages source.** In the repository, go to **Settings → Pages →
   Build and deployment → Source** and select **GitHub Actions**. Do not choose
   "Deploy from a branch"; the workflow supplies the artifact.
3. **Confirm the `github-pages` environment.** The deploy job targets the
   `github-pages` environment. GitHub creates it automatically on the first
   deploy; you can also pre-create it under **Settings → Environments**. If the
   repository restricts deployments, allow the `main` branch to deploy to it.
4. **Allow GitHub Actions** to run (default for public repositories) and ensure
   the workflow has not been disabled in the **Actions** tab.

No additional secrets are required. The workflow uses GitHub's built-in OIDC
token to publish, so **CI needs no AWS profile, AWS credentials, or any other
cloud secrets**. Do not add them.

## What the workflow does

On a push to `main` (or a manual **Run workflow**), `actions/checkout@v7` and
`actions/setup-node@v7` (Node 22 with npm caching) prepare the runner, then:

```
npm ci
npm run typecheck
npm run assets:ocr
npm run build
node scripts/verify-artifact.mjs
```

The verified `dist/` directory is uploaded with
`actions/upload-pages-artifact@v5` (with `include-hidden-files: true` so the
`public/.nojekyll` marker is included) and published by `actions/deploy-pages@v5`
through the `github-pages` environment. The workflow URL is taken from the deploy
step's `page_url` output.

Permissions are least-privilege: `contents: read` by default, and
`pages: write` + `id-token: write` only on the deploy job. A `pages` concurrency
group cancels an in-progress deploy when a newer run starts.

## Base path and custom domains

The Vite `base`, the web app manifest `id`/`start_url`/`scope`, and the service
worker scope are all set to `/price-converter/` in
[`vite.config.ts`](../vite.config.ts). This aligns with the repository name.

If you deploy to a different repository name, a user/organization site
(`https://<owner>.github.io/`), or a custom domain at the root, you must update
`vite.config.ts` accordingly and keep the base path, manifest fields, and
service-worker scope in sync. A mismatch produces a site that loads at the Pages
URL but requests assets from the wrong path.

## Client-side views (no server rewrites)

The app has no router: views are selected with a query parameter (`?view=settings`)
and the History API, so it stays GitHub Pages-safe without any server-side
rewrite rules.

## Runtime requirement: Frankfurter API

At runtime the browser calls `https://api.frankfurter.dev/v2/rates?base=USD`
(and `/v2/currencies`). The Pages origin
(`https://<owner>.github.io`) must be able to reach that host and the API must
return CORS headers that allow the origin. This is a provider-side property; if
it changes, live rate refresh fails and the app falls back to its saved
snapshot. Verify a live fetch from the deployed origin after the first deploy.

## Runtime requirement: OCR assets (self-hosted)

The scanner ships a self-hosted PP-OCRv3 recognition model and the
onnxruntime-web wasm runtime under `/price-converter/ocr/**` (`models/`,
`dict/`, and `ort/`). These files are **not** part of the precached shell: the
service worker serves them through a `CacheFirst` runtime route
(`ocr-assets`) and the browser fetches them on first scanner use
(**~24.98 MB total**: model 10.69 MB, ort wasm 14.24 MB, dict 26 KB). After one
online visit that opens the scanner, later scans — including offline — are
served from that cache until it is evicted.

GitHub Pages cannot send COOP/COEP, so the runtime is forced single-threaded
(`numThreads = 1`) with WASM SIMD (no cross-origin isolation needed); browsers
without WASM SIMD fall back to manual entry. There is **no third-party OCR CDN
at runtime** — every OCR byte is fetched from the same Pages origin, and the
deploy artifact includes the full `ocr/` directory.

## Manual real-device checklist (OCR)

Emulation does not replace a phone camera. On a real Android and iPhone, verify:

1. **Accuracy** — scan a few real labels/receipts (comma and dot formats) and
   confirm the detected amount; fall back to manual editing when wrong.
2. **Latency** — record time-to-first-candidate and warm recognition passes
   (method in [`docs/measurements.md`](measurements.md) §5).
3. **Cold download** — clear site data, open the scanner, and confirm the
   ~24.98 MB OCR payload loads once over the network (remote DevTools).
4. **Offline scan** — after one online visit that opened the scanner, go offline
   and confirm a scan still works from cache.

## Development-only test suite

The Playwright end-to-end suite (`npm run test:e2e`, `e2e/`) is a
**development dependency and is not part of the deployed artifact**. Its browser
binaries and configuration are excluded from `dist/` and are intentionally not
run by the deploy workflow. Run it locally against a production build with the
same `/price-converter/` base path before releasing; it does not deploy.

Manual device checks (PWA install, offline launch, camera permission, and OCR)
remain required and are described in the project blueprint (§7) and the
"Manual real-device checklist (OCR)" above.

## Action versions

The workflow pins the current, verified major tags of the official actions:

| Action | Major |
| --- | --- |
| `actions/checkout` | `v7` |
| `actions/setup-node` | `v7` |
| `actions/upload-pages-artifact` | `v5` |
| `actions/deploy-pages` | `v5` |

These majors exist as release tags on their repositories. Update them
deliberately when a new major is adopted.
