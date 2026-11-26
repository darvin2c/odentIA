/**
 * Vuelve a escribir las plantillas en blanco de las guías en la web
 * (`apps/web/public/guias/`): `pnpm --filter @odentia/services plantillas`.
 * Hay que correrlo cuando cambia el dibujo de la hoja o de la plantilla; la prueba
 * `blank-sheets.test.ts` avisa si quedaron viejas.
 *
 * Junto a cada PDF escribe sus dos imágenes: la vista de la hoja (`<archivo>.webp`, la que se ve en
 * la tarjeta de descarga y lee Google Imágenes) y la de compartir (`<archivo>-og.png`, 1200 × 630,
 * para el enlace en WhatsApp o en redes y la imagen del artículo).
 *
 * Escribe también los códigos CIE-10 odontológicos para el buscador de la guía
 * (`apps/web/src/lib/guides/cie10-odontologia.json`), de la misma lista que la plantilla.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createCanvas } from "@napi-rs/canvas"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import sharp from "sharp"
import { BLANK_SHEET_KEYS, BLANK_SHEETS, dentalIcd10, renderBlankSheet } from "./blank-sheets.js"

const out = fileURLToPath(new URL("../../../../apps/web/public/guias/", import.meta.url))
mkdirSync(out, { recursive: true })

/** La primera hoja del PDF, en PNG, a `width` px de ancho. */
async function firstPage(bytes: Uint8Array, width: number): Promise<Buffer> {
  const pdf = await getDocument({ data: bytes.slice() }).promise
  const page = await pdf.getPage(1)
  const scale = width / page.getViewport({ scale: 1 }).width
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height))
  const context = canvas.getContext("2d")
  context.fillStyle = "#fff"
  context.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise
  await pdf.cleanup()
  return canvas.toBuffer("image/png")
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")

/** La imagen de compartir: el nombre a la izquierda y la hoja de verdad a la derecha. */
async function shareImage(page: Buffer, title: string, use = "Para imprimir en A4 y llenar a mano,"): Promise<Buffer> {
  const sheet = await sharp(page).resize({ width: 420 }).png().toBuffer()
  const { height = 0 } = await sharp(sheet).metadata()
  // La hoja asoma desde abajo, sin cortar el encabezado.
  const shown = await sharp(sheet)
    .extract({ left: 0, top: 0, width: 420, height: Math.min(height, 570) })
    .toBuffer()
  // El nombre en dos renglones si es de dos o más palabras («Odontograma / de niños»): en uno se
  // metía bajo la hoja. Cada renglón cabe en unos 580 px de ancho.
  const [first = "", ...rest] = title.split(" ")
  // Si lo que sigue a la primera palabra no cabe en un renglón («de tratamiento odontológico»), se
  // reparte en dos: el título va en tres.
  const tail = rest.join(" ")
  const lines = !rest.length
    ? [first]
    : tail.length <= 20
      ? [first, tail]
      : [first, rest.slice(0, Math.ceil(rest.length / 2)).join(" "), rest.slice(Math.ceil(rest.length / 2)).join(" ")]
  // Un renglón de más de 16 letras («clínica odontológica») va más chico: si no, toca la hoja.
  const size = Math.max(...lines.map((line) => line.length)) > 16 ? 54 : 64
  const name = lines
    .map((line, i) => `<text x="80" y="${lines.length > 2 ? 222 + i * 64 : lines.length > 1 ? 222 + i * 72 : 250}" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="${size}" font-weight="700" fill="#ffffff">${escape(line)}</text>`)
    .join("\n  ")
  const below = lines.length > 2 ? 104 : lines.length > 1 ? 72 : 0
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <rect width="1200" height="630" fill="#0a2129"/>
  <rect x="690" y="40" width="460" height="620" rx="18" fill="#123844"/>
  <text x="80" y="150" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="28" font-weight="600" fill="#5eead4" letter-spacing="3">PLANTILLA GRATIS EN PDF</text>
  ${name}
  <text x="80" y="${330 + below}" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="34" fill="#cbd5e1">${escape(use)}</text>
  <text x="80" y="${376 + below}" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="34" fill="#cbd5e1">con la guía paso a paso.</text>
  <text x="80" y="540" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="36" font-weight="700" fill="#ffffff">odentIA</text>
  <text x="80" y="582" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-size="26" fill="#94a3b8">odentia32.com/guias</text>
</svg>`
  return sharp(Buffer.from(svg))
    .composite([{ input: shown, left: 710, top: 60 }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

for (const sheet of BLANK_SHEET_KEYS) {
  const { file, title } = BLANK_SHEETS[sheet]
  const bytes = await renderBlankSheet(sheet)
  writeFileSync(`${out}${file}`, bytes)
  const page = await firstPage(bytes, 1240)
  const base = file.replace(/\.pdf$/, "")
  writeFileSync(`${out}${base}.webp`, await sharp(page).resize({ width: 620 }).webp({ quality: 82 }).toBuffer())
  writeFileSync(`${out}${base}-og.png`, await shareImage(page, title, sheet === "cie10-odontologia" ? "Para imprimir en A4 y tener a mano," : undefined))
  console.log(`${file}: ${Math.round(bytes.length / 1024)} KB, con ${base}.webp y ${base}-og.png`)
}

const codes = new URL("../../../../apps/web/src/lib/guides/cie10-odontologia.json", import.meta.url)
writeFileSync(codes, `${JSON.stringify(dentalIcd10(), null, 2)}
`)
console.log(`cie10-odontologia.json: ${dentalIcd10().codes.length} códigos`)
