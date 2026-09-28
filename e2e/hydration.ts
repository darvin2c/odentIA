import type { Page } from "@playwright/test"

export async function waitForHydration(page: Page): Promise<void> {
  try {
    await page.locator("html[data-hydrated='true']").waitFor({ state: "attached", timeout: 15_000 })
  } catch (cause) {
    throw new Error(`La página no hidrató: ${page.url()}`, { cause })
  }
}

export async function gotoHydrated(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: "domcontentloaded" })
  try {
    await waitForHydration(page)
  } catch (cause) {
    throw new Error(`Sin hidratación en ${page.url()} (HTTP ${response?.status() ?? "sin respuesta"})`, { cause })
  }
}
