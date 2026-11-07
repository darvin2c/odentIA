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
