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
 * - por correo no hay acuse: «Enviado por correo», salvo que no saliera.
 *
 * «No le llegó» (`reached` falso) es solo lo que se entregó al enviarlo y cuyos
 * envíos fallaron todos: lo que se entregó en mano, o un envío que salió, ya le
 * llegó por algún lado. La misma regla está en SQL (`budgetNotReachedSql`), para
 * lo que se cuenta en la base; cambian juntas y su prueba las compara.
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
  /** Por qué no llegó y qué hacer; nulo si no hay nada que resolver. */
  problem: string | null
  /** Solo por qué no llegó, sin lo que hace la clínica (lo que recibe Sofi); nulo si llegó. */
  reason: string | null
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

const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"

/** Los envíos de presupuestos de la clínica con el estado de su mensaje (una fila por envío). */
function budgetSendsSql(orgId: string): SQL {
  return sql`select e.metadata->>'documentId' as budget_id, e.created_at as at, e.id as event_id,
      coalesce(e.metadata->>'channel', 'whatsapp') as channel,
      coalesce((e.metadata->>'deliveredBudget')::boolean, false) as delivered_budget,
      m.status as message_status, m.error as message_error
    from audit_event e
    left join message m on m.organization_id = e.organization_id
      and m.id = (case when e.entity_id ~ ${UUID} then e.entity_id::uuid end)
    where e.organization_id = ${orgId} and e.action = 'financial_document.sent'
      and e.metadata->>'documentType' = 'budget'`
}

/**
 * Los presupuestos que no le llegaron (`reached` falso), como conjunto de ids:
 * se entregaron al enviarlos y todos sus envíos fallaron. Un mensaje que ya no
 * está no cuenta como fallido.
 */
export function budgetNotReachedSql(orgId: string, budgetId: SQLWrapper): SQL {
  return sql`(${budgetId}::text in (select s.budget_id from (${budgetSendsSql(orgId)}) s
    group by s.budget_id
    having bool_or(s.delivered_budget) and bool_and(s.message_status is not distinct from 'failed')))`
}

/** La regla de `budgetNotReachedSql`, en código. */
export function budgetReached(sends: readonly BudgetSendFact[]): boolean {
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

const RESEND = "vuelve a enviarlo desde su presupuesto, o imprímelo y entrégaselo"

/**
 * Por qué no llegó (`reason`) y qué hacer (`fix`), en palabras. El motivo lo guardó
 * el worker o el aviso del proveedor (`message.error`): en palabras si el adaptador
 * lo conoce (número sin WhatsApp, la cuenta de la clínica); el de Meta tal cual no
 * es para la clínica. Meta no dice si la persona bloqueó a la clínica: ese caso
 * entra en «no recibe mensajes de la clínica». `resend` es lo que se hace con ese
 * papel («vuelve a enviarlo desde su presupuesto, o imprímelo y entrégaselo»).
 */
export function notReachedWords(channel: string, error: string | null, resend: string): { reason: string; fix: string } {
  if (error === "connection-disabled")
    return { reason: "La conexión del canal estaba desactivada.", fix: `Actívala en Configuración › Integraciones y ${resend}.` }
  if (error?.startsWith("interno:")) return { reason: "El sistema no pudo enviarlo.", fix: `Después ${resend}.` }
  if (error?.startsWith("confirmado por el equipo"))
    return { reason: "Lo anotó el equipo como no enviado.", fix: `Si hace falta, ${resend}.` }
  if (channel === "email") return { reason: "El correo no se pudo enviar.", fix: `Revisa su correo en sus Datos y ${resend}.` }
  if (channel !== "whatsapp") return { reason: "El canal no lo entregó.", fix: `Si hace falta, ${resend}.` }
  if (isWhatsAppAccountFailure(error))
    return {
      reason: `El WhatsApp de la clínica no pudo enviarlo (${(whatsappFailureWords(error) ?? "").replace(/^WhatsApp no envió el mensaje porque /, "").replace(/\.$/, "")}).`,
      fix: `Cuando esté resuelto, ${resend}.`,
    }
  const words = whatsappFailureWords(error)
  // «Message undeliverable» (131026): el número no tiene WhatsApp, está mal escrito o no recibe sus mensajes.
  if (words?.includes("no tenga WhatsApp"))
    return {
      reason: "Su número no tiene WhatsApp, está mal escrito o no recibe mensajes de la clínica.",
      fix: `Corrige su número en sus Datos y ${resend}.`,
    }
  if (words) return { reason: words, fix: `Revisa su número y ${resend}.` }
  return { reason: "WhatsApp no lo entregó.", fix: `Revisa su número en sus Datos y ${resend}.` }
}

/** Por qué no llegó el presupuesto y qué hacer, en una frase. */
export function notReachedProblem(channel: "whatsapp" | "email", error: string | null): string {
  const { reason, fix } = notReachedWords(channel, error, RESEND)
  return `${reason} ${fix}`
}

const VIA_WORDS: Record<string, string> = {
  whatsapp: "por WhatsApp",
  email: "por correo",
  telegram: "por Telegram",
  messenger: "por Messenger",
  instagram: "por Instagram",
  webchat: "por el chat de la web",
}

/** Lo que pasó con un mensaje que llevó un papel: el mismo patrón para el presupuesto y los demás. */
export interface MessageDelivery {
  state: "enviado" | "entregado" | "leido" | "no_llego"
  channel: string
  at: Date
  /** «Enviado por WhatsApp el 27 nov», «Entregado por WhatsApp · enviado el 27 nov», «No llegó por WhatsApp · enviado el 27 nov». */
  text: string
  /** Por qué no llegó; nulo si no falló. */
  reason: string | null
  /** Por qué no llegó y qué hacer, o que no se sabe si salió; nulo si no hay nada que resolver. */
  problem: string | null
}

/**
 * Lo que se dice de un envío según el estado de su mensaje (`deliveryOf`): «Enviado»
 * mientras el canal no confirma (el correo nunca confirma), «Entregado» o «Leído» con
 * su acuse y «No llegó» con el motivo y qué hacer. La fecha es la del envío: no se
 * guarda cuándo llegó.
 */
export function messageDeliveryOf(
  send: { at: Date; channel: string; messageStatus: string | null; error: string | null },
  zone: { locale: string; timezone: string },
  resend: string,
): MessageDelivery {
  const day = shortDay(send.at, zone)
  const via = VIA_WORDS[send.channel] ?? "por mensaje"
  const delivery = deliveryOf(send.messageStatus)
  const base = { channel: send.channel, at: send.at }
  if (delivery === "no_entregado") {
    const { reason, fix } = notReachedWords(send.channel, send.error, resend)
    return { ...base, state: "no_llego", text: `No llegó ${via} · enviado el ${day}`, reason, problem: `${reason} ${fix}` }
  }
  if (send.channel !== "email" && (delivery === "entregado" || delivery === "leido")) {
    return {
      ...base,
      state: delivery,
      text: `${delivery === "leido" ? "Leído" : "Entregado"} ${via} · enviado el ${day}`,
      reason: null,
      problem: null,
    }
  }
  return {
    ...base,
    state: "enviado",
    text: `Enviado ${via} el ${day}`,
    reason: null,
    problem:
      send.messageStatus === "unknown"
        ? "El canal no confirmó si salió: revísalo en su conversación antes de volver a enviarlo, para no mandarlo dos veces."
        : null,
  }
}

/** El estado y el error de cada mensaje, por su id (los que ya no están no vienen). */
export async function messageStatuses(
  tx: Db,
  orgId: string,
  messageIds: readonly (string | null)[],
): Promise<Map<string, { status: string; error: string | null }>> {
  const uuid = new RegExp(UUID)
  const ids = [...new Set(messageIds.filter((id): id is string => !!id && uuid.test(id)))]
  if (ids.length === 0) return new Map()
  const rows = await tx.execute<{ id: string; status: string; error: string | null }>(sql`
    select m.id::text as id, m.status, m.error from message m
    where m.organization_id = ${orgId} and m.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`)
  return new Map(rows.map((row) => [row.id, { status: row.status, error: row.error }]))
}

/**
 * El último envío de cada papel (`action` de su traza, con el id del papel en
 * `metadata[idKey]` y el mensaje que lo llevó en `entity_id`), dicho con lo que pasó
 * con ese mensaje (`messageDeliveryOf`). Lo usan la receta y los papeles de salud
 * (`health_document.sent`) y el consentimiento enviado a firmar (`personal_link.sent`
 * con `consentId`). Un papel que nunca salió por un mensaje no viene.
 */
export async function lastSendDeliveries(
  tx: Db,
  orgId: string,
  input: { action: string; idKey: string; ids: readonly string[]; resend: string },
): Promise<Map<string, MessageDelivery>> {
  const out = new Map<string, MessageDelivery>()
  if (input.ids.length === 0) return out
  const rows = await tx.execute<{
    paper_id: string
    at: Date | string
    channel: string | null
    message_status: string | null
    message_error: string | null
  }>(sql`select distinct on (s.paper_id) s.* from (
      select e.metadata->>${input.idKey} as paper_id, e.id as event_id, e.created_at as at,
        e.metadata->>'channel' as channel, m.status as message_status, m.error as message_error
      from audit_event e
      left join message m on m.organization_id = e.organization_id
        and m.id = (case when e.entity_id ~ ${UUID} then e.entity_id::uuid end)
      where e.organization_id = ${orgId} and e.action = ${input.action} and e.entity = 'message'
    ) s
    where s.paper_id in (${sql.join(input.ids.map((id) => sql`${id}`), sql`, `)})
    order by s.paper_id, s.at desc, s.event_id desc`)
  if (rows.length === 0) return out
  const zone = await findOrgLocale(tx, orgId)
  for (const row of rows) {
    out.set(
      row.paper_id,
      messageDeliveryOf(
        { at: new Date(row.at), channel: row.channel ?? "whatsapp", messageStatus: row.message_status, error: row.message_error },
        zone,
        input.resend,
      ),
    )
  }
  return out
}

/** Lo que se dice de la entrega de un presupuesto, sin leer nada. */
export function budgetDeliveryOf(
  budget: { presentedAt: Date | null },
  sends: readonly BudgetSendFact[],
  zone: { locale: string; timezone: string },
): BudgetDelivery | null {
  const reached = budgetReached(sends)
  const last = sends.at(-1)
  if (!last) {
    if (!budget.presentedAt) return null
    return {
      state: "en_mano",
      channel: null,
      at: budget.presentedAt,
      text: `Entregado el ${shortDay(budget.presentedAt, zone)}`,
      problem: null,
      reason: null,
      reached: true,
      label: "Entregado · espera respuesta",
    }
  }
  const said = messageDeliveryOf(last, zone, RESEND)
  // Lo que se entregó en mano, o un envío anterior que WhatsApp confirmó, ya lo tiene aunque el
  // envío de después no llegue o siga sin confirmar.
  const handed =
    !sends.some((send) => send.deliveredBudget) ||
    sends.some((send) => send.channel === "whatsapp" && (send.messageStatus === "delivered" || send.messageStatus === "read"))
  const label =
    said.state === "entregado" || said.state === "leido" || handed
      ? "Entregado · espera respuesta"
      : said.state === "no_llego" && !reached
        ? "No le llegó"
        : "Enviado · espera respuesta"
  return { ...said, channel: last.channel, reached, label }
}

/** La entrega de cada presupuesto (en una consulta), por su id. Un borrador no tiene. */
export async function budgetDeliveries(
  tx: Db,
  orgId: string,
  budgets: ReadonlyArray<{ id: string; status: string; presentedAt: Date | null }>,
): Promise<Map<string, BudgetDelivery>> {
  const out = new Map<string, BudgetDelivery>()
  const delivered = budgets.filter((budget) => budget.status !== "borrador")
  if (delivered.length === 0) return out
  const ids = delivered.map((budget) => budget.id)
  const rows = await tx.execute<{
    budget_id: string
    at: Date | string
    channel: string
    delivered_budget: boolean
    message_status: string | null
    message_error: string | null
  }>(sql`select * from (${budgetSendsSql(orgId)}) s
    where s.budget_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    order by s.at, s.event_id`)
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
    const delivery = budgetDeliveryOf(budget, sendsOf.get(budget.id) ?? [], zone)
    if (delivery) out.set(budget.id, delivery)
  }
  return out
}
