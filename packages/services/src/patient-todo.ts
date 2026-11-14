import type { MissingPersonDatum } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { consentDocument } from "@odentia/db/schema/clinical-forms"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import { schedulableItemsOf } from "./booking-links.js"
import { type BudgetWithTotals, listBudgets } from "./budgets.js"
import { type RemoteSignBlock, remoteSignBlock } from "./clinical-forms.js"
import { getPatientMissingData, patientHealthToAsk } from "./patient-registration.js"
import { type VisitAsk, visitAskOf } from "./visit-answers.js"

/**
 * Lo que tiene por hacer quien decide por el paciente (entrega 2, «Un enlace por cosa»): una
 * sola definición para el recordatorio («tienes N cosas por hacer», `remoteTodoCount`), la
 * página «Tus pendientes» (que la pinta) y «Enviarme uno nuevo» (`hasTodo`). Nadie vuelve a
 * contar por su cuenta.
 */
export interface PatientTodo {
  /** Lo que falta en su ficha (`getPatientMissingData`); vacío si ya envió «Tus datos». */
  missing: MissingPersonDatum[]
  /** Su salud, opcional: si la clínica la pregunta, nadie la registró y nunca envió «Tus datos». */
  health: boolean
  /** Los consentimientos que se le enviaron a firmar y no firmó, el último enviado primero. */
  consents: Array<{ id: string; title: string; procedureRef: string | null; planItemId: string | null }>
  /**
   * Por qué esos consentimientos no se firman desde el teléfono (`remoteSignBlock`): entonces
   * se leen ahí y se firman en la cita, y no son algo que pueda hacer antes.
   */
  signBlock: RemoteSignBlock | null
  /**
   * «Tu visita» antes de la cita a la vista (a qué viene, si le duele), si la clínica lo pregunta y
   * aún no lo respondió. Va en la misma tarjeta que sus datos: «Antes de tu cita».
   */
  visit: VisitAsk | null
  /** Los presupuestos que esperan su respuesta, el último enviado primero. */
  budgets: BudgetWithTotals[]
  /** «Lo que aceptaste, por agendar». */
  toSchedule: Array<{ planItemId: string; title: string }>
}

/** Los consentimientos enviados a firmar y sin firmar: el último enviado primero, que es el que abre `abre=firma` sin `id`. */
export async function consentsToSign(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<PatientTodo["consents"]> {
  return tx
    .select({
      id: consentDocument.id,
      title: consentDocument.titleSnapshot,
      procedureRef: consentDocument.procedureRef,
      planItemId: consentDocument.planItemId,
    })
    .from(consentDocument)
    .where(
      and(
        eq(consentDocument.organizationId, orgId),
        eq(consentDocument.patientId, patientId),
        eq(consentDocument.status, "pendiente"),
        isNotNull(consentDocument.linkSentAt),
        isNull(consentDocument.personSignedAt),
      ),
    )
    .orderBy(desc(consentDocument.linkSentAt), desc(consentDocument.createdAt))
}

/**
 * Los presupuestos que esperan su respuesta. El último enviado primero: es el que abre
 * `abre=presupuesto` sin `id` (el botón fijo de la plantilla aprobada). Lo enviado se sabe
 * por su traza (`financial_document.sent`); lo que nunca se envió (entregado en mano) va
 * después, el último presentado primero.
 */
export async function budgetsToAnswer(tx: Db, orgId: string, patientId: string): Promise<BudgetWithTotals[]> {
  const budgets = (await listBudgets(tx, orgId, patientId)).filter(
    (budget) => budget.status !== "borrador" && budget.awaitsAnswer,
  )
  if (budgets.length < 2) return budgets
  const sentRows = await tx
    .select({
      id: sql<string>`${auditEvent.metadata}->>'documentId'`,
      at: sql<Date>`max(${auditEvent.createdAt})`.mapWith(auditEvent.createdAt),
    })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.organizationId, orgId),
        eq(auditEvent.action, "financial_document.sent"),
        sql`${auditEvent.metadata}->>'documentType' = 'budget'`,
        inArray(
          sql<string>`${auditEvent.metadata}->>'documentId'`,
          budgets.map((budget) => budget.id),
        ),
      ),
    )
    .groupBy(sql`${auditEvent.metadata}->>'documentId'`)
  const sentAt = new Map(sentRows.map((row) => [row.id, row.at.getTime()]))
  const presented = (budget: BudgetWithTotals) => (budget.presentedAt ?? budget.createdAt).getTime()
  return budgets.sort(
    (a, b) => (sentAt.get(b.id) ?? -1) - (sentAt.get(a.id) ?? -1) || presented(b) - presented(a),
  )
}

export async function patientTodo(
  tx: Db,
  orgId: string,
  input: {
    patientId: string
    /** Quien lo haría (y firmaría): la persona del enlace o quien recibe el recordatorio. */
    contactId: string
    /** Ya envió «Tus datos» desde este enlace: no se le vuelven a pedir. */
    dataSubmitted?: boolean
    /** La cita por venir a la vista (la del enlace o la del recordatorio): solo con ella, «Tu visita». */
    appointmentId: string | null
  },
): Promise<PatientTodo> {
  const { patientId } = input
  const consents = await consentsToSign(tx, orgId, patientId)
  return {
    missing: input.dataSubmitted ? [] : await getPatientMissingData(tx, orgId, patientId),
    health: !input.dataSubmitted && (await patientHealthToAsk(tx, orgId, patientId)),
    consents,
    signBlock: consents.length > 0 ? await remoteSignBlock(tx, orgId, patientId, input.contactId) : null,
    visit: await visitAskOf(tx, orgId, { patientId, appointmentId: input.appointmentId }),
    budgets: await budgetsToAnswer(tx, orgId, patientId),
    toSchedule: await schedulableItemsOf(tx, orgId, patientId),
  }
}

/** Le queda algo que la página le muestra para hacer: si no, el enlace ya cumplió y pedir otro no sirve. */
export function hasTodo(todo: PatientTodo): boolean {
  return (
    todo.missing.length > 0 ||
    todo.health ||
    todo.consents.length > 0 ||
    todo.visit !== null ||
    todo.budgets.length > 0 ||
    todo.toSchedule.length > 0
  )
}

/**
 * Cuántas cosas puede hacer desde su teléfono, una por tarjeta de la página: «Antes de tu cita»
 * (sus datos y su visita, una sola tarjeta), cada consentimiento que firma a distancia, cada
 * presupuesto y lo aceptado por agendar. Un consentimiento que solo se firma en la cita no cuenta.
 * La salud, opcional, cuenta como sus datos solo si `health`; «Tu visita» cuenta cuando se le
 * pregunta: es lo que se le pide antes de cada cita (entrega 8), y con sus datos es una sola cosa.
 */
export function remoteTodoCount(todo: PatientTodo, options: { health?: boolean } = {}): { data: boolean; total: number } {
  const data = todo.missing.length > 0 || (options.health === true && todo.health)
  const consents = todo.signBlock ? 0 : todo.consents.length
  const total =
    (data || todo.visit ? 1 : 0) +
    consents +
    todo.budgets.length +
    (todo.toSchedule.length > 0 ? 1 : 0)
  return { data, total }
}
