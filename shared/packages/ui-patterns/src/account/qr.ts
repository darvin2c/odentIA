/** El código QR del enlace como imagen SVG (corrección M, margen de 4 módulos de la norma). */
export async function totpQrDataUrl(uri: string): Promise<string> {
  // Importación dinámica: qrcode no debe entrar al bundle inicial.
  const { default: QRCode } = await import("qrcode")
  const svg = await QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 4 })
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
