import isotipo from "../../../../assets/brand/isotipo-light.svg?raw"

/**
 * Códigos QR de la aplicación con nuestro isotipo [32] al centro (decisión 10
 * del lienzo «Su enlace y el código QR»). Se generan con la corrección de
 * errores más alta (H, ISO/IEC 18004: recupera hasta ~30 % del código) y el
 * isotipo tapa cerca del 5 % del área, así que se lee igual. Nunca el logo de
 * la clínica: un logo cualquiera puede estropear la lectura; ese va afuera.
 */

/** Margen silencioso en módulos. La norma pide 4; 2 basta en pantalla y papel con borde blanco. */
const QUIET = 2
/** Lado del recuadro del isotipo respecto del código (~22 % del ancho). */
const LOGO_SHARE = 0.22

const ISOTIPO_INNER = isotipo
  .replace(/^[\s\S]*?<svg[^>]*>/, "")
  .replace(/<\/svg>\s*$/, "")
  .replace(/<title>[\s\S]*?<\/title>/, "")

/** El código como SVG (texto), con el isotipo al centro sobre un recuadro blanco. */
export async function brandedQrSvg(text: string): Promise<string> {
  // Importación dinámica: qrcode no debe entrar al bundle inicial.
  const { default: QRCode } = await import("qrcode")
  const modules = QRCode.create(text, { errorCorrectionLevel: "H" }).modules
  const n = modules.size
  const size = n + QUIET * 2
  // Impar para que quede centrado sobre la grilla.
  const box = Math.round(n * LOGO_SHARE) | 1
  const start = Math.floor((n - box) / 2)
  const covered = (x: number, y: number) =>
    x >= start - 1 && x < start + box + 1 && y >= start - 1 && y < start + box + 1
  let path = ""
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules.get(x, y) && !covered(x, y)) path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`
    }
  }
  const at = start + QUIET
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path fill="#0f172a" d="${path}"/>` +
    `<rect x="${at - 0.6}" y="${at - 0.6}" width="${box + 1.2}" height="${box + 1.2}" rx="1.4" fill="#fff"/>` +
    `<svg x="${at}" y="${at}" width="${box}" height="${box}" viewBox="0 0 128 112" style="color:#0e7490" fill="#0e7490" shape-rendering="geometricPrecision">${ISOTIPO_INNER}</svg>` +
    `</svg>`
  )
}

/** Para un `<img>`: nítido a cualquier tamaño. */
export async function brandedQrDataUrl(text: string): Promise<string> {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await brandedQrSvg(text))}`
}

/** PNG para descargar o imprimir, de `px` de lado. */
export async function brandedQrPng(text: string, px = 1024): Promise<string> {
  const image = new Image()
  image.src = await brandedQrDataUrl(text)
  await image.decode()
  const canvas = document.createElement("canvas")
  canvas.width = px
  canvas.height = px
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Sin lienzo para dibujar el código")
  context.imageSmoothingEnabled = false
  context.drawImage(image, 0, 0, px, px)
  return canvas.toDataURL("image/png")
}

async function loadImage(src: string, crossOrigin = false): Promise<HTMLImageElement> {
  const image = new Image()
  if (crossOrigin) image.crossOrigin = "anonymous"
  image.src = src
  await image.decode()
  return image
}

/**
 * La hoja del mostrador para imprimir (A5 a 300 ppp): el nombre de la clínica y,
 * si lo tiene, su logo arriba —afuera del código—, «Regístrate como paciente»,
 * el código con el [32] y los tres pasos. PNG para descargar.
 */
export async function registrationSheetPng(input: { clinicName: string; logoUrl?: string | null; url: string }): Promise<string> {
  const width = 1748
  const height = 2480
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Sin lienzo para dibujar la hoja")
  const font = getComputedStyle(document.body).fontFamily || "system-ui, sans-serif"
  const center = width / 2
  context.fillStyle = "#fff"
  context.fillRect(0, 0, width, height)
  context.textAlign = "center"
  context.textBaseline = "alphabetic"

  let y = 260
  // El logo de la clínica, si se puede leer (un logo de otro origen sin permiso se omite).
  if (input.logoUrl) {
    try {
      const logo = await loadImage(input.logoUrl, true)
      const scale = Math.min(520 / logo.width, 200 / logo.height)
      const w = logo.width * scale
      const h = logo.height * scale
      context.drawImage(logo, center - w / 2, y - 140, w, h)
      y += h - 40
    } catch {
      // Sin logo: queda el nombre.
    }
  }
  context.fillStyle = "#0f172a"
  context.font = `700 92px ${font}`
  context.fillText(input.clinicName, center, y, width - 240)
  y += 230
  context.font = `700 118px ${font}`
  context.fillText("Regístrate como paciente", center, y, width - 200)
  y += 140
  context.fillStyle = "#334155"
  context.font = `400 58px ${font}`
  context.fillText("Escanea con la cámara de tu celular.", center, y)
  y += 80
  context.fillText("No instalas nada y toma 3 minutos.", center, y)

  const qrSide = 980
  const qrTop = y + 110
  context.strokeStyle = "#e2e8f0"
  context.lineWidth = 8
  context.beginPath()
  context.roundRect(center - qrSide / 2 - 40, qrTop - 40, qrSide + 80, qrSide + 80, 56)
  context.stroke()
  context.imageSmoothingEnabled = false
  context.drawImage(await loadImage(await brandedQrDataUrl(input.url)), center - qrSide / 2, qrTop, qrSide, qrSide)

  y = qrTop + qrSide + 200
  context.fillStyle = "#334155"
  context.font = `500 52px ${font}`
  context.fillText("1  Escanea      2  Responde      3  Avisa en recepción", center, y, width - 200)
  context.fillStyle = "#64748b"
  context.font = `400 44px ${font}`
  context.fillText("¿Ya eres paciente o tienes cita? Pide tu enlace en recepción:", center, height - 260, width - 200)
  context.fillText("lo completas en tu celular mientras esperas.", center, height - 196, width - 200)
  return canvas.toDataURL("image/png")
}
