import { dominantColors } from "@odentia/clinical"
import sharp from "sharp"
import { expect, it } from "vitest"
import { logoForPaper } from "./document-clinic.js"

it("el papel lleva el mismo logo que la pantalla: un WebP se embebe como PNG; lo que no es imagen, no", async () => {
  const webp = new Uint8Array(
    await sharp({ create: { width: 40, height: 20, channels: 3, background: "#0e6f86" } })
      .webp()
      .toBuffer(),
  )
  const logo = await logoForPaper(webp)
  expect(logo?.kind).toBe("png")
  expect(Array.from(logo?.bytes.slice(0, 4) ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47])
  const png = new Uint8Array(await sharp(webp).png().toBuffer())
  expect(await logoForPaper(png)).toEqual({ bytes: png, kind: "png" })
  expect(await logoForPaper(new TextEncoder().encode("<html>no soy un logo</html>"))).toBeNull()
})

it("«De tu logo» toma sus dos colores más presentes, sin el blanco del fondo ni el gris del texto", async () => {
  // Un logo de 10 × 10: fondo blanco, una mancha azul grande, una celeste más chica y un texto gris.
  const width = 10
  const pixels = new Uint8Array(width * width * 4)
  for (let i = 0; i < width * width; i++) {
    const row = Math.floor(i / width)
    const color =
      row < 2 ? [255, 255, 255] : row < 6 ? [29, 95, 168] : row < 8 ? [124, 196, 236] : row < 9 ? [100, 100, 100] : [255, 255, 255]
    pixels.set([...color, 255], i * 4)
  }
  expect(dominantColors(pixels, 4)).toEqual(["#1d5fa8", "#7cc4ec"])
  // Un logo en blanco y negro no sugiere ningún color.
  const gray = new Uint8Array(width * width * 4)
  for (let i = 0; i < width * width; i++) gray.set(i % 2 ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4)
  expect(dominantColors(gray, 4)).toEqual([])
  // Lo transparente no cuenta.
  const clear = new Uint8Array(width * width * 4).fill(0)
  expect(dominantColors(clear, 4)).toEqual([])
  // La lectura real del logo pasa por sharp: una imagen de un solo color devuelve ese color.
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 234, g: 88, b: 12, alpha: 1 } } })
    .raw()
    .toBuffer({ resolveWithObject: true })
  expect(dominantColors(png.data, png.info.channels)).toEqual(["#ea580c"])
})
