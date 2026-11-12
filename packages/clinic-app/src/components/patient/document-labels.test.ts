import { describe, expect, it } from "vitest"
import {
  DICOM_MAX_BYTES,
  documentDateLabel,
  formatTakenAt,
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

describe("la fecha de cada archivo", () => {
  it("una imagen dice su toma; un papel, su fecha; sin fecha propia, cuándo se subió", () => {
    expect(documentDateLabel("radiografia")).toBe("Fecha de toma")
    expect(documentDateLabel("foto_clinica")).toBe("Fecha de toma")
    expect(documentDateLabel("informe")).toBe("Fecha del documento")
    expect(documentDateLabel("")).toBe("Fecha del documento")
    const uploaded = "2026-11-12T15:00:00Z"
    expect(formatTakenAt({ category: "radiografia", capturedAt: "2019-03-03T17:00:00Z", createdAt: uploaded })).toMatch(/^Tomada /)
    expect(formatTakenAt({ category: "informe", capturedAt: "2019-03-03T17:00:00Z", createdAt: uploaded })).toMatch(/^Del /)
    expect(formatTakenAt({ category: "informe", capturedAt: null, createdAt: uploaded })).toMatch(/^Subida /)
    // Solo el día: sin una hora que nadie puso.
    expect(formatTakenAt({ category: "informe", capturedAt: "2019-03-03T17:00:00Z", createdAt: uploaded })).not.toMatch(/:/)
  })
})
