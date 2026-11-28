/**
 * Lo que se mira de un video antes de guardarlo (ADR 0236): que WhatsApp lo acepte tal cual. La
 * documentación de la Cloud API pide MP4 (o 3GPP) de hasta 16 MB, video H.264 y audio AAC, una
 * sola pista de audio o ninguna, y advierte que el perfil «High» y los cuadros B no se ven en
 * Android: recomienda Main o Baseline sin cuadros B y el índice (`moov`) antes de los datos.
 * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#supported-media-types
 *
 * La pantalla lo achica en el navegador antes de subirlo; el servidor no lo vuelve a armar, solo
 * lee sus cajas (ISO/IEC 14496-12 y 14496-15) y dice qué no sirve. Lee con topes: un archivo
 * mal hecho a propósito no lo hace leer fuera del archivo ni bajar sin fin.
 */

export interface VideoFacts {
  durationMs: number
  width: number
  height: number
  /** Si trae audio (AAC). */
  audio: boolean
}

export type VideoCheck = { ok: true; facts: VideoFacts } | { ok: false; message: string }

interface Box {
  type: string
  /** Donde empieza su contenido y donde termina la caja. */
  start: number
  end: number
}

const MAX_DEPTH = 8

function boxesIn(view: DataView, from: number, to: number): Box[] {
  const boxes: Box[] = []
  let at = from
  while (at + 8 <= to) {
    let size = view.getUint32(at)
    const type = String.fromCharCode(
      view.getUint8(at + 4),
      view.getUint8(at + 5),
      view.getUint8(at + 6),
      view.getUint8(at + 7),
    )
    let header = 8
    if (size === 1) {
      if (at + 16 > to) throw new Error("caja cortada")
      const big = view.getBigUint64(at + 8)
      if (big > BigInt(to - at)) throw new Error("caja más grande que el archivo")
      size = Number(big)
      header = 16
    } else if (size === 0) size = to - at
    if (size < header || at + size > to) throw new Error("caja más grande que el archivo")
    boxes.push({ type, start: at + header, end: at + size })
    at += size
    if (boxes.length > 10_000) throw new Error("demasiadas cajas")
  }
  return boxes
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"])

function find(view: DataView, box: Box, path: string[], depth = 0): Box | null {
  if (depth > MAX_DEPTH) throw new Error("demasiado anidado")
  if (path.length === 0) return box
  const [next, ...rest] = path
  for (const child of boxesIn(view, box.start, box.end))
    if (child.type === next) return rest.length === 0 ? child : find(view, child, rest, depth + 1)
  return null
}

function need(view: DataView, box: Box, bytes: number) {
  if (box.start + bytes > box.end || box.end > view.byteLength) throw new Error("caja corta")
}

export function checkVideo(bytes: Uint8Array): VideoCheck {
  const fail = (message: string): VideoCheck => ({ ok: false, message })
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    const top = boxesIn(view, 0, bytes.byteLength)
    if (top[0]?.type !== "ftyp") return fail("Sube el video en MP4.")
    const moovAt = top.findIndex((b) => b.type === "moov")
    const mdatAt = top.findIndex((b) => b.type === "mdat")
    if (moovAt < 0 || mdatAt < 0)
      return fail("El video está incompleto. Grábalo o expórtalo otra vez.")
    // WhatsApp lo reproduce mientras llega solo con el índice al principio.
    if (moovAt > mdatAt)
      return fail(
        "El video no está listo para enviarse por WhatsApp. Vuelve a subirlo desde la ficha.",
      )
    const moov = top[moovAt]!
    const mvhd = find(view, moov, ["mvhd"])
    if (!mvhd) return fail("El video está incompleto. Grábalo o expórtalo otra vez.")
    need(view, mvhd, 4)
    const version = view.getUint8(mvhd.start)
    let timescale: number
    let duration: number
    if (version === 1) {
      need(view, mvhd, 32)
      timescale = view.getUint32(mvhd.start + 20)
      duration = Number(view.getBigUint64(mvhd.start + 24))
    } else {
      need(view, mvhd, 20)
      timescale = view.getUint32(mvhd.start + 12)
      duration = view.getUint32(mvhd.start + 16)
    }
    if (!timescale) return fail("El video está incompleto. Grábalo o expórtalo otra vez.")
    const durationMs = Math.round((duration / timescale) * 1000)
    // En partes (`moof`) la duración no está en el índice: WhatsApp lo quiere entero.
    if (durationMs <= 0 || top.some((b) => b.type === "moof"))
      return fail(
        "El video no está listo para enviarse por WhatsApp. Vuelve a subirlo desde la ficha.",
      )

    let videoTracks = 0
    let audioTracks = 0
    let width = 0
    let height = 0
    for (const trak of boxesIn(view, moov.start, moov.end).filter((b) => b.type === "trak")) {
      const hdlr = find(view, trak, ["mdia", "hdlr"])
      if (!hdlr) continue
      need(view, hdlr, 12)
      const handler = String.fromCharCode(...bytes.subarray(hdlr.start + 8, hdlr.start + 12))
      const stsd = find(view, trak, ["mdia", "minf", "stbl", "stsd"])
      if (handler !== "vide" && handler !== "soun") continue
      if (!stsd) return fail("El video está incompleto. Grábalo o expórtalo otra vez.")
      need(view, stsd, 8)
      const [entry] = boxesIn(view, stsd.start + 8, stsd.end)
      if (!entry) return fail("El video está incompleto. Grábalo o expórtalo otra vez.")
      if (handler === "soun") {
        audioTracks++
        if (entry.type !== "mp4a")
          return fail(
            "El sonido del video no es AAC: WhatsApp no lo acepta. Vuelve a subirlo desde la ficha.",
          )
        continue
      }
      videoTracks++
      if (entry.type !== "avc1" && entry.type !== "avc3")
        return fail("El video no es H.264: WhatsApp no lo acepta. Vuelve a subirlo desde la ficha.")
      need(view, entry, 78)
      width = view.getUint16(entry.start + 24)
      height = view.getUint16(entry.start + 26)
      const avcC = boxesIn(view, entry.start + 78, entry.end).find((b) => b.type === "avcC")
      if (!avcC) return fail("El video está incompleto. Grábalo o expórtalo otra vez.")
      need(view, avcC, 2)
      // 66: Baseline; 77: Main. «High» no se ve en Android (documentación de Meta).
      const profile = view.getUint8(avcC.start + 1)
      if (profile !== 66 && profile !== 77)
        return fail(
          "El video usa un perfil que WhatsApp no muestra en Android. Vuelve a subirlo desde la ficha.",
        )
      // Los cuadros B se ven en `ctts`: el orden de mostrar no es el de guardar.
      const ctts = find(view, trak, ["mdia", "minf", "stbl", "ctts"])
      if (ctts) {
        need(view, ctts, 8)
        const entries = view.getUint32(ctts.start + 4)
        if (ctts.start + 8 + entries * 8 > ctts.end) throw new Error("caja corta")
        for (let i = 0; i < entries; i++)
          if (view.getUint32(ctts.start + 8 + i * 8 + 4) !== 0)
            return fail(
              "El video tiene cuadros que WhatsApp no muestra en Android. Vuelve a subirlo desde la ficha.",
            )
      }
    }
    if (videoTracks !== 1) return fail("Sube un video con una sola imagen en movimiento.")
    if (audioTracks > 1)
      return fail("El video trae más de un sonido: WhatsApp acepta uno o ninguno.")
    if (!width || !height || width > 4096 || height > 4096)
      return fail("El video está incompleto. Grábalo o expórtalo otra vez.")
    return { ok: true, facts: { durationMs, width, height, audio: audioTracks === 1 } }
  } catch {
    return fail("El video no se pudo leer. Grábalo o expórtalo otra vez en MP4.")
  }
}
