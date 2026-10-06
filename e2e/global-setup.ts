import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * Fail fast with an actionable message when `dist/` has not been built.
 *
 * package.json is intentionally untouched, so `npm run test:e2e` cannot chain a
 * build itself. Run `npm run build` first; this guard makes the ordering
 * explicit rather than letting `vite preview` serve a stale/missing artifact.
 */
export default function globalSetup(): void {
  const dist = path.resolve(process.cwd(), 'dist')
  const index = path.join(dist, 'index.html')
  const serviceWorker = path.join(dist, 'sw.js')

  if (!existsSync(index) || !existsSync(serviceWorker)) {
    throw new Error(
      `[e2e] Production build missing (looked for ${index} and ${serviceWorker}). ` +
        'Run `npm run build` before `npm run test:e2e`.',
    )
  }
}
