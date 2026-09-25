import type { Page } from "@playwright/test"

/**
 * React hidratado: la fibra existe en la raíz o en un hijo directo y sobrevive
 * a una posible recarga (vite a veces recarga la página tras reoptimizar).
 */
export const hasFiber = () => {
  for (const el of [document.documentElement, document.body, ...document.body.children]) {
    if (el && Object.keys(el).some((key) => key.startsWith("__reactFiber"))) return true
  }
  return false
}

/**
 * Espera hidratación estable. Acotada: si la carga perdió módulos (vite dev
 * vuelve 502 en /@fs mientras reoptimiza dependencias) la página nunca hidrata
 * y hay que reintentar la navegación — `gotoHydrated` lo hace.
 */
export async function waitForHydration(page: Page) {
  const deadline = Date.now() + 120_000
  for (;;) {
    await page.waitForFunction(hasFiber, null, { timeout: 60_000 })
    await page.waitForTimeout(1_500)
    const stable = await page.evaluate(hasFiber).catch(() => false)
    if (stable) return
    if (Date.now() > deadline) throw new Error(`Sin hidratación estable en ${page.url()}`)
  }
}

/**
 * Navega y garantiza hidratación: si la carga no hidrata (módulos perdidos por
 * la reoptimización de vite en frío, handshake TLS caído), reintenta la
 * navegación en vez de esperar indefinidamente una página muerta.
 */
export async function gotoHydrated(page: Page, path: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto(path, { waitUntil: "domcontentloaded", timeout: 90_000 })
    const hydrated = await page
      .waitForFunction(hasFiber, null, { timeout: 60_000 })
      .then(() => true)
      .catch(() => false)
    if (hydrated) {
      await waitForHydration(page)
      return
    }
  }
  await waitForHydration(page)
}
