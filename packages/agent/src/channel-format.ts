/**
 * Formato del texto según el canal. Solo WhatsApp muestra negrita en texto
 * plano (`*así*`); Telegram, Messenger, Instagram, el chat web y el correo se
 * envían sin formato, así que una marca llegaría a la persona como asteriscos.
 * El modelo recibe la regla (`channelFormatRule`) y, por si igual escribe con
 * otra marca, `formatForChannel` la convierte o la quita antes de enviar.
 */

/** Canales que muestran negrita escrita con un asterisco a cada lado. */
const BOLD_CHANNELS = new Set(["whatsapp"])

export function supportsBold(channel: string | null | undefined): boolean {
  return Boolean(channel && BOLD_CHANNELS.has(channel))
}

/** Lo que se le dice al modelo sobre el formato de este canal. */
export function channelFormatRule(channel: string | null | undefined): string {
  // El chat web no sigue abierto: si pasas un tema, el chat le pide dónde avisarle (R4 del pulido de la Bandeja).
  if (channel === "webchat") {
    return "Este canal es el chat del sitio de la clínica y se envía sin formato: no uses asteriscos, almohadillas ni otras marcas; destaca con las palabras. Si pasas un tema al equipo, no digas que le responden «por aquí»: el chat le pide su WhatsApp o su correo para avisarle; dile que lo deje ahí."
  }
  return supportsBold(channel)
    ? "Este canal es WhatsApp: usa negrita con un asterisco a cada lado, *así*, nunca dos asteriscos, almohadillas ni otro formato. Al ofrecer una promoción pon en negrita, cada uno por separado, la palabra promoción con su nombre (*promoción «nombre»*), su precio (*el importe con su moneda*) y su fecha de fin (*hasta el día que vence*); nada más en negrita. Si el precio es «desde», la palabra va dentro de la misma negrita (*desde el importe*), nunca el importe solo."
    : "Este canal se envía sin formato: no uses asteriscos, almohadillas ni otras marcas; destaca con las palabras."
}

const DOUBLE = /\*\*(\S(?:[^*\n]*?\S)?)\*\*/g
const DOUBLE_UNDERSCORE = /__(\S(?:[^_\n]*?\S)?)__/g
/** `*texto*` como marca de negrita: pegado al texto y separado de lo demás. */
const SINGLE = /(^|[\s(¡¿«"])\*(\S(?:[^*\n]*?\S)?)\*(?=[\s.,;:!?)»"]|$)/g

/** Encabezados y enlaces de Markdown: ningún canal los muestra, en ninguno se dejan. */
const HEADING = /^#{1,6}\s+/gm
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g

/**
 * Un emoji con sus añadidos (tono de piel, variante, unión con otro) o una
 * bandera. Solo los que se dibujan como emoji: ©, ® o ™ sin variante quedan.
 */
const EMOJI =
  "(?:(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F)(?:\\p{Emoji_Modifier}|\\uFE0F|\\u200D(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F?))*|\\p{Regional_Indicator}{2})"
const EMOJI_AT_LINE_START = new RegExp(`(^|\\n)[ \\t]*(?:${EMOJI})+[ \\t]*`, "gu")
const EMOJI_INLINE = new RegExp(`[ \\t]*(?:${EMOJI})+`, "gu")

/** Quita los emojis sin dejar espacios de más donde estaban. */
export function stripEmojis(text: string): string {
  return text.replace(EMOJI_AT_LINE_START, "$1").replace(EMOJI_INLINE, "")
}

/**
 * Convierte las marcas al formato del canal, o las quita si el canal no tiene
 * formato. Con `emojis: "no"` (la voz de la clínica) también quita los emojis:
 * la regla del prompt no basta para garantizarlo.
 */
export function formatForChannel(
  raw: string,
  channel: string | null | undefined,
  opts: { emojis?: "no" | "pocos" } = {},
): string {
  const plain = raw.replace(HEADING, "").replace(LINK, "$1: $2")
  const text = opts.emojis === "no" ? stripEmojis(plain) : plain
  if (supportsBold(channel)) {
    return text.replace(DOUBLE, "*$1*").replace(DOUBLE_UNDERSCORE, "*$1*")
  }
  return text.replace(DOUBLE, "$1").replace(DOUBLE_UNDERSCORE, "$1").replace(SINGLE, "$1$2")
}
