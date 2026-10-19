/**
 * Lo que la ventana de Meta de «Conectar con Facebook» le avisa a la página que
 * la abrió, leído sin React para poder probarlo.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
 *
 * Las formas son las que publica Meta; la ventana real no se ha visto todavía.
 */

/** Solo se escucha a Meta: `facebook.com` o uno de sus subdominios, por https. */
export function fromFacebook(origin: string): boolean {
  try {
    const url = new URL(origin)
    return url.protocol === "https:" && (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com"))
  } catch {
    return false
  }
}

/** Lo que la ventana de Meta avisa a la página que la abrió. */
export type SessionEvent =
  | { kind: "finished"; wabaId: string; phoneNumberId: string }
  | { kind: "no-number" }
  | { kind: "cancelled" }
  | { kind: "error"; message: string | null }

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null)

/** Un identificador de Meta: llega como texto; si llegara como número, vale igual. */
const id = (value: unknown): string | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : text(value)

/**
 * `{ type: "WA_EMBEDDED_SIGNUP", event, data }`. Un final con `FINISH…` trae la
 * cuenta y el número; `FINISH_ONLY_WABA` termina sin número; `CANCEL` trae la
 * pantalla donde se abandonó o, si la persona reportó un error, su mensaje.
 */
export function readSessionEvent(raw: unknown): SessionEvent | null {
  let parsed: unknown = raw
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== "object") return null
  const message = parsed as { type?: unknown; event?: unknown; data?: unknown }
  if (message.type !== "WA_EMBEDDED_SIGNUP") return null
  const event = text(message.event)?.toUpperCase() ?? ""
  const data = (message.data && typeof message.data === "object" ? message.data : {}) as Record<string, unknown>
  if (event === "CANCEL") {
    const reported = text(data.error_message)
    return reported ? { kind: "error", message: reported } : { kind: "cancelled" }
  }
  if (event === "ERROR") return { kind: "error", message: text(data.error_message) }
  if (event === "FINISH_ONLY_WABA") return { kind: "no-number" }
  if (event.startsWith("FINISH")) {
    const wabaId = id(data.waba_id)
    const phoneNumberId = id(data.phone_number_id)
    return wabaId && phoneNumberId ? { kind: "finished", wabaId, phoneNumberId } : { kind: "no-number" }
  }
  return null
}
