/** Las plantillas de las guías: A4, sin datos de nadie, siempre el mismo archivo y al día en la web. */
import { readFileSync } from "node:fs"
import { PDFDocument } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { BLANK_SHEET_KEYS, BLANK_SHEETS, blankSheetBytes, isBlankSheet, renderBlankSheet } from "./blank-sheets.js"

describe("las plantillas en blanco", () => {
  it("cada una sale en A4, en dos hojas como mucho", async () => {
    for (const sheet of BLANK_SHEET_KEYS) {
      const pdf = await PDFDocument.load(await renderBlankSheet(sheet))
      expect(pdf.getPageCount(), sheet).toBeLessThanOrEqual(2)
      const { width, height } = pdf.getPage(0).getSize()
      expect([Math.round(width), Math.round(height)], sheet).toEqual([595, 842])
      expect(pdf.getTitle(), sheet).toBe(BLANK_SHEETS[sheet].title)
    }
  })

  it("el mismo código da el mismo archivo: la web y el correo mandan lo mismo", async () => {
    for (const sheet of BLANK_SHEET_KEYS) {
      const [first, second] = await Promise.all([renderBlankSheet(sheet), renderBlankSheet(sheet)])
      expect(Buffer.from(first).equals(Buffer.from(second)), sheet).toBe(true)
    }
  })

  it("los PDF de la web están al día (si cambió el dibujo: pnpm --filter @odentia/services plantillas)", async () => {
    for (const sheet of BLANK_SHEET_KEYS) {
      const published = readFileSync(new URL(`../../../apps/web/public/guias/${BLANK_SHEETS[sheet].file}`, import.meta.url))
      expect(Buffer.from(await renderBlankSheet(sheet)).equals(published), BLANK_SHEETS[sheet].file).toBe(true)
    }
  })

  it("se dibuja una vez por proceso, y solo acepta las que existen", async () => {
    expect(await blankSheetBytes("presupuesto")).toBe(await blankSheetBytes("presupuesto"))
    expect(isBlankSheet("odontograma-ninos")).toBe(true)
    expect(isBlankSheet("../secreto")).toBe(false)
    expect(isBlankSheet("constructor")).toBe(false)
  })
})
