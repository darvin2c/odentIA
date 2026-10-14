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
  return supportsBold(channel)
    ? "Este canal es WhatsApp: usa negrita con un asterisco a cada lado, *así*, nunca dos asteriscos, almohadillas ni otro formato. Al ofrecer una promoción pon en negrita, cada uno por separado, la palabra promoción con su nombre (*promoción «nombre»*), su precio (*el importe con su moneda*) y su fecha de fin (*hasta el día que vence*); nada más en negrita."
    : "Este canal se envía sin formato: no uses asteriscos, almohadillas ni otras marcas; destaca con las palabras."
}

const DOUBLE = /\*\*(\S(?:[^*\n]*?\S)?)\*\*/g
const DOUBLE_UNDERSCORE = /__(\S(?:[^_\n]*?\S)?)__/g
/** `*texto*` como marca de negrita: pegado al texto y separado de lo demás. */
const SINGLE = /(^|[\s(¡¿«"])\*(\S(?:[^*\n]*?\S)?)\*(?=[\s.,;:!?)»"]|$)/g

/** Convierte las marcas al formato del canal, o las quita si el canal no tiene formato. */
export function formatForChannel(text: string, channel: string | null | undefined): string {
  if (supportsBold(channel)) {
    return text.replace(DOUBLE, "*$1*").replace(DOUBLE_UNDERSCORE, "*$1*")
  }
  return text.replace(DOUBLE, "$1").replace(DOUBLE_UNDERSCORE, "$1").replace(SINGLE, "$1$2")
}
