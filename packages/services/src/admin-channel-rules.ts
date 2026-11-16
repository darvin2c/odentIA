/**
 * Lo que acepta cada canal de la administración al responder (ADR 0196): cuánto texto, qué
 * archivos y con qué formato. La Bandeja lo dice antes de enviar (`rules` de la conversación) y
 * el servidor lo comprueba al reservar el envío, con las mismas cifras.
 *
 * Se escribe una vez, con las marcas de WhatsApp (`*negrita*`, `_cursiva_`, `~tachado~`), y
 * `textForChannel` lo adapta al canal antes de guardarlo: lo que se guarda es lo que sale.
 *
 * Las cifras son las de cada proveedor (desviarse sería inventar un límite):
 * - Correo: 5000 caracteres (el tope de `saas_outreach.body`) y hasta 5 adjuntos, 10 MB juntos
 *   (`REPLY_FILES_MAX`, `REPLY_FILES_MAX_BYTES`).
 * - WhatsApp Cloud API, «Supported media types» y mensajes de texto: texto de hasta 4096
 *   caracteres; imagen JPEG o PNG hasta 5 MB; audio AAC, MP4, MPEG, AMR u OGG hasta 16 MB;
 *   documento hasta 100 MB. El adaptador manda como documento lo que no es imagen ni audio (el
 *   video también), así que una imagen o un audio de otro tipo no sale: se rechaza antes.
 * - Messenger Platform, Send API: texto de hasta 2000 caracteres; imagen, audio, video y archivo
 *   de hasta 25 MB.
 * - Instagram Messaging API (por la página): texto de hasta 1000 bytes UTF-8; imagen PNG o JPEG
 *   hasta 8 MB; audio AAC, M4A o WAV, video MP4, OGG, AVI, MOV o WEBM y PDF hasta 25 MB.
 *
 * Un carácter se cuenta como unidad UTF-16 (`length`): una cuenta igual o más larga que la de
 * Meta, así que lo que pasa aquí nunca lo corta el proveedor.
 */
import type { SaasOutreachChannel } from "@odentia/db/schema/admin-arm"

export type ChannelFileKind = "imagen" | "audio" | "video" | "documento"

/** Un tipo de archivo que acepta el canal: sus tipos MIME (`image/*` y `*\/*` valen) y su tope. */
export interface ChannelFileRule {
  kind: ChannelFileKind
  types: string[]
  maxBytes: number
}

export type ChannelFormatting = "markdown" | "whatsapp" | "texto"

export interface ChannelRules {
  channel: SaasOutreachChannel
  /** Caracteres, firma incluida; nulo si el canal cuenta bytes. */
  maxChars: number | null
  /** Bytes UTF-8, firma incluida (solo Instagram); nulo si cuenta caracteres. */
  maxBytes: number | null
  /** Cuántos archivos por respuesta. En un chat cada uno sale como su propio mensaje. */
  maxFiles: number
  /** Cuánto pesan juntos (solo el correo: van en un mismo mensaje); nulo si no hay tope. */
  maxTotalBytes: number | null
  /** El primero que coincide con el tipo del archivo dice qué es y cuánto puede pesar. */
  files: ChannelFileRule[]
  /** Cómo se ven las marcas: el correo las dibuja, WhatsApp las manda, Instagram y Messenger no tienen. */
  formatting: ChannelFormatting
}

const MB = 1024 * 1024

/** Cuántos archivos van en una respuesta de chat (uno por mensaje). */
export const CHAT_REPLY_FILES_MAX = 5

export const CHANNEL_RULES: Readonly<Record<SaasOutreachChannel, ChannelRules>> = {
  correo: {
    channel: "correo",
    maxChars: 5000,
    maxBytes: null,
    maxFiles: 5,
    maxTotalBytes: 10 * MB,
    files: [{ kind: "documento", types: ["*/*"], maxBytes: 10 * MB }],
    formatting: "markdown",
  },
  whatsapp: {
    channel: "whatsapp",
    maxChars: 4096,
    maxBytes: null,
    maxFiles: CHAT_REPLY_FILES_MAX,
    maxTotalBytes: null,
    files: [
      { kind: "imagen", types: ["image/jpeg", "image/png"], maxBytes: 5 * MB },
      {
        kind: "audio",
        types: ["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"],
        maxBytes: 16 * MB,
      },
      // Lo demás sale como documento (el video también): lo que no es imagen ni audio.
      { kind: "documento", types: ["application/*", "text/*", "video/*"], maxBytes: 100 * MB },
    ],
    formatting: "whatsapp",
  },
  messenger: {
    channel: "messenger",
    maxChars: 2000,
    maxBytes: null,
    maxFiles: CHAT_REPLY_FILES_MAX,
    maxTotalBytes: null,
    files: [
      { kind: "imagen", types: ["image/*"], maxBytes: 25 * MB },
      { kind: "audio", types: ["audio/*"], maxBytes: 25 * MB },
      { kind: "video", types: ["video/*"], maxBytes: 25 * MB },
      { kind: "documento", types: ["*/*"], maxBytes: 25 * MB },
    ],
    formatting: "texto",
  },
  instagram: {
    channel: "instagram",
    maxChars: null,
    maxBytes: 1000,
    maxFiles: CHAT_REPLY_FILES_MAX,
    maxTotalBytes: null,
    files: [
      { kind: "imagen", types: ["image/png", "image/jpeg"], maxBytes: 8 * MB },
      {
        kind: "audio",
        types: ["audio/aac", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/wav", "audio/x-wav"],
        maxBytes: 25 * MB,
      },
      {
        kind: "video",
        types: [
          "video/mp4",
          "video/ogg",
          "video/x-msvideo",
          "video/avi",
          "video/quicktime",
          "video/webm",
        ],
        maxBytes: 25 * MB,
      },
      { kind: "documento", types: ["application/pdf"], maxBytes: 25 * MB },
    ],
    formatting: "texto",
  },
}

/** Lo que acepta el canal, para leerlo junto a la conversación. */
export function channelRulesOf(channel: SaasOutreachChannel): ChannelRules {
  return CHANNEL_RULES[channel]
}

const CHANNEL_WORDS: Record<SaasOutreachChannel, string> = {
  correo: "el correo",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
}

/** Lo que acepta cada canal, en palabras, para decirlo cuando un archivo no cabe. */
const ACCEPTS_WORDS: Record<SaasOutreachChannel, string> = {
  correo: "cualquier archivo de hasta 10 MB",
  whatsapp:
    "imágenes JPG o PNG, audio AAC, MP3, M4A, AMR u OGG, y documentos o video (PDF, Word, Excel, MP4…)",
  messenger: "imágenes, audio, video y documentos",
  instagram: "imágenes PNG o JPG, audio AAC, M4A o WAV, video MP4, MOV, AVI, WEBM u OGG, y PDF",
}

const KIND_WORDS: Record<ChannelFileKind, string> = {
  imagen: "imágenes",
  audio: "audio",
  video: "video",
  documento: "documentos",
}

/** «image/jpeg», sin parámetros (`; charset=…`) y en minúsculas. */
function baseType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase()
}

function typeMatches(pattern: string, type: string): boolean {
  if (pattern === "*/*") return type.includes("/")
  if (pattern.endsWith("/*")) return type.startsWith(pattern.slice(0, -1))
  return type === pattern
}

/** Qué es ese archivo para el canal (y cuánto puede pesar); nulo si el canal no lo manda. */
export function channelFileRuleOf(
  channel: SaasOutreachChannel,
  contentType: string,
): ChannelFileRule | null {
  const type = baseType(contentType)
  return (
    CHANNEL_RULES[channel].files.find((rule) =>
      rule.types.some((pattern) => typeMatches(pattern, type)),
    ) ?? null
  )
}

/** «6.2 MB», «800 KB» (con los números del Perú). */
export function fileSizeWords(bytes: number): string {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const value = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 1 }).format(bytes / MB)
  return `${value} MB`
}

/**
 * Por qué un archivo no sale por el canal, en palabras y con su nombre; nulo si sale. Lo dice la
 * respuesta junto al archivo antes de reservar nada.
 */
export function channelFileProblem(
  channel: SaasOutreachChannel,
  file: { filename: string; contentType: string; size: number },
): string | null {
  const rule = channelFileRuleOf(channel, file.contentType)
  const channelName = CHANNEL_WORDS[channel]
  if (!rule)
    return `«${file.filename}» no sale por ${channelName}: acepta ${ACCEPTS_WORDS[channel]}`
  if (file.size > rule.maxBytes)
    return `«${file.filename}» pesa ${fileSizeWords(file.size)} y ${channelName} manda ${KIND_WORDS[rule.kind]} de hasta ${fileSizeWords(rule.maxBytes)}`
  return null
}

/** Cuántos y cuánto pesan juntos; nulo si caben. */
export function channelFilesProblem(
  channel: SaasOutreachChannel,
  files: ReadonlyArray<{ size: number }>,
): string | null {
  const rules = CHANNEL_RULES[channel]
  if (files.length > rules.maxFiles)
    return rules.maxFiles === 1
      ? "Manda un solo archivo"
      : `Manda como máximo ${rules.maxFiles} archivos`
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (rules.maxTotalBytes !== null && total > rules.maxTotalBytes)
    return `Los archivos pasan de ${fileSizeWords(rules.maxTotalBytes)} juntos: quita alguno`
  return null
}

const utf8 = new TextEncoder()

/** Bytes UTF-8 de un texto (lo que cuenta Instagram). */
export function utf8Bytes(text: string): number {
  return utf8.encode(text).length
}

/**
 * Por qué ese texto no cabe en el canal; nulo si cabe. `reserved` es lo que el envío agrega
 * después (la firma con su salto de línea): cuenta en el tope y el mensaje dice cuánto queda para
 * lo que escribe la persona.
 */
export function channelTextProblem(
  channel: SaasOutreachChannel,
  text: string,
  reserved = "",
): string | null {
  const rules = CHANNEL_RULES[channel]
  if (rules.maxBytes !== null) {
    if (utf8Bytes(text) + utf8Bytes(reserved) <= rules.maxBytes) return null
    return `${CHANNEL_WORDS[channel]} deja como mucho ${rules.maxBytes} bytes${reserved ? " con la firma" : ""} (una tilde o un emoji ocupan más de uno): acórtalo`
  }
  if (rules.maxChars === null || text.length + reserved.length <= rules.maxChars) return null
  const room = Math.max(rules.maxChars - reserved.length, 0)
  const channelName = channel === "correo" ? "El correo" : CHANNEL_WORDS[channel]
  return reserved
    ? `${channelName} deja como mucho ${rules.maxChars} caracteres con la firma: usa como máximo ${room}`
    : `${channelName} deja como mucho ${rules.maxChars} caracteres: acórtalo`
}

/* ---------- El formato ---------- */

/** Una dirección escrita tal cual: sus `_` y `~` no son marcas. */
const URL_SPLIT = /(https?:\/\/[^\s<>]+)/i
/** `[texto](dirección)` de Markdown. */
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g
/** `**x**`: la negrita de Markdown. */
const DOUBLE_STAR = /(^|[^\w*])\*\*([^\s*](?:[^*\n]*?[^\s*])?)\*\*(?![\w*])/g
/** `*x*`, `_x_`, `~x~`: las marcas de WhatsApp, entre bordes de palabra, en una sola línea. */
const singleMark = (mark: "*" | "_" | "~") => {
  const m = mark === "*" ? "\\*" : mark
  return new RegExp(
    `(^|[^\\w${m}])${m}([^\\s${m}](?:[^${m}\\n]*?[^\\s${m}])?)${m}(?![\\w${m}])`,
    "g",
  )
}
const SINGLE_STAR = singleMark("*")
const SINGLE_UNDERSCORE = singleMark("_")
const SINGLE_TILDE = singleMark("~")

/** `[t](u)` → «t: u»; si el texto ya es la dirección, solo la dirección. */
function plainLinks(text: string): string {
  return text.replace(LINK, (_match, label: string, url: string) => {
    const shown = label.trim()
    const bare = (value: string) => value.replace(/^https?:\/\//i, "").replace(/\/$/, "")
    return bare(shown) === bare(url) ? url : `${shown}: ${url}`
  })
}

/** Aplica `change` a lo que no es una dirección. */
function outsideUrls(text: string, change: (part: string) => string): string {
  return text
    .split(URL_SPLIT)
    .map((part, index) => (index % 2 === 1 ? part : change(part)))
    .join("")
}

/**
 * Lo que sale por el canal de un texto escrito con las marcas de WhatsApp: el correo lo recibe
 * igual (lo dibuja `@odentia/mail/markdown`); WhatsApp pasa `**x**` a `*x*` y los enlaces de
 * Markdown a «texto: dirección»; Instagram y Messenger, que no tienen formato, reciben el texto sin
 * marcas (`*x*`, `**x**`, `_x_`, `~x~`) y los enlaces igual. Las direcciones no se tocan.
 */
export function textForChannel(body: string, channel: SaasOutreachChannel): string {
  const formatting = CHANNEL_RULES[channel].formatting
  if (formatting === "markdown") return body
  const linked = plainLinks(body)
  if (formatting === "whatsapp")
    return outsideUrls(linked, (part) => part.replace(DOUBLE_STAR, "$1*$2*"))
  return outsideUrls(linked, (part) =>
    part
      .replace(DOUBLE_STAR, "$1$2")
      .replace(SINGLE_STAR, "$1$2")
      .replace(SINGLE_UNDERSCORE, "$1$2")
      .replace(SINGLE_TILDE, "$1$2"),
  )
}
