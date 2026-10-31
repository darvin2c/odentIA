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

it("un carácter sin glifo sale como ? y no falla", async () => {
  expect(printable("Hola 👍🏽 Ñandú")).toBe("Hola ? Ñandú")
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
  const draw = vi.spyOn(kit.page, "drawLine")
  kit.penSignatures([{ heading: "Quien revoca", strokes: [[[0, 0], [1000, 0]]], lines: [] }])
  const stroke = draw.mock.calls[0]?.[0]
  expect(stroke).toBeDefined()
  expect((stroke!.end.x as number) - (stroke!.start.x as number)).toBeCloseTo((66 * 22) / 7, 1)
})
