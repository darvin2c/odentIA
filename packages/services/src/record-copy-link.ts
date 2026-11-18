/**
 * La copia de la historia por «Su enlace» (mesa del 18 nov, ADR 0080 y 0167): lo que
 * hace el envío. El PDF que le llega lleva en su primera página «Su enlace» con
 * `abre=copia`; con él la persona baja la copia completa (el ZIP) escribiendo su
 * documento. El enlace va dentro del PDF y nunca en el texto del mensaje: el PDF es
 * de la historia clínica y en la Bandeja solo lo abre quien atiende; el texto lo ve
 * recepción.
 *
 * Manda el pedido, no el enlace: «Su enlace» se renueva con cada mensaje, y la copia
 * sirve `RECORD_COPY_DAYS` días desde su último envío (`copy_until` del pedido).
 */
import type { Db } from "@odentia/db"
import { patientDataRequest } from "@odentia/db/schema/clinical"
import { and, eq } from "drizzle-orm"
import { issuePersonalLink } from "./booking-links.js"
import { RECORD_COPY_DAYS } from "./data-requests.js"
import { findOrgLocale } from "./locale.js"
import { clinicOriginOf, personalLinkAddress } from "./public-links.js"

export interface RecordCopyLink {
  url: string
  until: Date
}

/**
 * Le da a quien pidió la copia su enlace (`issuePersonalLink`, el mismo «Su enlace» de
 * siempre, renovado) y deja el pedido sirviendo la copia desde hoy. Null si la clínica
 * no tiene dirección pública o el servidor no tiene con qué firmar el enlace: entonces
 * le llega solo el PDF. Va en la transacción del envío: si el mensaje no se encola, el
 * pedido queda como estaba.
 */
export async function issueRecordCopyLink(
  tx: Db,
  orgId: string,
  input: { requestId: string; contactId: string; patientId: string; actorUserId: string },
  deps: { secretsKey?: Buffer },
): Promise<RecordCopyLink | null> {
  if (!deps.secretsKey) return null
  const origin = await clinicOriginOf(tx, orgId)
  if (!origin) return null
  const link = await issuePersonalLink(
    tx,
    orgId,
    { contactId: input.contactId, patientId: input.patientId, createdBy: input.actorUserId },
    { secretsKey: deps.secretsKey },
  )
  const now = new Date()
  const until = new Date(now.getTime() + RECORD_COPY_DAYS * 86_400_000)
  // Un envío nuevo vuelve a contar los documentos mal escritos desde cero.
  await tx
    .update(patientDataRequest)
    .set({ copyUntil: until, copyFailedAttempts: 0, updatedAt: now })
    .where(
      and(eq(patientDataRequest.organizationId, orgId), eq(patientDataRequest.id, input.requestId)),
    )
  return { url: personalLinkAddress(origin, link.token, "copia"), until }
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
