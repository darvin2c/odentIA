/**
 * La hoja membretada de una clínica de demostración (ADR 0180), inventada aquí: su
 * nombre arriba con una línea de color, una marca de agua clara en el centro y su
 * web abajo, sin datos de una persona. Se arma con el mismo dibujo en PDF (lo que va
 * de fondo en los papeles) y en PNG (sus franjas para la hoja que se firma en
 * pantalla). Si la clínica ya tiene hoja, no hace nada.
 */
import type { Db } from "@odentia/db"
import { PDFDocument, rgb, StandardFonts } from "pdf-lib"
import sharp from "sharp"
import { getCurrentLetterhead, letterheadPdfKey, saveLetterhead } from "./letterhead.js"
import { clinicLogoFolder, type Storage } from "./storage.js"

const A4 = { width: 595.28, height: 841.89 }
const MM = 72 / 25.4
/** Dónde va el texto, como lo mediría la pantalla al subirla. */
const MARGINS = { topMm: 38, bottomMm: 30, leftMm: 19, rightMm: 19 }

function hexRgb(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16)
  return { r: (value >> 16) / 255, g: ((value >> 8) & 0xff) / 255, b: (value & 0xff) / 255 }
}

/** El mismo dibujo en SVG, para recortar sus franjas y su miniatura. */
function sheetSvg(name: string, web: string, color: string): string {
  const w = 1240
  const h = Math.round((w * A4.height) / A4.width)
  const px = w / (A4.width / MM)
  const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#ffffff"/>
  <text x="${w / 2}" y="${18 * px}" font-family="Helvetica, Arial, sans-serif" font-size="${8 * px}" font-weight="700" fill="${color}" text-anchor="middle">${xml(name)}</text>
  <rect x="${40 * px}" y="${24 * px}" width="${w - 80 * px}" height="${0.8 * px}" fill="${color}"/>
  <circle cx="${w / 2}" cy="${h * 0.55}" r="${55 * px}" fill="none" stroke="${color}" stroke-opacity="0.08" stroke-width="${10 * px}"/>
  <rect x="0" y="${h - 14 * px}" width="${w}" height="${14 * px}" fill="${color}"/>
  <text x="${w / 2}" y="${h - 5.5 * px}" font-family="Helvetica, Arial, sans-serif" font-size="${3.6 * px}" fill="#ffffff" text-anchor="middle">${xml(web)}</text>
</svg>`
}

async function sheetPdf(name: string, web: string, color: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([A4.width, A4.height])
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const { r, g, b } = hexRgb(color)
  const ink = rgb(r, g, b)
  const title = 8 * MM
  page.drawText(name, {
    x: (A4.width - bold.widthOfTextAtSize(name, title)) / 2,
    y: A4.height - 18 * MM,
    size: title,
    font: bold,
    color: ink,
  })
  page.drawRectangle({
    x: 40 * MM,
    y: A4.height - 24.8 * MM,
    width: A4.width - 80 * MM,
    height: 0.8 * MM,
    color: ink,
  })
  page.drawCircle({
    x: A4.width / 2,
    y: A4.height * 0.45,
    size: 55 * MM,
    borderColor: ink,
    borderWidth: 10 * MM,
    borderOpacity: 0.08,
  })
  page.drawRectangle({ x: 0, y: 0, width: A4.width, height: 14 * MM, color: ink })
  const small = 3.6 * MM
  page.drawText(web, {
    x: (A4.width - regular.widthOfTextAtSize(web, small)) / 2,
    y: 5.5 * MM,
    size: small,
    font: regular,
    color: rgb(1, 1, 1),
  })
  return pdf.save()
}

export async function seedDemoLetterhead(
  db: Db,
  storage: Pick<Storage, "putAvatar" | "putAttachmentAt">,
  input: { orgId: string; userId: string; name: string; web: string; color: string },
): Promise<void> {
  if (await getCurrentLetterhead(db, input.orgId)) return
  if (!storage.putAttachmentAt) return
  const pdf = await sheetPdf(input.name, input.web, input.color)
  const pdfKey = letterheadPdfKey(input.orgId)
  await storage.putAttachmentAt(pdfKey, pdf, "application/pdf")
  const drawing = sharp(Buffer.from(sheetSvg(input.name, input.web, input.color)))
  const { height = 0, width = 0 } = await drawing.metadata()
  const pxPerMm = width / (A4.width / MM)
  const top = Math.round(MARGINS.topMm * pxPerMm)
  const bottom = Math.round(MARGINS.bottomMm * pxPerMm)
  const png = (image: sharp.Sharp) => image.png().toBuffer()
  const [topBand, bottomBand, thumbnail] = await Promise.all([
    png(drawing.clone().extract({ left: 0, top: 0, width, height: top })),
    png(drawing.clone().extract({ left: 0, top: height - bottom, width, height: bottom })),
    png(drawing.clone().resize({ width: 240 })),
  ])
  const put = async (body: Buffer) =>
    (
      await storage.putAvatar({
        userId: clinicLogoFolder(input.orgId),
        body,
        contentType: "image/png",
        ext: "png",
      })
    ).url
  await saveLetterhead(db, input.orgId, input.userId, {
    pdfKey,
    topBandUrl: await put(topBand),
    bottomBandUrl: await put(bottomBand),
    thumbnailUrl: await put(thumbnail),
    pageWidthPt: A4.width,
    pageHeightPt: A4.height,
    ...MARGINS,
    hasContact: false,
    fileName: `Hoja membretada ${input.name}.pdf`,
  })
}
