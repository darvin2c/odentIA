/** Las plantillas de las guías: A4, sin datos de nadie, siempre el mismo archivo y al día en la web. */
import { readdirSync, readFileSync } from "node:fs"
import { PDFDocument } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { guideSheetsFor } from "../products.js"
import {
  type BlankSheet,
  BLANK_SHEET_KEYS,
  BLANK_SHEETS,
  blankSheetBytes,
  DAILY_DENTAL_ICD10,
  DENTAL_GUIDE_SHEETS,
  dentalIcd10,
  renderBlankSheet,
} from "./blank-sheets.js"

describe("las plantillas en blanco", () => {
  it("cada una sale en A4, con sus hojas", async () => {
    // El odontograma de adultos con su leyenda, el consentimiento con sus firmas, el cierre de caja y
    // el plan de tratamiento, en una sola hoja; la historia clínica, en cuatro: datos y motivo,
    // antecedentes, examen con el odontograma, y diagnóstico, plan y evolución. El periodontograma,
    // apaisado: la arcada superior, la inferior con los datos del grado y la placa de O'Leary. Los
    // códigos CIE-10: los de uso diario al frente y la lista completa detrás.
    const pages: Record<BlankSheet, number> = {
      odontograma: 1,
      "odontograma-ninos": 2,
      presupuesto: 2,
      "historia-clinica": 4,
      consentimiento: 1,
      "cierre-de-caja": 1,
      "plan-de-tratamiento": 1,
      periodontograma: 3,
      "cie10-odontologia": 4,
    }
    for (const sheet of BLANK_SHEET_KEYS) {
      const pdf = await PDFDocument.load(await renderBlankSheet(sheet))
      expect(pdf.getPageCount(), sheet).toBe(pages[sheet])
      const { width, height } = pdf.getPage(0).getSize()
      const a4 = sheet === "periodontograma" ? [842, 595] : [595, 842]
      for (let page = 0; page < pdf.getPageCount(); page++) {
        const size = pdf.getPage(page).getSize()
        expect([Math.round(size.width), Math.round(size.height)], `${sheet}, hoja ${page + 1}`).toEqual(a4)
      }
      expect([Math.round(width), Math.round(height)], sheet).toEqual(a4)
      // El título que muestra Google: lo que es, con «PDF» y la marca, y el idioma para leerlo.
      expect(pdf.getTitle(), sheet).toMatch(/\(PDF\) · odentIA$/)
      expect(pdf.getTitle()?.toLowerCase(), sheet).toContain(BLANK_SHEETS[sheet].title.toLowerCase().split(" ")[0])
      expect(pdf.getSubject(), sheet).toBeTruthy()
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
      const published = readFileSync(
        new URL(`../../../../apps/web/public/guias/${BLANK_SHEETS[sheet].file}`, import.meta.url),
      )
      expect(
        Buffer.from(await renderBlankSheet(sheet)).equals(published),
        BLANK_SHEETS[sheet].file,
      ).toBe(true)
    }
  })

  it("se dibuja una vez por proceso, y solo acepta las que existen", async () => {
    expect(await blankSheetBytes("presupuesto")).toBe(await blankSheetBytes("presupuesto"))
    // Las de odentIA son las de su web; latidIA y vistIA no tienen guías.
    expect(guideSheetsFor("dental")).toBe(DENTAL_GUIDE_SHEETS)
    expect(guideSheetsFor("medical")).toBeNull()
    expect(guideSheetsFor("optical")).toBeNull()
    await expect(DENTAL_GUIDE_SHEETS.bytes("../secreto")).rejects.toThrow()
    // Las páginas que se aceptan de origen son las guías que tiene la web.
    const pages = readdirSync(new URL("../../../../apps/web/src/pages/guias/", import.meta.url))
      .filter((file) => file.endsWith(".astro") && file !== "index.astro")
      .map((file) => `/guias/${file.replace(/\.astro$/, "")}`)
    expect([...DENTAL_GUIDE_SHEETS.pages].sort()).toEqual(pages.sort())
    await expect(DENTAL_GUIDE_SHEETS.bytes("constructor")).rejects.toThrow()
  })

  it("el correo cuenta lo de la app que va con la primera plantilla que pidió", () => {
    const pitch = DENTAL_GUIDE_SHEETS.pitch
    expect(pitch(["odontograma"])).toContain("odontograma")
    expect(pitch(["presupuesto"])).toContain("presupuesto")
    expect(pitch(["historia-clinica", "odontograma"])).toContain("Clío")
    expect(pitch(["consentimiento"])).toContain("firma")
    expect(pitch(["cierre-de-caja"])).toContain("caja")
    expect(pitch(["plan-de-tratamiento"])).toContain("fase")
    expect(pitch(["periodontograma"])).toContain("periodontograma")
    expect(pitch(["cie10-odontologia"])).toContain("código")
    // Las de antes siguen igual: con el odontograma en la lista, el del odontograma.
    expect(pitch(["presupuesto", "odontograma"])).toContain("odontograma")
    expect(pitch(["constructor"])).toContain("odontograma")
  })
})

describe("los códigos CIE-10 de la odontología", () => {
  it("salen de la lista oficial del MINSA, con los de uso diario, y la web tiene los mismos", () => {
    const list = dentalIcd10()
    // Los 217 que la app marca como odontológicos, con sus categorías.
    expect(list.codes).toHaveLength(217)
    expect(list.source).toBe("Lista CIE-10 del MINSA (2024-07), códigos odontológicos")
    expect(list.daily).toEqual([...DAILY_DENTAL_ICD10])
    const byCode = new Map(list.codes.map((entry) => [entry.code, entry]))
    expect(byCode.get("K02.1")?.title).toBe("Caries de la dentina")
    expect(byCode.get("K02")?.category).toBe(true)
    // El buscador de la guía (si cambió: pnpm --filter @odentia/services plantillas).
    const web = JSON.parse(
      readFileSync(new URL("../../../../apps/web/src/lib/guides/cie10-odontologia.json", import.meta.url), "utf8"),
    )
    expect(web).toEqual(list)
  })
})
