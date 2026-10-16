import { createHmac } from "node:crypto"

/**
 * El token de «Su enlace» no se guarda en ninguna parte (ADR 0037): se
 * recalcula con la clave del servidor y el id del enlace. En la base queda su
 * huella (`appointment_booking_link.token_hash`) y, en los mensajes que lo
 * llevan, una referencia al enlace (`{{su-enlace:<id>}}`) que el worker
 * cambia por el token al entregarlo al proveedor. Quien lee la base o la
 * Bandeja no obtiene un enlace que funcione.
 */
export function personalLinkToken(secretsKey: Buffer, linkId: string): string {
  return createHmac("sha256", secretsKey).update(`su-enlace:${linkId}`).digest("hex")
}

const REF = /\{\{su-enlace:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}\}/g

/** Lo que se guarda en el mensaje en lugar del token. */
export function personalLinkRef(linkId: string): string {
  return `{{su-enlace:${linkId}}}`
}

/** Al enviar: cada referencia pasa a ser el token de su enlace. */
export function resolvePersonalLinkRefs(text: string, secretsKey: Buffer): string {
  return text.replace(REF, (_, linkId: string) => personalLinkToken(secretsKey, linkId))
}

/** Al mostrar lo enviado: el enlace se ve sin su token. */
export function hidePersonalLinkRefs(text: string): string {
  return text.replace(REF, "…")
}
