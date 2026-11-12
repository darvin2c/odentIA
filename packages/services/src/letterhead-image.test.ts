/** La hoja que llega como imagen: el servidor la mide como el navegador y recorta sus franjas. */
import sharp from "sharp"
import { expect, it } from "vitest"
import { measureLetterheadImage } from "./letterhead-image.js"

/** Una A4 blanca a 150 ppp con un diseño oscuro arriba (de 0 a 30 mm) y una línea abajo. */
async function sheet(): Promise<Uint8Array> {
  const width = 1240
  const height = 1754
  const pxPerMm = height / 297
  const top = Math.round(30 * pxPerMm)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <rect x="100" y="40" width="${width - 200}" height="${top - 40}" fill="#333333"/>
    <rect x="100" y="${height - Math.round(12 * pxPerMm)}" width="${width - 200}" height="${Math.round(2 * pxPerMm)}" fill="#333333"/>
    <rect x="200" y="${Math.round(140 * pxPerMm)}" width="800" height="400" fill="#f4e8dc"/>
  </svg>`
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer())
}

it("mide arriba y abajo donde termina su diseño, deja lo claro debajo del texto y recorta las franjas", async () => {
  const measured = await measureLetterheadImage(await sheet())
  expect(measured.page).toEqual({ widthPt: 595.28, heightPt: 841.89 })
  // 30 mm de diseño más 7 de aire; abajo, la línea a 12 mm del borde más 7.
  expect(measured.margins.topMm).toBeGreaterThanOrEqual(36.5)
  expect(measured.margins.topMm).toBeLessThanOrEqual(37.5)
  expect(measured.margins.bottomMm).toBeGreaterThanOrEqual(18.5)
  expect(measured.margins.bottomMm).toBeLessThanOrEqual(19.5)
  // La marca de agua clara del medio no cuenta: los costados quedan en lo de siempre.
  expect(measured.margins.leftMm).toBe(19)
  const top = await sharp(measured.topBand).metadata()
  const thumbnail = await sharp(measured.thumbnail).metadata()
  expect(top.width).toBe(1240)
  expect(thumbnail.width).toBe(240)
})
