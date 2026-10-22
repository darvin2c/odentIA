/**
 * Cómo se dice un mensaje que no tiene texto, para la Actividad y los avisos:
 * «Foto», «Nota de voz», «Ubicación» o «Mensaje aprobado: Recordatorio de
 * cita». Nunca «[adjunto]», «Plantilla» ni el nombre técnico de Meta.
 */

/** El nombre de un mensaje aprobado en palabras: «recordatorio_cita» → «Recordatorio cita». */
export function templateTitle(name: string | null | undefined): string {
  const words = (name ?? "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
  if (!words) return ""
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Lo que era un mensaje sin texto, por su tipo y el de su primer adjunto. */
export function messageWithoutTextWords(input: {
  contentType: string
  templateName?: string | null
  attachments?: unknown
}): string {
  if (input.contentType === "location") return "Ubicación"
  if (input.contentType === "template") {
    const title = templateTitle(input.templateName)
    return title ? `Mensaje aprobado: ${title}` : "Mensaje aprobado"
  }
  const first = Array.isArray(input.attachments)
    ? (input.attachments[0] as { mimeType?: unknown } | undefined)
    : undefined
  const mime = typeof first?.mimeType === "string" ? first.mimeType : ""
  if (mime.startsWith("image/")) return "Foto"
  if (mime.startsWith("audio/")) return "Nota de voz"
  if (mime.startsWith("video/")) return "Video"
  if (mime) return "Documento"
  return "Mensaje sin texto"
}
