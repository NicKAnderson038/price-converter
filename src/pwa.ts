/// <reference types="vite-plugin-pwa/client" />
import { registerSW } from 'virtual:pwa-register'

/**
 * Register the generated service worker (vite-plugin-pwa, autoUpdate).
 *
 * Safe to call unconditionally at startup: this is a no-op when service
 * workers are unavailable, and registration failures never propagate to the
 * app. `virtual:pwa-register` is a no-op in dev and a real registration in a
 * production build.
 */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  try {
    registerSW({ immediate: true })
  } catch (error) {
    // Service worker support is an enhancement; never break startup over it.
    console.warn('[pwa] service worker registration failed', error)
  }
}

export default registerServiceWorker
