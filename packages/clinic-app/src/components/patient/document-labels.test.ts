import { describe, expect, it } from "vitest"
import {
  DICOM_MAX_BYTES,
  MAX_BYTES,
  maxBytesFor,
  unsupportedFormatMessage,
} from "./document-labels"

describe("qué archivos entran", () => {
  it("la radiografía DICOM entra hasta 30 MB; lo demás, hasta 10", () => {
    expect(maxBytesFor(new File([], "cefalometrica.dcm"))).toBe(DICOM_MAX_BYTES)
    expect(maxBytesFor(new File([], "sin-extension", { type: "application/dicom" }))).toBe(
      DICOM_MAX_BYTES,
    )
    expect(maxBytesFor(new File([], "foto.jpg", { type: "image/jpeg" }))).toBe(MAX_BYTES)
  })
  it("lo que no entra dice qué es y qué hacer", () => {
    expect(unsupportedFormatMessage("periapical.TIFF")).toMatch(/TIFF: expórtala en DICOM o en JPG/)
    expect(unsupportedFormatMessage("sensor.bmp")).toMatch(/BMP/)
    expect(unsupportedFormatMessage("IMG_0001.HEIC")).toMatch(/HEIC del iPhone/)
    expect(unsupportedFormatMessage("arcada.stl")).toMatch(/modelo del escáner/)
    expect(unsupportedFormatMessage("notas.docx")).toBe(
      "Solo se admiten JPG, PNG, WebP, PDF o DICOM.",
    )
  })
})
