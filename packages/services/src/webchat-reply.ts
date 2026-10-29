import { whatsappNumberProblem } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { whatsappOf } from "./held-replies.js"
import { findOrgCountry } from "./locale.js"

/**
 * Por dónde le llega al visitante del chat web la respuesta del equipo (R4,
 * decisión 10 del pulido de la Bandeja). Una sola regla para reenviarla
 * (`forwardWebchatReply`), para «Sin forma de avisarle» en la Bandeja y para
 * aceptar lo que deja en «¿Dónde te avisamos?».
 *
 * - WhatsApp: con WhatsApp conectado, su WhatsApp marcado o el número que
 *   dejó. Ese número se usa solo si no es de nadie más: ni la identidad de
 *   otra persona, ni el teléfono anotado de otra ficha, ni uno que WhatsApp ya
 *   rechazó, ni uno que no puede ser un WhatsApp (un fijo o un celular
 *   incompleto del país de la clínica). Nunca se une a otra ficha por el número.
 * - Correo: con un buzón de la clínica conectado.
 */
export interface WebchatReplyRoutes {
  /** `claim`: el número que dejó pasa a ser su WhatsApp al responderle (lo decide quien responde). */
  whatsapp: { claim: boolean; phone: string } | null
  correo: { mailboxId: string; email: string } | null
}

export async function webchatReplyRoutes(
  tx: Db,
  orgId: string,
  contactId: string,
): Promise<WebchatReplyRoutes> {
  const [person] = await tx.execute<{ phone: string | null; email: string | null }>(sql`
    select phone, email from contact where organization_id = ${orgId} and id = ${contactId}::uuid`)
  if (!person) return { whatsapp: null, correo: null }
  let whatsapp: WebchatReplyRoutes["whatsapp"] = null
  if (await whatsappOf(tx, orgId, contactId)) {
    whatsapp = { claim: false, phone: person.phone ?? "" }
  } else if (
    person.phone &&
    !whatsappNumberProblem(person.phone, await findOrgCountry(tx, orgId)) &&
    (await whatsappConnected(tx, orgId))
  ) {
    const digits = person.phone.replace(/\D/g, "")
    const [taken] = await tx.execute<{ taken: boolean }>(sql`
      select exists (select 1 from contact_identity ci
          where ci.organization_id = ${orgId} and ci.channel = 'whatsapp' and ci.external_user_id = ${`wa:${digits}`})
        or exists (select 1 from contact other
          where other.organization_id = ${orgId} and other.id <> ${contactId}::uuid
            and regexp_replace(coalesce(other.phone, ''), '[^0-9]', '', 'g') = ${digits}) as taken`)
    if (!taken?.taken) whatsapp = { claim: true, phone: person.phone }
  }
  let correo: WebchatReplyRoutes["correo"] = null
  if (person.email) {
    const [mailbox] = await tx.execute<{ id: string }>(sql`
      select id from channel_connection
      where organization_id = ${orgId} and channel = 'email' and status = 'active'
      order by created_at, id limit 1`)
    if (mailbox) correo = { mailboxId: mailbox.id, email: person.email }
  }
  return { whatsapp, correo }
}

/** La clínica puede avisarle por algún lado: tiene WhatsApp o un buzón conectado. */
export async function webchatCanNotify(tx: Db, orgId: string): Promise<boolean> {
  const [row] = await tx.execute<{ any: boolean }>(sql`
    select exists (select 1 from channel_connection
      where organization_id = ${orgId} and status = 'active' and channel in ('whatsapp', 'email')) as any`)
  return row?.any === true
}

async function whatsappConnected(tx: Db, orgId: string): Promise<boolean> {
  const [row] = await tx.execute<{ any: boolean }>(sql`
    select exists (select 1 from channel_connection
      where organization_id = ${orgId} and status = 'active' and channel = 'whatsapp') as any`)
  return row?.any === true
}
