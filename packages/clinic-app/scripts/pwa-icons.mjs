// Genera los íconos de la app instalada (`public/pwa/`): el isotipo de cada producto
// sobre fondo blanco, porque iOS rellena de negro lo transparente y Android recorta
// el ícono «maskable» en círculo (zona segura del 80 %). Se corre a mano al cambiar
// la marca: `pnpm --filter @odentia/clinic-app pwa-icons`.
import { readFile } from "node:fs/promises"
import sharp from "sharp"

const BRAND = new URL("../../../assets/brand/", import.meta.url)
const OUT = new URL("../public/pwa/", import.meta.url)

const PRODUCTS = [
  { name: "odentia", isotipo: "isotipo-light.svg" },
  { name: "latidia", isotipo: "latidia/isotipo-light.svg" },
  { name: "vistia", isotipo: "vistia/isotipo-light.svg" },
]

/** Tamaño del archivo y cuánto ocupa el isotipo del lado. */
const ICONS = [
  { suffix: "192", size: 192, share: 0.7 },
  { suffix: "512", size: 512, share: 0.7 },
  { suffix: "maskable-512", size: 512, share: 0.56 },
  { suffix: "apple-180", size: 180, share: 0.66 },
]

for (const product of PRODUCTS) {
  const svg = await readFile(new URL(product.isotipo, BRAND))
  for (const icon of ICONS) {
    const side = Math.round(icon.size * icon.share)
    const mark = await sharp(svg, { density: 1200 }).resize({ width: side, height: side, fit: "inside" }).png().toBuffer()
    await sharp({ create: { width: icon.size, height: icon.size, channels: 4, background: "#ffffff" } })
      .composite([{ input: mark, gravity: "center" }])
      .flatten({ background: "#ffffff" })
      .png({ compressionLevel: 9 })
      .toFile(new URL(`${product.name}-${icon.suffix}.png`, OUT).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
  }
}
