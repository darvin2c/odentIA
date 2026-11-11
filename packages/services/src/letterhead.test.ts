/**
 * La hoja membretada (ADR 0180) sin base: lo que el servidor hace con el archivo que
 * sube la clínica, y cómo lo dibuja el kit de los papeles.
 */
import { degrees, PDFDocument, rgb } from "pdf-lib"
import sharp from "sharp"
import { expect, it } from "vitest"
import { type DocumentClinic, DocumentKit, documentFormat } from "./document-kit.js"
import { clampLetterheadMargins, letterheadKindOf, normalizeLetterhead } from "./letterhead.js"

const A4 = [595.28, 841.89] as const
const MM = 72 / 25.4

async function sheetPdf(
  size: readonly [number, number] = A4,
  options: { pages?: number; rotate?: number } = {},
) {
  const pdf = await PDFDocument.create()
  for (let index = 0; index < (options.pages ?? 1); index++) {
    const page = pdf.addPage([size[0], size[1]])
    // Arriba, su nombre; abajo, una franja de color.
    page.drawRectangle({
      x: 40,
      y: size[1] - 90,
      width: size[0] - 80,
      height: 40,
      color: rgb(0.1, 0.3, 0.5),
    })
    page.drawRectangle({ x: 0, y: 0, width: size[0], height: 60, color: rgb(0.9, 0.4, 0.1) })
    if (options.rotate) page.setRotation(degrees(options.rotate))
  }
  return pdf.save()
}

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

it("reconoce PDF, PNG y JPG por su firma, no por el nombre", async () => {
  expect(letterheadKindOf(await sheetPdf())).toBe("pdf")
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } })
    .png()
    .toBuffer()
  const jpg = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } })
    .jpeg()
    .toBuffer()
  expect(letterheadKindOf(new Uint8Array(png))).toBe("png")
  expect(letterheadKindOf(new Uint8Array(jpg))).toBe("jpg")
  expect(letterheadKindOf(new TextEncoder().encode("<svg></svg>"))).toBeNull()
})

it("un PDF de varias páginas queda en la primera, del tamaño que se ve y ya derecho", async () => {
  const several = await normalizeLetterhead(await sheetPdf(A4, { pages: 3 }))
  expect(several.pages).toBe(3)
  const doc = await PDFDocument.load(several.pdf)
  expect(doc.getPageCount()).toBe(1)
  expect(doc.getPage(0).getRotation().angle).toBe(0)
  // Girada 90° se ve apaisada: así queda, sin giro pendiente.
  const turned = await normalizeLetterhead(await sheetPdf(A4, { rotate: 90 }))
  expect(turned.widthPt).toBeCloseTo(A4[1], 1)
  expect(turned.heightPt).toBeCloseTo(A4[0], 1)
  expect((await PDFDocument.load(turned.pdf)).getPage(0).getRotation().angle).toBe(0)
})

it("una imagen va a toda la página: A4 si tiene su forma, y avisa si es chica", async () => {
  const small = await sharp({
    create: { width: 420, height: 594, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer()
  const sheet = await normalizeLetterhead(new Uint8Array(small))
  expect(sheet.widthPt).toBeCloseTo(A4[0], 1)
  expect(sheet.heightPt).toBeCloseTo(A4[1], 1)
  expect(sheet.lowResolution).toBe(true)
  const sharpEnough = await sharp({
    create: { width: 1240, height: 1754, channels: 3, background: "#fff" },
  })
    .jpeg()
    .toBuffer()
  expect((await normalizeLetterhead(new Uint8Array(sharpEnough))).lowResolution).toBe(false)
})

it("lo que no es una hoja se rechaza con su motivo, junto al archivo", async () => {
  await expect(normalizeLetterhead(new TextEncoder().encode("%PDF-roto"))).rejects.toMatchObject({
    code: "VALIDATION",
    fields: { file: expect.stringContaining("PDF") },
  })
  await expect(normalizeLetterhead(new TextEncoder().encode("hola"))).rejects.toMatchObject({
    code: "VALIDATION",
  })
})

it("dónde va el texto: al menos 5 mm del borde y siempre con lugar para escribir", () => {
  const page = { widthPt: A4[0], heightPt: A4[1] }
  expect(
    clampLetterheadMargins(page, { topMm: 50, bottomMm: 41, leftMm: 19, rightMm: 19 }),
  ).toEqual({
    topMm: 50,
    bottomMm: 41,
    leftMm: 19,
    rightMm: 19,
  })
  expect(
    clampLetterheadMargins(page, { topMm: 0, bottomMm: -3, leftMm: 1, rightMm: Number.NaN }),
  ).toEqual({
    topMm: 5,
    bottomMm: 5,
    leftMm: 5,
    rightMm: 5,
  })
  const huge = clampLetterheadMargins(page, { topMm: 150, bottomMm: 120, leftMm: 90, rightMm: 90 })
  expect(huge.topMm + huge.bottomMm).toBeLessThanOrEqual(297 * 0.6 + 0.5)
  expect(huge.leftMm + huge.rightMm).toBeLessThanOrEqual(210 * 0.5 + 0.5)
})

it("el papel lleva la hoja de fondo en cada página y el texto entre su diseño", async () => {
  const { pdf } = await normalizeLetterhead(await sheetPdf())
  const sheet = { pdf, topMm: 40, bottomMm: 30, leftMm: 25, rightMm: 20, hasContact: false }
  const kit = await DocumentKit.open({ ...clinic, sheet }, documentFormat(clinic), {
    title: "Receta",
    docLabel: "Receta",
  })
  expect(kit.hasSheet).toBe(true)
  expect(kit.left).toBeCloseTo(25 * MM, 1)
  expect(kit.right).toBeCloseTo(A4[0] - 20 * MM, 1)
  // La primera línea va debajo de su diseño de arriba (más la línea chica de sus datos).
  expect(kit.y).toBeLessThan(A4[1] - 40 * MM)
  for (let line = 0; line < 120; line++) kit.text(`Línea ${line}`)
  const bytes = await kit.finish()
  const doc = await PDFDocument.load(bytes)
  expect(doc.getPageCount()).toBeGreaterThan(1)
  // Cada página dibuja la hoja (un XObject de formulario) antes que el texto.
  for (const page of doc.getPages()) expect(page.node.Resources()?.toString()).toContain("XObject")
})

it("una hoja Carta en un papel A4 no se deforma: arriba pegada arriba, abajo pegada abajo", async () => {
  const { pdf } = await normalizeLetterhead(await sheetPdf([612, 792]))
  const sheet = { pdf, topMm: 35, bottomMm: 25, leftMm: 19, rightMm: 19, hasContact: true }
  const kit = await DocumentKit.open({ ...clinic, sheet }, documentFormat(clinic), {
    title: "Receta",
    docLabel: "Receta",
  })
  expect(kit.hasSheet).toBe(true)
  const scale = A4[0] / 612
  expect(kit.left).toBeCloseTo(19 * MM * scale, 1)
  const doc = await PDFDocument.load(await kit.finish())
  expect(doc.getPageCount()).toBe(1)
})

it("sin poder leer la hoja, el papel sale con nuestro membrete y la térmica nunca la lleva", async () => {
  const broken = {
    pdf: new TextEncoder().encode("no es un pdf"),
    topMm: 40,
    bottomMm: 30,
    leftMm: 19,
    rightMm: 19,
    hasContact: false,
  }
  const kit = await DocumentKit.open({ ...clinic, sheet: broken }, documentFormat(clinic), {
    title: "Receta",
    docLabel: "Receta",
  })
  expect(kit.hasSheet).toBe(false)
  const { pdf } = await normalizeLetterhead(await sheetPdf())
  const thermal = await DocumentKit.open(
    { ...clinic, sheet: { ...broken, pdf } },
    { width: 80 * MM, height: 14_000, margin: 12, exactFit: true },
    { title: "Ticket", docLabel: "Ticket" },
  )
  expect(thermal.hasSheet).toBe(false)
})
