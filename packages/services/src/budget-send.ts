/**
 * Enviar el presupuesto a la persona (paso 3 de la fase 3, decisión 4).
 *
 * Sale por la regla de siempre (`routeMessage`): WhatsApp primero —con el PDF
 * si la persona escribió en las últimas 24 horas, o con «Presupuesto listo»
 * aprobado si no— y correo, con el PDF, si no tiene WhatsApp. Antes salía
 * primero por correo y por WhatsApp solo dentro de las 24 horas.
 *
 * Es la misma operación para quien entrega desde Plan, el cierre de la
 * atención, «Te espera» y el agente (`reenviar_presupuesto`): el agente solo
 * reenvía lo ya preparado, nunca entrega un borrador ni cambia precios.
 *
 * Le llega a la persona, o a su representante legal si es menor. «Ver y
 * responder» apuntará al enlace personal (paso 6); mientras tanto, el
 * mensaje lleva el PDF.
 */
import { budgetOptionLabel, formatMoney, isMinor } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { patient } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, sql } from "drizzle-orm"
import {
  BUDGET_READY_MESSAGE_KEY,
  BUDGET_READY_SUBJECT,
  type MessageSpec,
  renderMessage,
  replyId,
} from "./automation-messages.js"
import { clinicName, firstName, previewMessageRoute, routeMessage } from "./automation-routing.js"
import { mayWriteFirst } from "./automation.js"
import { type BudgetWithTotals, deliverBudget, getBudgetDetail, valueOptionOf } from "./budgets.js"
import { currentCatalogMessage } from "./clinic-messages.js"
import { sendTemplateOutbound } from "./conversations.js"
import { notFound, ServiceError } from "./errors.js"
import { buildBudgetSnapshot, renderBudgetPdf } from "./financial-document-pdf.js"
import {
  type DocumentRecipient,
  deliverDocumentPdf,
  listDocumentRecipients,
  type RecipientRelation,
} from "./financial-documents.js"
import { findOrgLocale } from "./locale.js"
import type { Storage } from "./storage.js"

/** Estados en los que el presupuesto se puede enviar (o reenviar). */
const SENDABLE = ["borrador", "presentado", "pospuesto", "parcial", "aceptado"] as const

/** A quién le llega: la propia persona o, si es menor, su representante legal. */
async function budgetRecipient(
  tx: Db,
  orgId: string,
  patientId: string,
  recipientContactId?: string | null,
): Promise<DocumentRecipient> {
  const recipients = await listDocumentRecipients(tx, orgId, patientId)
  if (recipientContactId) {
    const chosen = recipients.find((row) => row.contactId === recipientContactId)
    if (!chosen) {
      throw new ServiceError(
        "DOCUMENT_RECIPIENT_NOT_AUTHORIZED",
        403,
        "El destinatario no es la persona ni un pagador autorizado del paciente",
      )
    }
    return chosen
  }
  const [row] = await tx
    .select({ birthDate: patient.birthDate })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
  const birth = row?.birthDate ? String(row.birthDate).slice(0, 10) : null
  const minor = birth ? isMinor(birth, new Date().toISOString().slice(0, 10)) : false
  const self = recipients.find((r) => r.relation === "paciente") ?? null
  const representative = recipients.find((r) => r.relation === "representante_legal") ?? null
  const chosen = minor ? (representative ?? self) : (self ?? representative)
  if (!chosen) {
    throw new ServiceError(
      "BUDGET_NO_RECIPIENT",
      409,
      "No hay a quién enviárselo: registra a la persona o a su representante legal en sus datos",
    )
  }
  return chosen
}

/** «3 tratamientos por S/ 540», o «2 opciones: S/ 540 o S/ 1 260». */
function budgetSummary(budget: BudgetWithTotals, locale: string): string {
  const money = (cents: number | null) => (cents == null ? "un precio por definir" : formatMoney(cents, budget.currency, locale))
  if (budget.options.length > 1) {
    const totals = budget.options.map((option) => money(option.totalCents))
    const last = totals.pop()
    return `${budget.options.length} opciones: ${totals.join(", ")} o ${last}`
  }
  const value = valueOptionOf(budget.options)
  const count = value?.lineCount ?? budget.items.length
  return `${count} ${count === 1 ? "tratamiento" : "tratamientos"} por ${money(budget.totalCents)}`
}

async function readyMessage(
  tx: Db,
  orgId: string,
  budget: BudgetWithTotals,
  recipient: DocumentRecipient,
  patientName: string,
): Promise<{ spec: MessageSpec; params: string[]; text: string }> {
  const spec = await currentCatalogMessage(tx, orgId, BUDGET_READY_MESSAGE_KEY)
  const { locale } = await findOrgLocale(tx, orgId)
  const summary = budgetSummary(budget, locale)
  // Al representante se le dice de quién es: «el de Mateo, 3 tratamientos por S/ 540».
  const resumen = recipient.relation === "paciente" ? summary : `el de ${patientName}, ${summary}`
  const { params, text } = renderMessage(spec, {
    persona: firstName({ givenNames: null, displayName: recipient.displayName }),
    resumen_presupuesto: resumen,
  })
  return { spec, params, text }
}

export interface BudgetSendPreview {
  recipient: { contactId: string; name: string; relation: RecipientRelation }
  /** Por dónde saldría; nulo si no se puede enviar. */
  channel: "whatsapp" | "email" | null
  via: "respuesta" | "plantilla" | "correo" | null
  /** «Enviar por WhatsApp» o «Enviar por correo». */
  label: string | null
  /** Por qué no se puede enviar (con «Imprimir y entregar» sigue la vía). */
  blocked: string | null
  /** El texto que recibe. */
  text: string
}

/** Lo que dice el botón antes de enviar: a quién y por dónde, sin abrir ni escribir nada. */
export async function previewBudgetSend(
  tx: Db,
  orgId: string,
  patientId: string,
  budgetId: string,
  opts: { actorUserId?: string; memberRole?: string } = {},
): Promise<BudgetSendPreview> {
  const budget = await getBudgetDetail(tx, orgId, patientId, budgetId, opts)
  const recipient = await budgetRecipient(tx, orgId, patientId)
  const patientName = await patientFirstName(tx, orgId, patientId)
  const { spec, text } = await readyMessage(tx, orgId, budget, recipient, patientName)
  const base = { recipient: { contactId: recipient.contactId, name: recipient.displayName, relation: recipient.relation }, text }
  if (!(SENDABLE as readonly string[]).includes(budget.status)) {
    return { ...base, channel: null, via: null, label: null, blocked: "Este presupuesto ya no se envía." }
  }
  const route = await previewMessageRoute(tx, orgId, recipient.contactId, spec)
  if ("cause" in route) return { ...base, channel: null, via: null, label: null, blocked: route.detail }
  if (route.via !== "respuesta" && !(await mayWriteFirst(tx, orgId, recipient.contactId, "seguimiento"))) {
    return { ...base, channel: null, via: null, label: null, blocked: OPTED_OUT }
  }
  return {
    ...base,
    channel: route.channel,
    via: route.via,
    label: route.channel === "whatsapp" ? "Enviar por WhatsApp" : "Enviar por correo",
    blocked: null,
  }
}

const OPTED_OUT =
  "Pidió no recibir mensajes de seguimiento: entrégaselo impreso, o envíaselo si te escribe por WhatsApp."

async function patientFirstName(tx: Db, orgId: string, patientId: string): Promise<string> {
  const [row] = await tx
    .select({ givenNames: patient.givenNames, displayName: patient.displayName })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Paciente")
  return firstName(row)
}

export interface SendBudgetInput {
  patientId: string
  budgetId: string
  /** Otra persona autorizada; por defecto, la persona o su representante si es menor. */
  recipientContactId?: string | null
  /** Clave del intento: repetirla no lo envía dos veces. */
  requestId?: string | null
}

export interface SendBudgetActor {
  /** Quién del equipo lo envía; nulo cuando lo reenvía el agente. */
  userId: string | null
  memberRole?: string
  /** `agente`: solo reenvía lo ya entregado (nunca un borrador). */
  by?: "equipo" | "agente"
}

export interface SendBudgetResult {
  conversationId: string
  messageId: string
  /** Siempre encolado al responder: lo entrega el worker. */
  status: "queued"
  channel: "whatsapp" | "email"
  via: "respuesta" | "plantilla" | "correo"
  recipientName: string
  /** Si era un borrador y enviarlo lo entregó. */
  deliveredBudget: boolean
}

export interface SendBudgetDeps {
  storage: Storage
  secretsKey?: Buffer
}

/**
 * Envía el presupuesto por la regla de siempre. Si era un borrador, enviarlo
 * lo entrega (solo quien puede entregarlo; el agente no). Sin vía, lo dice con
 * el motivo: imprimir y entregar sigue siendo el camino.
 */
export async function sendBudget(
  tx: Db,
  orgId: string,
  actor: SendBudgetActor,
  input: SendBudgetInput,
  deps: SendBudgetDeps,
): Promise<SendBudgetResult> {
  if (input.requestId) {
    // Mismo intento = un solo envío: se serializa por clave y se devuelve lo ya hecho.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('budget-send:' || ${orgId} || ':' || ${input.requestId}))`,
    )
    const [previous] = await tx
      .select({ entityId: auditEvent.entityId, metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.organizationId, orgId),
          eq(auditEvent.action, "financial_document.sent"),
          sql`${auditEvent.metadata}->>'requestId' = ${input.requestId}`,
        ),
      )
      .limit(1)
    if (previous) {
      const sent = previous.metadata as Partial<SendBudgetResult> & { documentId?: string }
      if (sent.documentId !== input.budgetId)
        throw new ServiceError("REQUEST_ID_CONFLICT", 409, "Esa clave de envío ya se usó con otro documento")
      return {
        conversationId: sent.conversationId ?? "",
        messageId: previous.entityId ?? "",
        status: "queued",
        channel: sent.channel ?? "whatsapp",
        via: sent.via ?? "respuesta",
        recipientName: sent.recipientName ?? "",
        deliveredBudget: sent.deliveredBudget ?? false,
      }
    }
  }
  const scope = { actorUserId: actor.userId ?? undefined, memberRole: actor.memberRole }
  let budget = await getBudgetDetail(tx, orgId, input.patientId, input.budgetId, scope)
  if (!(SENDABLE as readonly string[]).includes(budget.status)) {
    throw new ServiceError("BUDGET_STATUS", 409, "Este presupuesto ya no se envía")
  }
  let deliveredBudget = false
  if (budget.status === "borrador") {
    // El agente reenvía lo ya preparado: un borrador espera a la clínica (decisión 4).
    if (actor.by === "agente") {
      throw new ServiceError("BUDGET_NOT_READY", 409, "El presupuesto todavía no está listo para enviar")
    }
    await deliverBudget(tx, orgId, actor.userId, input.patientId, input.budgetId, { memberRole: actor.memberRole })
    deliveredBudget = true
    budget = await getBudgetDetail(tx, orgId, input.patientId, input.budgetId)
  }
  const recipient = await budgetRecipient(tx, orgId, input.patientId, input.recipientContactId)
  const patientName = await patientFirstName(tx, orgId, input.patientId)
  const { spec, params, text } = await readyMessage(tx, orgId, budget, recipient, patientName)
  const route = await routeMessage(tx, orgId, recipient.contactId, spec)
  if ("cause" in route) throw new ServiceError("BUDGET_NO_ROUTE", 409, `No se pudo enviar: ${route.detail}. Imprímelo y entrégaselo.`)
  // Es parte del servicio (ADR 0030): solo deja de salir si se dio de baja del
  // seguimiento. Responder a quien acaba de escribir siempre se puede.
  if (route.via !== "respuesta" && !(await mayWriteFirst(tx, orgId, recipient.contactId, "seguimiento"))) {
    throw new ServiceError("BUDGET_OPTED_OUT", 409, OPTED_OUT)
  }
  const snap = await buildBudgetSnapshot(tx, orgId, input.patientId, input.budgetId)
  const filename = `Presupuesto-${snap.numberLabel.replace(/\D/g, "")}.pdf`
  const senderKind = actor.by === "agente" || !actor.userId ? "agent" : "user"
  let sent: { conversationId: string; messageId: string }
  if (route.via === "plantilla" && route.template) {
    // Pasadas las 24 horas solo sale el mensaje aprobado; el PDF llega al
    // tocar «Ver y responder» (`handleAutomationReply`).
    const message = await sendTemplateOutbound(tx, orgId, deps.secretsKey ?? Buffer.alloc(0), {
      conversationId: route.conversationId,
      senderKind,
      senderUserId: senderKind === "user" ? actor.userId : null,
      name: route.template.name,
      language: route.template.language,
      params,
      buttons: spec.buttons.map((button) => ({ id: replyId(button.action, input.budgetId), title: button.title })),
      preview: text,
    })
    sent = { conversationId: route.conversationId, messageId: message.id }
  } else {
    const pdf = await renderBudgetPdf(snap, null)
    const caption =
      route.via === "correo"
        ? `${BUDGET_READY_SUBJECT} · ${await clinicName(tx, orgId)}\n\n${text}\n${budgetOptionLine(budget)}`
        : text
    sent = await deliverDocumentPdf(
      tx,
      orgId,
      senderKind === "user" ? actor.userId : null,
      {
        recipient,
        conversationId: route.conversationId,
        pdf,
        filename,
        caption,
        senderKind,
      },
      deps,
    )
  }
  const result: SendBudgetResult = {
    conversationId: sent.conversationId,
    messageId: sent.messageId,
    status: "queued",
    channel: route.channel,
    via: route.via,
    recipientName: recipient.displayName,
    deliveredBudget,
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: actor.userId,
    action: "financial_document.sent",
    entity: "message",
    entityId: sent.messageId,
    metadata: {
      patientId: input.patientId,
      documentType: "budget",
      documentId: input.budgetId,
      recipientContactId: recipient.contactId,
      conversationId: sent.conversationId,
      channel: route.channel,
      via: route.via,
      recipientName: recipient.displayName,
      deliveredBudget,
      ...(actor.by === "agente" ? { origin: "agente" } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
    },
  })
  return result
}

/** En el correo, el número del presupuesto (y cuántas opciones trae). */
function budgetOptionLine(budget: BudgetWithTotals): string {
  const number = `Presupuesto N.º ${String(budget.budgetNumber).padStart(4, "0")}`
  return budget.options.length > 1
    ? `${number} · ${budget.options.map((option) => budgetOptionLabel(option.position)).join(", ")}`
    : number
}

/**
 * «Ver y responder» de «Presupuesto listo»: la persona lo tocó (y con eso abrió
 * la ventana de 24 horas), así que se le deja el PDF en su conversación con un
 * texto fijo. Solo vale si el presupuesto es de un paciente del que ella es la
 * persona o su representante.
 */
export async function answerBudgetButton(
  tx: Db,
  orgId: string,
  input: { conversationId: string; contactId: string; budgetId: string },
  deps: SendBudgetDeps,
): Promise<boolean> {
  const [row] = await tx.execute<{ patientId: string; status: string }>(sql`
    select b.patient_id as "patientId", b.status from treatment_budget b
    where b.organization_id = ${orgId} and b.id = ${input.budgetId}
      and exists (select 1 from patient_contact pc where pc.organization_id = b.organization_id
        and pc.patient_id = b.patient_id and pc.contact_id = ${input.contactId} and pc.relationship = 'self'
        union all
        select 1 from patient_responsibility r where r.organization_id = b.organization_id
        and r.patient_id = b.patient_id and r.contact_id = ${input.contactId} and r.revoked_at is null
        and r.kind in ('representante_legal','responsable_economico','autorizado_informacion'))`)
  if (!row || !(SENDABLE as readonly string[]).includes(row.status) || row.status === "borrador") return false
  const snap = await buildBudgetSnapshot(tx, orgId, row.patientId, input.budgetId)
  const pdf = await renderBudgetPdf(snap, null)
  await deliverDocumentPdf(
    tx,
    orgId,
    null,
    {
      recipient: { contactId: input.contactId, email: null, phone: null },
      conversationId: input.conversationId,
      pdf,
      filename: `Presupuesto-${snap.numberLabel.replace(/\D/g, "")}.pdf`,
      caption: BUDGET_BUTTON_REPLY,
      senderKind: "agent",
    },
    deps,
  )
  return true
}

/** Lo que acompaña al PDF cuando la persona toca «Ver y responder». */
export const BUDGET_BUTTON_REPLY =
  "Aquí tienes tu presupuesto. Cuando lo revises, cuéntanos qué aceptas: puedes escribirlo aquí mismo."
