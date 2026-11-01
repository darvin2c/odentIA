import type { Db } from "@odentia/db"
import { patientAllergy } from "@odentia/db/schema/clinical"
import { conversation, message } from "@odentia/db/schema/crm"
import { and, desc, eq, sql } from "drizzle-orm"
import { type CaseBrief, getCaseBrief } from "./agent-case-brief.js"
import { listHandoffs } from "./agent-operations.js"
import { notFound, ServiceError } from "./errors.js"
import { windowOpen } from "./message-window.js"
import { openOpportunitiesOf } from "./opportunities.js"
import { getPatientAccount } from "./payments.js"
import { type PersonCan, selfPatientOf } from "./people.js"
import { type PanelSuggestions, panelSuggestions } from "./person-panel-suggestions.js"

/** Lo que se muestra de una cita en el panel: cuándo, con quién y para qué. */
export interface PanelAppointment {
  startsAt: string
  professionalName: string | null
  serviceName: string | null
  branchName: string | null
}

/**
 * Lo que abre una fila de una persona en Inicio y «Ver el caso» en la Bandeja:
 * qué pasó, qué se sabe y la caja para responder (ADR 0125). Cada parte sale
 * solo si el rol la puede leer: lo decide aquí el servidor, no la pantalla.
 * Caja ve solo la pregunta de un pago y su deuda.
 */
export interface PersonPanel {
  conversationId: string
  contactId: string
  name: string | null
  channel: string | null
  patientId: string | null
  /** El tema que se responde; nulo si la persona solo espera respuesta. */
  topic: {
    id: string
    reason: string
    asks: string | null
    pending: string | null
    /** Lo que preguntó: se cita al responder. */
    quote: string | null
    kind: string
    priority: string
    urgent: boolean
    status: "abierta" | "tomada" | "resuelta"
    assigneeUserId: string | null
    createdAt: string
  } | null
  /** Los últimos mensajes, del más antiguo al más reciente. Sin permiso de leer la conversación, vacío. */
  thread: Array<{ from: "person" | "agent" | "team"; text: string; at: string }>
  /** Lo que ya se sabe de ella, con su origen. Nulo si el rol no lo lee. */
  known: CaseBrief["known"] | null
  /** Lo que el agente dejó propuesto o ya hizo. */
  proposals: CaseBrief["proposals"]
  /** Hasta cuándo se le puede escribir: Instagram y Messenger cierran; WhatsApp deja el mensaje por entregar. */
  reply: { allowed: boolean; closedChannel: boolean; windowOpen: boolean }
  /** Sus citas; nulo si el rol no ve la agenda o no es paciente. */
  appointments: { next: PanelAppointment | null; last: PanelAppointment | null } | null
  /** Sus alergias activas; nulo si el rol no las lee o no es paciente. */
  allergies: string[] | null
  /** Su última atención firmada, sin nada de lo clínico: cuándo y con quién. Solo quien lee la historia. */
  lastEncounter: { startedAt: string; professionalName: string | null } | null
  /** El presupuesto vigente; odontología, solo lo que indicó. */
  budget: { id: string; title: string; status: string } | null
  /** Lo que debe, por moneda. Solo quien ve finanzas. */
  debts: Array<{ cents: number; currency: string }> | null
  /** Oportunidades abiertas. Solo quien lleva el CRM. */
  opportunities: Array<{ id: string; title: string; stageName: string }> | null
  /** Horarios libres y precios de lista para escribir en la respuesta. */
  suggestions: PanelSuggestions
  /** Puede dejar lo que respondió como lección por aprobar. Nunca en lo clínico. */
  canTeach: boolean
}

const PANEL_MESSAGES = 6

/** Conversación de quien mira; caja llega por un pago, sin leer la conversación. */
export async function getPersonPanel(
  tx: Db,
  orgId: string,
  input: { conversationId: string; topicId?: string; userId: string; can: PersonCan },
): Promise<PersonPanel> {
  const { can } = input
  const readsThread = can("conversations.read")
  const [conv] = await tx
    .select({ contactId: conversation.contactId, lastInboundAt: conversation.lastInboundAt })
    .from(conversation)
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, input.conversationId)))
    .limit(1)
  if (!conv) throw notFound("Conversación")

  const handoffs = await listHandoffs(tx, orgId, { conversationId: input.conversationId, limit: 10 })
  const topicRow =
    (input.topicId ? handoffs.find((item) => item.id === input.topicId) : handoffs.find((item) => item.status !== "resuelta")) ?? null
  if (input.topicId && !topicRow) throw notFound("Tema")

  // Caja no lee conversaciones: entra solo por un pago que nadie tomó o es suyo.
  if (!readsThread) {
    const mine = topicRow?.kind === "pago" && (topicRow.assigneeUserId === null || topicRow.assigneeUserId === input.userId)
    if (!can("conversations.topics") || !mine) throw new ServiceError("FORBIDDEN", 403, "No tienes permiso para abrir esta conversación")
  }

  const brief = await getCaseBrief(tx, orgId, input.conversationId, { includePerson: readsThread || can("crm.read") })
  const [quoted] = topicRow?.sourceMessageId
    ? await tx
        .select({ body: message.body })
        .from(message)
        .where(and(eq(message.organizationId, orgId), eq(message.id, topicRow.sourceMessageId)))
        .limit(1)
    : []
  const quote = quoted?.body?.replace(/\s+/g, " ").trim() || null

  const recent = readsThread
    ? await tx
        .select({ direction: message.direction, senderKind: message.senderKind, body: message.body, at: message.createdAt })
        .from(message)
        .where(and(eq(message.organizationId, orgId), eq(message.conversationId, input.conversationId), sql`${message.body} is not null`))
        .orderBy(desc(message.createdAt), desc(message.id))
        .limit(PANEL_MESSAGES)
    : []

  const [channel] = await tx.execute<{ provider: string | null }>(sql`
    select ch.provider from conversation c left join channel_connection ch on ch.id = c.channel_connection_id and ch.organization_id = c.organization_id
    where c.organization_id = ${orgId} and c.id = ${input.conversationId}`)
  const open = windowOpen(conv.lastInboundAt)
  const closedChannel = !open && (channel?.provider === "instagram" || channel?.provider === "messenger")

  const patientId = await selfPatientOf(tx, orgId, conv.contactId)
  const clinicalReader = can("clinical.read")
  const own = patientId !== null

  const appointments = own && can("appointments.read") ? await appointmentsOf(tx, orgId, patientId) : null
  const allergies =
    own && (clinicalReader || can("clinical.alerts"))
      ? (
          await tx
            .select({ substance: patientAllergy.substance })
            .from(patientAllergy)
            .where(and(eq(patientAllergy.organizationId, orgId), eq(patientAllergy.patientId, patientId), eq(patientAllergy.isActive, true)))
        ).map((row) => row.substance)
      : null
  const lastEncounter = own && clinicalReader ? await lastEncounterOf(tx, orgId, patientId) : null
  const budget = own && can("budgets.read") ? await budgetOf(tx, orgId, patientId, can("crm.read") || can("finance.read") ? null : input.userId) : null
  const debts =
    own && can("finance.read")
      ? (await getPatientAccount(tx, orgId, patientId)).byCurrency
          .filter((row) => row.saldo > 0)
          .map((row) => ({ cents: row.saldo, currency: row.currency }))
      : null
  const opportunities = can("crm.read")
    ? (await openOpportunitiesOf(tx, orgId, conv.contactId)).map(({ id, title, stageName }) => ({ id, title, stageName }))
    : null

  const clinical = topicRow?.kind === "clinico"
  return {
    conversationId: input.conversationId,
    contactId: conv.contactId,
    name: brief.contactName,
    channel: brief.channel,
    patientId,
    topic: topicRow
      ? {
          id: topicRow.id,
          reason: topicRow.reason,
          asks: topicRow.asks,
          pending: topicRow.pending,
          quote,
          kind: topicRow.kind,
          priority: topicRow.priority,
          urgent: topicRow.urgent,
          status: topicRow.status,
          assigneeUserId: topicRow.assigneeUserId,
          createdAt: topicRow.createdAt,
        }
      : null,
    thread: recent
      .reverse()
      .map((row) => ({
        from: row.direction === "in" ? ("person" as const) : row.senderKind === "agent" ? ("agent" as const) : ("team" as const),
        text: row.body ?? "",
        at: row.at.toISOString(),
      })),
    known: readsThread || can("crm.read") ? brief.known : null,
    proposals: readsThread ? brief.proposals : [],
    reply: { allowed: !closedChannel && (can("conversations.write") || can("conversations.topics")), closedChannel, windowOpen: open },
    appointments,
    allergies,
    lastEncounter,
    budget,
    debts,
    opportunities,
    // Caja no ofrece horarios ni precios: solo responde si llegó su pago.
    suggestions: readsThread
      ? await panelSuggestions(tx, orgId, {
          patientId,
          question: quote ?? recent.find((row) => row.direction === "in")?.body ?? null,
          kind: topicRow?.kind ?? null,
          can,
        })
      : { professionalName: null, slots: [], prices: [], noPriceFor: null },
    // Sofi no aprende consejos clínicos ni lo de caja.
    canTeach: readsThread && can("conversations.write") && !clinical && topicRow?.kind !== "pago",
  }
}

async function appointmentsOf(tx: Db, orgId: string, patientId: string): Promise<NonNullable<PersonPanel["appointments"]>> {
  const pick = (when: ReturnType<typeof sql>, order: ReturnType<typeof sql>) =>
    tx.execute<PanelAppointment & Record<string, unknown>>(sql`
      select to_char(a.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "startsAt", u.name as "professionalName",
        a.service_name as "serviceName", b.name as "branchName"
      from appointment a
      left join "user" u on u.id = a.professional_user_id
      left join branch b on b.id = a.branch_id and b.organization_id = a.organization_id
      where a.organization_id = ${orgId} and a.patient_id = ${patientId} and not a.is_test and ${when}
      order by ${order} limit 1`)
  const [next] = await pick(sql`a.status in ('programada', 'confirmada') and a.ends_at > now()`, sql`a.starts_at asc`)
  const [last] = await pick(sql`a.status = 'atendida'`, sql`a.starts_at desc`)
  return { next: next ?? null, last: last ?? null }
}

async function lastEncounterOf(tx: Db, orgId: string, patientId: string): Promise<PersonPanel["lastEncounter"]> {
  const [row] = await tx.execute<{ startedAt: string; professionalName: string | null }>(sql`
    select to_char(e.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as "startedAt", u.name as "professionalName"
    from encounter e left join "user" u on u.id = e.professional_user_id
    where e.organization_id = ${orgId} and e.patient_id = ${patientId} and e.status not in ('borrador', 'anulada')
    order by e.started_at desc limit 1`)
  return row ?? null
}

/** El presupuesto vigente. Con `ownOnly`, el de lo que indicó o preparó esa persona (odontología). */
async function budgetOf(tx: Db, orgId: string, patientId: string, ownOnly: string | null): Promise<PersonPanel["budget"]> {
  const [row] = await tx.execute<{ id: string; title: string; status: string }>(sql`
    select b.id, b.title, b.status from treatment_budget b
    where b.organization_id = ${orgId} and b.patient_id = ${patientId} and b.status not in ('anulado', 'reemplazado')
      ${
        ownOnly
          ? sql`and (b.created_by = ${ownOnly} or exists (select 1 from treatment_budget_item l
              join treatment_plan_item i on i.id = l.plan_item_id and i.organization_id = l.organization_id
              where l.organization_id = b.organization_id and l.budget_id = b.id and i.created_by = ${ownOnly}))`
          : sql``
      }
    order by b.created_at desc limit 1`)
  return row ?? null
}
