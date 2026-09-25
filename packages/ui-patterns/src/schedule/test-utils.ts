/**
 * Andamiaje compartido de las pruebas de agenda: los polyfills mínimos que
 * Base UI ScrollArea pide en jsdom (ResizeObserver, getAnimations) y el stub
 * de matchMedia para los cortes responsive. Mismo patrón que data-table.test,
 * una sola vez.
 */

import { cleanup } from "@testing-library/react"
import { afterEach, beforeAll } from "vitest"

const originalMatchMedia = window.matchMedia

export function setupScheduleDom() {
  beforeAll(() => {
    if (typeof window !== "undefined" && !window.ResizeObserver) {
      window.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof window.ResizeObserver
    }
    if (typeof Element !== "undefined" && !Element.prototype.getAnimations) {
      Element.prototype.getAnimations = () => []
    }
    if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.getAnimations) {
      HTMLElement.prototype.getAnimations = () => []
    }
  })

  afterEach(() => {
    cleanup()
    window.matchMedia = originalMatchMedia
  })
}

/** jsdom no simula anchos: fija el resultado de cada media query. */
export function stubMatchMedia(matches: (query: string) => boolean) {
  window.matchMedia = ((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
