import { describe, expect, it } from "vitest"
import { imageTypeCategory, sniffDocumentMime } from "./documents.js"

describe("sniffDocumentMime", () => {
  it("reconoce cada formato por su firma", () => {
    expect(sniffDocumentMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg")
    expect(sniffDocumentMime(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe("image/png")
    expect(sniffDocumentMime(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp")
    expect(sniffDocumentMime(new TextEncoder().encode("%PDF-1.7"))).toBe("application/pdf")
    const dicom = new Uint8Array(132)
    dicom.set(new TextEncoder().encode("DICM"), 128)
    expect(sniffDocumentMime(dicom)).toBe("application/dicom")
  })
  it("rechaza contenido no admitido aunque la extensión diga otra cosa", () => {
    expect(sniffDocumentMime(new TextEncoder().encode("MZ ejecutable"))).toBeNull()
    expect(sniffDocumentMime(new Uint8Array([137, 80, 78]))).toBeNull()
    expect(sniffDocumentMime(new Uint8Array())).toBeNull()
  })
  it("cada subtipo pertenece a su categoría", () => {
    expect(imageTypeCategory("panoramica")).toBe("radiografia")
    expect(imageTypeCategory("foto_intraoral")).toBe("foto_clinica")
  })
})
