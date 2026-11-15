/** El kit sin base: varias páginas sin perder el pie, carácter sin glifo, A4, Carta y térmica. */
import { PDFDocument } from "pdf-lib"
import { expect, it, vi } from "vitest"
import {
  type DocumentClinic,
  DocumentKit,
  documentFormat,
  printable,
  ticketFormat,
} from "./document-kit.js"

const clinic: DocumentClinic = {
  tradeName: "Clínica",
  legalName: "Clínica S.A.C.",
  fiscalDocType: "RUC",
  fiscalDocNumber: "20600000001",
  address: "Av. Uno 1",
  phone: "+51 1 555 0000",
  branchName: "Sede",
  logo: null,
  locale: "es-PE",
  timezone: "America/Lima",
  sheetSize: "A4",
  receiptWidth: "80",
}

it("varias páginas: cada una lleva su pie con su número", async () => {
  const kit = await DocumentKit.open(clinic, documentFormat(clinic), {
    title: "Largo",
    docLabel: "Largo",
    patientLabel: "Rosa",
  })
  for (let i = 0; i < 400; i++) kit.text(`Línea ${i}`)
  const bytes = await kit.finish()
  const pages = (await PDFDocument.load(bytes)).getPageCount()
  expect(pages).toBeGreaterThan(2)
  expect(kit.footers).toHaveLength(pages)
  expect(kit.footers[0]).toBe(`Largo · Rosa · Página 1 de ${pages}`)
  expect(kit.footers[pages - 1]).toBe(`Largo · Rosa · Página ${pages} de ${pages}`)
})

it("una fila más larga que una página sigue en la siguiente, sin cortar ni fallar", async () => {
  const kit = await DocumentKit.open(clinic, documentFormat(clinic), { title: "T", docLabel: "T" })
  kit.table({
    columns: [{ label: "A" }, { label: "B", width: 60 }],
    rows: [["palabra ".repeat(3000), "1"]],
  })
  const pages = (await PDFDocument.load(await kit.finish())).getPageCount()
  expect(pages).toBeGreaterThan(1)
})

it("el signo menos sale como raya de cifra, nunca como ?: «−2,00» no puede imprimirse «?2,00»", () => {
  for (const face of ["sans", "sansMedium", "sansSemi", "sansBold", "serif", "serifMedium"] as const) {
    expect(printable("−2,00 · −S/ 50", face)).toBe("‒2,00 · ‒S/ 50")
    // Lo que escribe el profesional en sus indicaciones tampoco cambia de sentido.
    expect(printable("PIO ≥ 21 mmHg, ≤ 2 mm, ≈ 3, OD → OI ← 1 ∆", face)).toBe(
      "PIO >= 21 mmHg, <= 2 mm, ~ 3, OD -> OI <- 1 Δ",
    )
  }
})

it("un emoji se quita sin dejar «?»; otra escritura sin glifo sale como ? y no falla", async () => {
  // Lo que el paciente escribe en su cuestionario llega a la copia (QA de la entrega 2, 14 nov).
  expect(printable("Hola 👍🏽 Ñandú")).toBe("Hola Ñandú")
  expect(printable("muela de atrás 🦷😬\nme duele 🙏")).toBe("muela de atrás\nme duele")
  expect(printable("Familia 👨‍👩‍👧 y 🇵🇪 bandera")).toBe("Familia y bandera")
  expect(printable("Paso 1️⃣ listo ✅")).toBe("Paso 1 listo")
  // Sin el emoji no queda un espacio antes del signo (verificador, QA de la entrega 2).
  expect(printable("muela de atrás 🦷😬. Año")).toBe("muela de atrás. Año")
  expect(printable("Tomo ácido fólico 🍼; estoy")).toBe("Tomo ácido fólico; estoy")
  expect(printable("🙏 gracias")).toBe("gracias")
  // Lo que era solo emojis no queda en blanco (revisor).
  expect(printable("👍")).toBe("(emoji)")
  expect(printable(" 🦷😬 ")).toBe("(emoji)")
  for (const face of ["sans", "sansSemi", "sansBold", "serif"] as const)
    expect(printable("Formulario largo ñandú 🦷", face)).not.toContain("?")
  expect(printable("日本")).toBe("??")
  const kit = await DocumentKit.open(
    { ...clinic, tradeName: "Clínica 👍" },
    documentFormat(clinic),
    { title: "T 👍", docLabel: "T", patientLabel: "Ana 日本" },
  )
  kit.text("Texto con 🦷 y árabe مرحبا")
  expect((await kit.finish()).byteLength).toBeGreaterThan(500)
})

it("A4 y Carta según la clínica, y el rollo térmico recortado al contenido", async () => {
  const size = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPage(0).getSize()
  const a4 = await DocumentKit.open(clinic, documentFormat(clinic), { title: "T", docLabel: "T" })
  expect((await size(await a4.finish())).width).toBeCloseTo(595.28, 1)
  const letter = await DocumentKit.open(
    { ...clinic, sheetSize: "Letter" },
    documentFormat({ ...clinic, sheetSize: "Letter" }),
    { title: "T", docLabel: "T" },
  )
  expect(await size(await letter.finish())).toEqual({ width: 612, height: 792 })
  const roll = await DocumentKit.open(clinic, ticketFormat(clinic), {
    title: "T",
    docLabel: "T",
    legalNote: "Recibo.",
  })
  roll.text("Concepto")
  const { width, height } = await size(await roll.finish())
  expect(width).toBeCloseTo((80 * 72) / 25.4, 1)
  expect(height).toBeLessThan(300)
})

it("un logo dañado no rompe el papel: salen las iniciales", async () => {
  const kit = await DocumentKit.open(
    { ...clinic, logo: { kind: "png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) } },
    documentFormat(clinic),
    {
      title: "T",
      docLabel: "T",
    },
  )
  expect((await kit.finish()).byteLength).toBeGreaterThan(500)
})

it("en el rollo angosto, lo que va bajo la raya de firmar no se pisa con lo que sigue", async () => {
  const roll = await DocumentKit.open({ ...clinic, receiptWidth: "58" }, ticketFormat({ ...clinic, receiptWidth: "58" }), {
    title: "T",
    docLabel: "T",
  })
  const startAt = roll.y
  roll.signLine("Recibí", "Fecha")
  const shortEnd = roll.y
  roll.y = startAt
  roll.signLine("Recibí conforme el importe devuelto", "Fecha")
  expect(roll.y).toBeLessThan(shortEnd)
})

it("la firma guardada conserva su proporción aunque la columna sea más ancha", async () => {
  const kit = await DocumentKit.open(clinic, documentFormat(clinic), { title: "T", docLabel: "T" })
  const draw = vi.spyOn(kit.page, "drawSvgPath")
  // Ocupa todo el recuadro de 22 × 7: una sola escala, la que cabe en el alto, sin estirarla al ancho.
  kit.penSignatures([{ heading: "Quien revoca", strokes: [[[0, 0], [1000, 1000]]], lines: [] }])
  const scale = draw.mock.calls[0]?.[1]?.scale
  expect(scale).toBeDefined()
  expect(scale! * 22).toBeCloseTo(((66 - 4) * 22) / 7, 1)
  expect(scale! * 22).toBeLessThan(kit.width)
})

it("el bloque firmado mide lo que dice, con su firma o con la línea para firmar a mano", async () => {
  const kit = await DocumentKit.open(clinic, documentFormat(clinic), { title: "T", docLabel: "T" })
  const draw = vi.spyOn(kit.page, "drawSvgPath")
  const input = { name: "Ana Torres", credential: "Cirujano dentista · COP 12345", at: "1 nov 2026, 10:20" }

  const before = kit.y
  kit.signedBlock(input)
  expect(before - kit.y).toBeCloseTo(kit.signedBlockHeight(input))
  expect(draw).not.toHaveBeenCalled()

  const signed = { ...input, strokes: [[[0, 0], [1000, 1000]]] }
  const again = kit.y
  kit.signedBlock(signed)
  expect(again - kit.y).toBeCloseTo(kit.signedBlockHeight(signed))
  expect(draw).toHaveBeenCalledTimes(1)
})

it("el bloque firmado lleva el sello con los datos de quien firma; sin quien firme, la línea de firma y sello", async () => {
  const kit = await DocumentKit.open(clinic, documentFormat(clinic), { title: "T", docLabel: "T" })
  const rectangle = vi.spyOn(kit.page, "drawRectangle")
  const signedInput = {
    name: "Dra. Ana Torres",
    credential: "Cirujano dentista · COP 12345",
    at: "1 nov 2026, 10:20",
    checkUrl: "https://clinica.test/comprobar/abc",
  }
  const lay = vi.spyOn(kit, "lay")
  kit.signedBlock(signedInput)
  const written = lay.mock.calls.map(([value]) => value)
  expect(written).toEqual(expect.arrayContaining(["Dra. Ana Torres", "Cirujano dentista", "COP 12345"]))
  // El recuadro del bloque y el del sello.
  expect(rectangle).toHaveBeenCalledTimes(2)

  rectangle.mockClear()
  lay.mockClear()
  kit.signedBlock({ ...signedInput, name: null, credential: null })
  expect(lay.mock.calls.map(([value]) => value)).toContain("Firma y sello")
  expect(rectangle).toHaveBeenCalledTimes(1)
})

it("el bloque firmado anclado abajo se queda en su hoja, con o sin QR y con cualquier texto", async () => {
  for (const checkUrl of [null, "https://clinica.test/comprobar/abc"]) {
    for (const credential of [null, "Cirujano dentista · COP 12345", `${"Especialista en endodoncia ".repeat(6)}· COP 1`]) {
      const kit = await DocumentKit.open(clinic, documentFormat(clinic), { title: "T", docLabel: "T" })
      const page = kit.page
      const input = { name: "Ana Torres", credential, at: "1 de noviembre de 2026, 10:20", checkUrl }
      kit.anchorBottom(kit.signedBlockHeight(input))
      kit.signedBlock(input)
      expect(kit.page).toBe(page)
    }
  }
})
