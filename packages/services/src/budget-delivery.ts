/**
 * Si el presupuesto le llegó a la persona: lo que dice el estado real de su
 * mensaje, no el momento en que se entregó (pedido del 27 nov: la ficha decía
 * «Entregado el 27 nov» aunque WhatsApp no lo entregara).
 *
 * `presentado` y `presented_at` siguen siendo la decisión de la clínica: desde
 * ahí corren su vigencia, su hoja congelada (`delivered_snapshot`) y su
 * oportunidad, y no se deshacen si el canal falla (reenviarlo o imprimirlo
 * sigue siendo el mismo presupuesto). Lo que cambia es lo que se dice de la
 * entrega, que se lee del mensaje de cada envío (`financial_document.sent` y su
 * `message.status`, que pone el worker y los avisos del proveedor):
 *
 * - sin envíos, se entregó en mano (impreso o mostrado en la atención);
 * - por WhatsApp, «Enviado» mientras el proveedor no confirma, «Entregado» o
 *   «Leído» con su acuse y «No llegó» si lo rechazó, con el motivo en palabras;
 * - por correo no hay acuse: «Enviado por correo», salvo que no saliera;
 * - «Ya se lo di en mano» (`budget.handed`, `markBudgetHanded`): lo entregó en
 *   mano después; imprimir no deja traza, esto sí.
 *
 * «No le llegó» (`reached` falso) es solo lo que se entregó al enviarlo, cuyos
 * envíos fallaron todos y que nadie anotó como entregado en mano. La misma regla
 * está en SQL (`budgetNotReachedSql`); cambian juntas y su prueba las compara.
 *
 * Las consultas escriben la acción tal cual (no como parámetro): así Postgres usa
 * el índice parcial de los envíos (`audit_event_sent_document_idx`).
 */
import { isWhatsAppAccountFailure, whatsappFailureWords } from "@odentia/channels"
import type { Db } from "@odentia/db"
import { type SQL, type SQLWrapper, sql } from "drizzle-orm"
import { deliveryOf } from "./delivery-state.js"
import { findOrgLocale } from "./locale.js"

export type BudgetDeliveryState = "en_mano" | "enviado" | "entregado" | "leido" | "no_llego"

export interface BudgetDelivery {
  state: BudgetDeliveryState
  /** Por dónde salió el último envío; nulo si se entregó en mano. */
  channel: "whatsapp" | "email" | null
  /** Cuándo se envió (o se entregó en mano). */
  at: Date
  /** «Entregado el 27 nov», «Enviado por WhatsApp el 27 nov», «No llegó por WhatsApp · enviado el 27 nov». */
  text: string
  /** Por qué no llegó, con una sugerencia; nulo si no hay nada que resolver. */
  problem: string | null
  /** Le llegó por alguna vía o todavía puede llegar; falso si todos sus envíos fallaron. */
  reached: boolean
  /**
   * El estado de un presupuesto entregado que espera respuesta, dicho con su entrega:
   * «Entregado · espera respuesta», «Enviado · espera respuesta» o «No le llegó».
   */
  label: string
}

/** Un envío del presupuesto, como lo dejó su traza y lo dice su mensaje. */
export interface BudgetSendFact {
  at: Date
  channel: "whatsapp" | "email"
  /** Este envío lo entregó (era un borrador). */
  deliveredBudget: boolean
  /** `message.status`; nulo si el mensaje ya no está. */
  messageStatus: string | null
  error: string | null
}

/** Lo anotado como «Ya se lo di en mano». */
export const BUDGET_HANDED_ACTION = "budget.handed"

const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"

/** El mensaje de un envío (`entity_id`), si el id es de un mensaje. */
const SENT_MESSAGE = sql`m.organization_id = e.organization_id and m.id = (case when e.entity_id ~ ${UUID} then e.entity_id::uuid end)`

/** Los envíos de un presupuesto: la acción va escrita, para el índice parcial. */
const BUDGET_SENT = sql.raw(`e.action = 'financial_document.sent' and e.metadata->>'documentType' = 'budget'`)

/**
 * Lo que no le llegó, como condición sobre un presupuesto: se entregó al enviarlo,
 * ningún envío salió (un mensaje que ya no está no cuenta como fallido) y nadie lo
 * anotó como entregado en mano. Cada parte busca por el índice del presupuesto.
 */
export function budgetNotReachedSql(orgId: string, budgetId: SQLWrapper): SQL {
  const sends = sql`from audit_event e where e.organization_id = ${orgId} and ${BUDGET_SENT}
    and (e.metadata->>'documentId') = ${budgetId}::text`
  return sql`(exists (select 1 ${sends} and coalesce((e.metadata->>'deliveredBudget')::boolean, false))
    and not exists (select 1 from audit_event e left join message m on ${SENT_MESSAGE}
      where e.organization_id = ${orgId} and ${BUDGET_SENT} and (e.metadata->>'documentId') = ${budgetId}::text
        and (m.id is null or m.status <> 'failed'))
    and not exists (select 1 from audit_event h where h.organization_id = ${orgId} and h.entity = 'treatment_budget'
      and h.entity_id = ${budgetId}::text and h.action = ${BUDGET_HANDED_ACTION}))`
}

/** La regla de `budgetNotReachedSql`, en código. `handedAt`: la última vez que se anotó «Ya se lo di en mano». */
export function budgetReached(sends: readonly BudgetSendFact[], handedAt: Date | null = null): boolean {
  if (handedAt) return true
  if (!sends.some((send) => send.deliveredBudget)) return true
  return sends.some((send) => send.messageStatus !== "failed")
}

/** «27 nov»; de otro año, con el año (como «Qué sigue»). */
function shortDay(date: Date, zone: { locale: string; timezone: string }): string {
  const yearOf = (at: Date) => new Intl.DateTimeFormat("en-CA", { year: "numeric", timeZone: zone.timezone }).format(at)
  const otherYear = yearOf(date) !== yearOf(new Date())
  return new Intl.DateTimeFormat(zone.locale, {
    day: "numeric",
    month: "short",
    ...(otherYear ? { year: "numeric" } : {}),
    timeZone: zone.timezone,
  })
    .format(date)
    .replace(".", "")
}

const RESEND = "vuélvelo a enviar desde su presupuesto o, si ya se lo entregaste, marca «Ya se lo di en mano»"

/**
 * Por qué no llegó, en palabras, con una sugerencia (nunca una orden). El motivo lo
 * guardó el worker o el aviso del proveedor (`message.error`): en palabras si el
 * adaptador lo conoce (número sin WhatsApp, la cuenta de la clínica); el de Meta tal
 * cual no es para la clínica. Meta no dice si la persona bloqueó a la clínica: ese
 * caso entra en «no recibe mensajes de la clínica».
 */
export function notReachedProblem(channel: "whatsapp" | "email", error: string | null): string {
  const said = (reason: string, fix: string) => `${reason} Sugerencia: ${fix}.`
  if (error === "connection-disabled") return said("La conexión del canal estaba desactivada.", `actívala en Configuración › Integraciones y ${RESEND}`)
  if (error?.startsWith("interno:")) return said("El sistema no pudo enviarlo.", RESEND)
  if (error?.startsWith("confirmado por el equipo")) return said("Lo anotó el equipo como no enviado.", RESEND)
  if (channel === "email") return said("El correo no se pudo enviar.", `revisa su correo en sus Datos y ${RESEND}`)
  if (isWhatsAppAccountFailure(error))
    return said(
      `El WhatsApp de la clínica no pudo enviarlo (${(whatsappFailureWords(error) ?? "").replace(/^WhatsApp no envió el mensaje porque /, "").replace(/\.$/, "")}).`,
      `cuando esté resuelto, ${RESEND}`,
    )
  const words = whatsappFailureWords(error)
  // «Message undeliverable» (131026): el número no tiene WhatsApp, está mal escrito o no recibe sus mensajes.
  if (words?.includes("no tenga WhatsApp"))
    return said("Su número no tiene WhatsApp, está mal escrito o no recibe mensajes de la clínica.", `revisa su número en sus Datos y ${RESEND}`)
  if (words) return said(words, RESEND)
  return said("WhatsApp no lo entregó.", `revisa su número en sus Datos y ${RESEND}`)
}

/** Lo que se dice de la entrega de un presupuesto, sin leer nada. */
export function budgetDeliveryOf(
  budget: { presentedAt: Date | null },
  sends: readonly BudgetSendFact[],
  zone: { locale: string; timezone: string },
  handedAt: Date | null = null,
): BudgetDelivery | null {
  const reached = budgetReached(sends, handedAt)
  const last = sends.at(-1)
  // Sin envíos, o anotado en mano después del último: lo tiene en mano.
  if (!last || (handedAt && handedAt.getTime() >= last.at.getTime())) {
    const at = handedAt ?? budget.presentedAt
    if (!at) return null
    return {
      state: "en_mano",
      channel: null,
      at,
      text: `${handedAt ? "Entregado en mano el" : "Entregado el"} ${shortDay(at, zone)}`,
      problem: null,
      reached: true,
      label: "Entregado · espera respuesta",
    }
  }
  const day = shortDay(last.at, zone)
  const via = last.channel === "email" ? "por correo" : "por WhatsApp"
  const delivery = deliveryOf(last.messageStatus)
  const base = { channel: last.channel, at: last.at, reached }
  // Lo entregado en mano, o un envío anterior que WhatsApp confirmó, ya lo tiene aunque el envío
  // de después no llegue o siga sin confirmar.
  const handed =
    !!handedAt ||
    !sends.some((send) => send.deliveredBudget) ||
    sends.some((send) => send.channel === "whatsapp" && (send.messageStatus === "delivered" || send.messageStatus === "read"))
  if (delivery === "no_entregado") {
    return {
      ...base,
      state: "no_llego",
      text: `No llegó ${via} · enviado el ${day}`,
      problem: notReachedProblem(last.channel, last.error),
      label: handed ? "Entregado · espera respuesta" : reached ? "Enviado · espera respuesta" : "No le llegó",
    }
  }
  if (last.channel === "whatsapp" && (delivery === "entregado" || delivery === "leido")) {
    return {
      ...base,
      state: delivery,
      text: `${delivery === "leido" ? "Leído" : "Entregado"} por WhatsApp · enviado el ${day}`,
      problem: null,
      label: "Entregado · espera respuesta",
    }
  }
  return {
    ...base,
    state: "enviado",
    // El correo no tiene acuse de entrega: se dice que salió, nunca que llegó.
    text: `Enviado ${via} el ${day}`,
    problem:
      last.messageStatus === "unknown"
        ? "El canal no confirmó si salió. Sugerencia: revísalo en su conversación antes de volver a enviarlo, para no mandarlo dos veces."
        : null,
    label: handed ? "Entregado · espera respuesta" : "Enviado · espera respuesta",
  }
}

/** La entrega de cada presupuesto (en una consulta por cosa), por su id. Un borrador no tiene. */
export async function budgetDeliveries(
  tx: Db,
  orgId: string,
  budgets: ReadonlyArray<{ id: string; status: string; presentedAt: Date | null }>,
): Promise<Map<string, BudgetDelivery>> {
  const out = new Map<string, BudgetDelivery>()
  const delivered = budgets.filter((budget) => budget.status !== "borrador")
  if (delivered.length === 0) return out
  const ids = sql.join(delivered.map((budget) => sql`${budget.id}`), sql`, `)
  const rows = await tx.execute<{
    budget_id: string
    at: Date | string
    channel: string
    delivered_budget: boolean
    message_status: string | null
    message_error: string | null
  }>(sql`select e.metadata->>'documentId' as budget_id, e.created_at as at,
      coalesce(e.metadata->>'channel', 'whatsapp') as channel,
      coalesce((e.metadata->>'deliveredBudget')::boolean, false) as delivered_budget,
      m.status as message_status, m.error as message_error
    from audit_event e left join message m on ${SENT_MESSAGE}
    where e.organization_id = ${orgId} and ${BUDGET_SENT} and (e.metadata->>'documentId') in (${ids})
    order by e.created_at, e.id`)
  const handedRows = await tx.execute<{ budget_id: string; at: Date | string }>(sql`
    select h.entity_id as budget_id, max(h.created_at) as at from audit_event h
    where h.organization_id = ${orgId} and h.entity = 'treatment_budget' and h.entity_id in (${ids})
      and h.action = ${BUDGET_HANDED_ACTION}
    group by h.entity_id`)
  const handedOf = new Map(handedRows.map((row) => [row.budget_id, new Date(row.at)]))
  const sendsOf = new Map<string, BudgetSendFact[]>()
  for (const row of rows) {
    const list = sendsOf.get(row.budget_id) ?? []
    list.push({
      at: new Date(row.at),
      channel: row.channel === "email" ? "email" : "whatsapp",
      deliveredBudget: !!row.delivered_budget,
      messageStatus: row.message_status,
      error: row.message_error,
    })
    sendsOf.set(row.budget_id, list)
  }
  const zone = await findOrgLocale(tx, orgId)
  for (const budget of delivered) {
    const delivery = budgetDeliveryOf(budget, sendsOf.get(budget.id) ?? [], zone, handedOf.get(budget.id) ?? null)
    if (delivery) out.set(budget.id, delivery)
  }
  return out
}
