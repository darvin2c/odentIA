import { formatMoney } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { contact, conversation } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import { listPersonFacts } from "./agent-person-memory.js"
import { activeAllergies } from "./allergies.js"
import { type CrmNextAppointment, listContactTasks, nextAppointmentOf } from "./crm-workspace.js"
import { notFound } from "./errors.js"
import { getOrgLocale } from "./locale.js"
import { listOpportunities } from "./opportunities.js"
import { getPatientMissingData } from "./patient-registration.js"
import { getAccountSummary } from "./payments.js"
import { selfPatientOf } from "./people.js"
import { type Can, getPlanNextStep } from "./plan-next.js"

/**
 * «Contexto» de la Bandeja: quién es la persona y, de cada sección, una línea
 * con lo que hay dentro. Cada línea sale solo si quien mira puede abrir esa
 * sección; la que no se entrega no se escribe. No es una lectura clínica: de la
 * historia solo dice las alergias, lo único que también ve recepción.
 */
export interface ConversationContext {
  contactId: string
  patientId: string | null
  name: string
  phone: string | null
  email: string | null
  nextAppointment: CrmNextAppointment | null
  lines: {
    plan?: string
    alertas?: string
    cobros?: string
    ventas?: string
    datos?: string
    recuerda?: string
  }
  /** Lo que conviene mirar primero: se dice en otro tono. */
  attention: Array<"alertas" | "cobros" | "datos">
}

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`
}

export async function getConversationContext(tx: Db, orgId: string, conversationId: string, can: Can): Promise<ConversationContext> {
  const [row] = await tx
    .select({ id: contact.id, displayName: contact.displayName, phone: contact.phone, email: contact.email })
    .from(conversation)
    .innerJoin(contact, eq(conversation.contactId, contact.id))
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conversación")
  const patientId = await selfPatientOf(tx, orgId, row.id)
  const lines: ConversationContext["lines"] = {}
  const attention: ConversationContext["attention"] = []
  // Sin leer el CRM solo se habla de quien ya es paciente: odontología y caja no ven a los demás.
  const nextAppointment = can("appointments.read") ? await nextAppointmentOf(tx, orgId, row.id) : null
  if (patientId) {
    if (can("clinical.read") || can("budgets.read") || can("appointments.read")) {
      lines.plan = (await getPlanNextStep(tx, orgId, patientId, can)).text
    }
    if (can("clinical.read") || can("clinical.alerts")) {
      const allergies = await activeAllergies(tx, orgId, patientId)
      lines.alertas = allergies.length > 0 ? `Alergia: ${allergies.map((item) => item.substance).join(", ")}` : "Alergias: ninguna registrada"
      if (allergies.length > 0) attention.push("alertas")
    }
    if (can("finance.read")) {
      const account = await getAccountSummary(tx, orgId, patientId)
      const { locale } = await getOrgLocale(tx, orgId)
      const owed = account.byCurrency.filter((item) => item.porCobrar > 0)
      lines.cobros = owed.length > 0 ? `Le falta pagar ${owed.map((item) => formatMoney(item.porCobrar, item.currency, locale)).join(" y ")}` : "Sin deuda"
      if (owed.length > 0) attention.push("cobros")
    }
    if (can("patients.read")) {
      const missing = await getPatientMissingData(tx, orgId, patientId)
      lines.datos = missing.length > 0 ? `Falta: ${missing.map((item) => item.label.toLowerCase()).join(", ")}` : "Completos"
      if (missing.length > 0) attention.push("datos")
    }
  }
  if (can("crm.read")) {
    const opportunities = await listOpportunities(tx, orgId, { contactId: row.id, limit: 30 })
    const open = opportunities.items.filter((item) => item.status === "open").length
    const tasks = can("tasks.read") ? (await listContactTasks(tx, orgId, row.id)).length : 0
    lines.ventas =
      open + tasks > 0
        ? [open > 0 ? count(open, "oportunidad abierta", "oportunidades abiertas") : null, tasks > 0 ? count(tasks, "tarea", "tareas") : null].filter(Boolean).join(" · ")
        : "Nada abierto"
    const facts = await listPersonFacts(tx, orgId, row.id)
    lines.recuerda = facts[0]?.text ?? "Todavía nada"
    if (!patientId) lines.datos = row.phone || row.email ? "Aún no es paciente" : "Sin datos de contacto"
  }
  return { contactId: row.id, patientId, name: row.displayName, phone: row.phone, email: row.email, nextAppointment, lines, attention }
}
