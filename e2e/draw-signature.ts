import type { Locator, Page } from "@playwright/test"

/** Dibuja una firma con el mouse sobre el recuadro, como lo haría una persona. */
export async function drawSignature(page: Page, pad: Locator): Promise<void> {
  await pad.scrollIntoViewIfNeeded()
  const box = await pad.boundingBox()
  if (!box) throw new Error("El recuadro de la firma no está en pantalla")
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.6)
  await page.mouse.down()
  for (const [x, y] of [[0.25, 0.2], [0.35, 0.8], [0.5, 0.25], [0.65, 0.75], [0.8, 0.4]] as const) {
    await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 6 })
  }
  await page.mouse.up()
}
