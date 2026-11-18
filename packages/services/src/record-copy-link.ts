/**
 * La copia de la historia por su enlace (mesa del 18 nov, ADR 0080): lo que hace el
 * envío. El PDF que le llega lleva en su primera página un enlace con un token propio,
 * de un solo propósito: bajar la copia completa (el ZIP) escribiendo su documento. No es
 * «Su enlace»: ese lo puede mostrar o copiar recepción, y este solo viaja dentro del PDF,
 * que en la Bandeja abre únicamente quien atiende. Tampoco va en el texto del mensaje.
 *
 * En la base queda su huella (`copy_token_hash`) y hasta cuándo sirve (`copy_until`, el
 * final del día del envío más `RECORD_COPY_DAYS`, en la zona de la clínica). Cada envío
 * («Enviar de nuevo» también) pone uno nuevo y el anterior deja de servir.
 */
import { createHash, randomBytes } from "node:crypto"
import type { Db } from "@odentia/db"
import { patientDataRequest } from "@odentia/db/schema/clinical"
import { and, eq } from "drizzle-orm"
import { zonedTimeToUtc } from "./availability.js"
import { addCalendarDays, RECORD_COPY_DAYS } from "./data-requests.js"
import { clinicToday } from "./inventory-stock.js"
import { findOrgLocale } from "./locale.js"
import { clinicOriginOf } from "./public-links.js"

export interface RecordCopyLink {
  url: string
  until: Date
}

/** Un token de la copia: 32 bytes al azar en hexadecimal, como «Su enlace» en su forma. */
export const RECORD_COPY_TOKEN = /^[0-9a-f]{64}$/

/** La huella con que se guarda y se busca el token; el token no se guarda nunca. */
export function recordCopyTokenHash(token: string): string {
  return createHash("sha256").update(`copia:${token}`).digest("hex")
}

/** La página pública de la copia, de la familia de «Su enlace» (`/pendientes`), con su token. */
export function recordCopyAddress(origin: string, token: string): string {
  return `${origin}/pendientes?abre=copia&token=${token}`
}

/**
 * El último instante del día del envío más `RECORD_COPY_DAYS`, en la zona de la clínica:
 * «hasta el 25 de noviembre» sirve todo el 25.
 */
export async function recordCopyUntil(tx: Db, orgId: string): Promise<Date> {
  const { timezone } = await findOrgLocale(tx, orgId)
  const lastDay = addCalendarDays(await clinicToday(tx, orgId), RECORD_COPY_DAYS)
  return new Date(zonedTimeToUtc(addCalendarDays(lastDay, 1), 0, timezone).getTime() - 1)
}

/**
 * Le da a quien pidió la copia un enlace nuevo, de un solo propósito, y deja el pedido
 * sirviendo la copia hasta `copy_until`. Null si la clínica no tiene dirección pública:
 * entonces le llega solo el PDF. Va en la transacción del envío: si el mensaje no se
 * encola, el pedido queda como estaba (y el enlace anterior, si lo había, sigue).
 */
export async function issueRecordCopyLink(
  tx: Db,
  orgId: string,
  input: { requestId: string },
): Promise<RecordCopyLink | null> {
  const origin = await clinicOriginOf(tx, orgId)
  if (!origin) return null
  const token = randomBytes(32).toString("hex")
  const until = await recordCopyUntil(tx, orgId)
  // Un envío nuevo reemplaza el token anterior y vuelve a contar los documentos mal escritos.
  await tx
    .update(patientDataRequest)
    .set({
      copyTokenHash: recordCopyTokenHash(token),
      copyUntil: until,
      copyFailedAttempts: 0,
      updatedAt: new Date(),
    })
    .where(
      and(eq(patientDataRequest.organizationId, orgId), eq(patientDataRequest.id, input.requestId)),
    )
  return { url: recordCopyAddress(origin, token), until }
}

/** «25 de noviembre», en el idioma y la zona de la clínica. */
export async function recordCopyDayWords(tx: Db, orgId: string, at: Date): Promise<string> {
  const { locale, timezone } = await findOrgLocale(tx, orgId)
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    timeZone: timezone,
  }).format(at)
}

/**
 * El texto del mensaje que acompaña al PDF. Neutro: se ve en la notificación del
 * teléfono y en la Bandeja, así que no dice nada de su salud ni lleva el enlace (va
 * dentro del PDF). A quien decide por un menor le habla de la historia de él.
 */
export function recordCopyCaption(input: {
  clinicName: string | null
  /** El nombre del paciente si quien la recibe es su representante; null si es la propia persona. */
  patientFirstName: string | null
  /** «25 de noviembre», si la copia completa se baja con su enlace. */
  until: string | null
}): string {
  const whose = input.patientFirstName ? `la historia de ${input.patientFirstName}` : "tu historia"
  const subject = `Copia de ${whose}${input.clinicName ? ` · ${input.clinicName}` : ""}`
  const body = `Aquí tienes la copia de ${whose} que pediste, en PDF.`
  const link = input.until
    ? ` En su primera página está el enlace para bajar la copia completa, hasta el ${input.until}.`
    : ""
  // La primera línea es el asunto del correo en frío.
  return `${subject}\n\n${body}${link}`
}
