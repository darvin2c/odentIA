import { describe, expect, it } from "vitest"
import { sniffFileContent } from "./file-content.js"

/** El sniffing valida bytes reales: el MIME declarado solo no basta. */
describe("sniffFileContent", () => {
  it("acepta PNG, JPG, WebP y PDF reales con su MIME", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0])
    expect(sniffFileContent(png, "image/png")).toMatchObject({ kind: "png", ext: "png" })
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(sniffFileContent(jpg, "image/jpeg")).toMatchObject({ kind: "jpeg", ext: "jpg" })
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0])
    expect(sniffFileContent(webp, "image/webp")).toMatchObject({ kind: "webp", ext: "webp" })
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0, 0, 0, 0, 0, 0, 0])
    expect(sniffFileContent(pdf, "application/pdf")).toMatchObject({ kind: "pdf", ext: "pdf" })
  })

  it("rechaza SVG/HTML con MIME de imagen y MIME cruzados", () => {
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>")
    expect(() => sniffFileContent(svg, "image/png")).toThrow(/no es válido/i)
    expect(() => sniffFileContent(svg, "image/svg+xml")).toThrow(/no es válido/i)
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>")
    expect(() => sniffFileContent(html, "image/jpeg")).toThrow(/no es válido/i)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0])
    expect(() => sniffFileContent(png, "image/jpeg")).toThrow(/no es válido/i)
    expect(() => sniffFileContent(new Uint8Array([1, 2, 3]), "image/png")).toThrow(/no es válido/i)
  })
})
