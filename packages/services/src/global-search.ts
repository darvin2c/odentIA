/**
 * Buscador rápido (Ctrl+K; lienzo «Buscador rápido odentIA», aprobado el
 * 2026-10-19; ADR 0066). Una sola búsqueda para la ventana y, cuando lo tenga,
 * para el agente: busca en casi todo lo de la clínica y entrega cada resultado
 * debajo de su dueño, una persona o una cosa (un servicio, un proveedor, un
 * profesional), para que se vea de quién es sin abrir nada.
 *
 * - Por letras y sin tildes (`search-text.ts`); los números («987 654»,
 *   «HC-000123», «OC-12», «B001-000123») por sus dígitos o su número.
 * - Cada tipo pide su permiso, el mismo de su pantalla, y las mismas reglas de
 *   su lista (presupuestos propios del odontólogo, tareas de su área): el
 *   servidor decide qué devuelve. Quien no es paciente solo aparece como dueño
 *   para quien tiene `crm.read`, salvo en sus conversaciones, que ya ve en la Bandeja.
 * - Lo clínico (atenciones, notas, diagnósticos, recetas, documentos) devuelve
 *   una línea, y solo lo que se muestra va al registro de accesos, como si se
 *   abriera la ficha.
 * - El significado (`searchMeaningOwners`) solo ordena servicios, promociones y
 *   respuestas: quien llama decide si la frase puede ir al proveedor.
 * - Buscar nunca identifica: un teléfono compartido trae a las dos personas.
 */
import { testOnlyPersonSql } from "./conversation-state.js"
import type { Db } from "@odentia/db"
import { type SQL, sql } from "drizzle-orm"
import { isProfessional, ownBudgetOf } from "./budgets.js"
import type { ClinicalAccessResource } from "./clinical-access.js"
import { purchaseOrderLabel } from "./finance.js"
import { accountBalances } from "./payments.js"
import { PURCHASE_STATUS_WORDS } from "./purchase-balance.js"
import { personSearchCondition } from "./person-search.js"
import {
  digitsContain,
  foldedStartsWith,
  foldedWordsMatch,
  referenceNumber,
  searchDigits,
} from "./search-text.js"
import { pageTasks, taskAreasOfRole } from "./tasks.js"

/** Tipos que se pueden quitar con el filtro de la ventana. */
export const SEARCH_TYPES = [
  "persona",
  "cita",
  "conversacion",
  "clinica",
  "documento",
  "dinero",
  "tarea",
  "oportunidad",
  "servicio",
  "inventario",
  "equipo",
  "respuesta",
] as const
export type SearchType = (typeof SEARCH_TYPES)[number]

/** Adónde lleva Enter: la pantalla arma la dirección. */
export type SearchTarget =
  | {
      screen: "persona"
      personId: string
      section?: "cuenta" | "plan" | "documentos" | "historia"
      budgetId?: string
      documentId?: string
    }
  | { screen: "cita"; appointmentId: string }
  | { screen: "conversacion"; conversationId: string }
  | { screen: "tarea"; taskId: string }
  | { screen: "oportunidad"; opportunityId: string }
  | { screen: "servicios"; q: string }
  | { screen: "promociones" }
  | { screen: "producto"; productId: string }
  | { screen: "compra"; purchaseOrderId: string }
  | { screen: "proveedores" }
  | { screen: "gastos"; spentAt: string }
  | { screen: "comisiones"; professionalUserId: string; year: number; month: number }
  | { screen: "agenda"; professionalUserId?: string; branchId?: string }
  | { screen: "conocimiento"; q: string }

export type SearchItemKind =
  | "cita"
  | "control"
  | "conversacion"
  | "mensaje"
  | "debe"
  | "presupuesto"
  | "comprobante"
  | "gasto"
  | "comision"
  | "nota"
  | "atencion"
  | "diagnostico"
  | "receta"
  | "documento"
  | "consentimiento"
  | "tarea"
  | "oportunidad"
  | "promocion"
  | "compra"
  | "producto"

export interface SearchMoney {
  cents: number
  currency: string
}

export interface SearchItem {
  id: string
  type: SearchType
  kind: SearchItemKind
  title: string
  detail: string | null
  at: string | null
  amount: SearchMoney | null
  /** Coincide con lo escrito (no es solo lo pendiente de un dueño encontrado por su nombre). */
  matched: boolean
  target: SearchTarget
}

export type SearchOwnerKind =
  | "persona"
  | "servicio"
  | "promocion"
  | "producto"
  | "proveedor"
  | "profesional"
  | "sede"
  | "respuesta"
  | "gasto"
  | "tarea"

export interface SearchOwner {
  key: string
  kind: SearchOwnerKind
  type: SearchType
  id: string
  title: string
  /** «Paciente», «Aún no es paciente», «Responsable», «Servicio»… */
  badge: string
  detail: string | null
  /** El dueño mismo coincide con lo escrito (su nombre, documento, teléfono). */
  matched: boolean
  target: SearchTarget
  items: SearchItem[]
  /** Cuántas cosas más tiene, además de las que se muestran. */
  more: number
  /** Precio de un servicio, cuando lo tiene. */
  amount?: SearchMoney | null
  /** El texto de una respuesta del agente, para copiarlo a quien no abre Conocimiento. */
  text?: string
}

export interface GlobalSearchInput {
  q: string
  can: (permission: string) => boolean
  viewer: { userId: string; role: string }
  types?: readonly SearchType[]
  /** Cuántas cosas se muestran por dueño. */
  perOwner?: number
  now?: Date
}

export interface GlobalSearchResult {
  owners: SearchOwner[]
  /** Lo clínico que se mostró: la ruta lo anota en el registro de accesos. */
  clinicalReads: Array<{ patientId: string; resource: ClinicalAccessResource }>
  /** Encontró personas o algo de la historia: la frase no debe ir al proveedor de vectores. */
  personal: boolean
}

const PER_TYPE = 20
const MAX_OWNERS = 30
/** En mensajes y notas, las palabras de menos letras no distinguen nada. */
const LONG_TEXT_WORD = 3

type Row = Record<string, unknown>
type Read = { patientId: string; resource: ClinicalAccessResource }

/** `(…)` con un parámetro por id, para `x in ${inList(ids)}`. */
const inList = (ids: readonly string[]): SQL =>
  sql`(${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`
const iso = (value: unknown): string | null =>
  value == null ? null : new Date(value as string).toISOString()
const str = (value: unknown): string | null => (value == null ? null : String(value))
const num = (value: unknown): number => Number(value ?? 0)
const hc = (value: unknown): string | null =>
  value == null ? null : `HC-${String(value).padStart(6, "0")}`
const itemKey = (item: SearchItem) => `${item.kind}:${item.id}`

/** Columnas de una persona y de quién habla por ella (para dueños). */
const personColumns = sql`c.id, c.display_name, c.doc_type, c.doc_number, c.phone, p.id as patient_id, p.patient_number,
  (select string_agg(spoken.display_name, ', ') from (
    select pp.display_name from patient_contact pc
    join patient pt on pt.organization_id = pc.organization_id and pt.id = pc.patient_id
    join contact pp on pp.organization_id = pt.organization_id and pp.id = pt.person_id
    where pc.organization_id = c.organization_id and pc.contact_id = c.id and pc.relationship <> 'self'
    order by pp.display_name limit 2) spoken) as speaks_for`

export async function searchEverything(
  tx: Db,
  orgId: string,
  input: GlobalSearchInput,
): Promise<GlobalSearchResult> {
  const q = input.q.trim()
  if (q.length < 2) return { owners: [], clinicalReads: [], personal: false }
  const can = input.can
  const on = (type: SearchType) => !input.types || input.types.includes(type)
  const digits = searchDigits(q)
  const perOwner = Math.min(Math.max(input.perOwner ?? 4, 1), 10)
  const now = input.now ?? new Date()
  const seesPeople = can("patients.read")
  const seesNonPatients = can("crm.read")
  const professional = isProfessional(input.viewer.role)

  const owners = new Map<string, SearchOwner>()
  /** Lo clínico de cada cosa encontrada: se anota solo si se muestra. */
  const readOf = new Map<string, Read>()
  const itemsByPerson = new Map<string, SearchItem[]>()

  const addToPerson = (personId: string, item: SearchItem, read?: Read) => {
    const list = itemsByPerson.get(personId) ?? []
    if (!list.some((existing) => itemKey(existing) === itemKey(item))) list.push(item)
    itemsByPerson.set(personId, list)
    if (read) readOf.set(itemKey(item), read)
  }
  const addOwner = (owner: SearchOwner) => {
    const existing = owners.get(owner.key)
    if (existing) {
      existing.matched ||= owner.matched
      for (const item of owner.items)
        if (!existing.items.some((i) => itemKey(i) === itemKey(item))) existing.items.push(item)
    } else owners.set(owner.key, owner)
  }
  const rows = (query: SQL) => tx.execute<Row>(query) as unknown as Promise<Row[]>

  // --- Personas por su nombre, documento, correo, teléfono o historia -------
  const matchedPeople: Row[] = []
  if (seesPeople && on("persona")) {
    const record = referenceNumber(q, ["hc"])
    const found = await rows(sql`
      select ${personColumns}
      from contact c
      left join patient p on p.organization_id = c.organization_id and p.person_id = c.id
      where c.organization_id = ${orgId} and c.is_active and c.screen is null and not ${testOnlyPersonSql(sql.raw("c"))}
        ${seesNonPatients ? sql`` : sql`and p.id is not null`}
        and (${personSearchCondition(q, { displayName: sql`c.display_name`, phone: sql`c.phone`, email: sql`c.email`, docNumber: sql`c.doc_number` })}
          ${record == null ? sql`` : sql`or p.patient_number = ${record}`})
      order by ${record == null ? sql`` : sql`(p.patient_number = ${record}) desc nulls last,`}
        ${foldedStartsWith(sql`c.display_name`, q)} desc, c.display_name, c.id
      limit ${PER_TYPE}`)
    matchedPeople.push(...found)
  }

  // --- Citas por servicio o motivo ------------------------------------------
  if (seesPeople && can("appointments.read") && on("cita") && !digits) {
    const found = await rows(sql`
      select a.id, a.service_name, a.reason, a.starts_at, pp.id as person_id, u.name as professional
      from appointment a
      join patient p on p.organization_id = a.organization_id and p.id = a.patient_id
      join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
      left join "user" u on u.id = a.professional_user_id
      where a.organization_id = ${orgId} and a.status in ('programada', 'confirmada')
        and a.starts_at >= ${new Date(now.getTime() - 86_400_000).toISOString()}
        and ${foldedWordsMatch([sql`a.service_name`, sql`a.reason`], q)}
      order by a.starts_at limit ${PER_TYPE}`)
    for (const row of found) addToPerson(String(row.person_id), appointmentItem(row, true))
  }

  // --- Lo que dicen los mensajes --------------------------------------------
  if (can("conversations.read") && on("conversacion") && !digits) {
    const found = await rows(sql`
      select m.id, m.body, m.created_at, conv.id as conversation_id, conv.contact_id, ch.channel
      from message m
      join conversation conv on conv.organization_id = m.organization_id and conv.id = m.conversation_id
      join contact c on c.organization_id = conv.organization_id and c.id = conv.contact_id
      left join channel_connection ch on ch.organization_id = conv.organization_id and ch.id = conv.channel_connection_id
      where m.organization_id = ${orgId} and m.redacted_at is null and c.screen is null and not conv.is_test
        and ${foldedWordsMatch([sql`m.body`], q, { minWord: LONG_TEXT_WORD })}
      order by m.created_at desc limit ${PER_TYPE}`)
    for (const row of found)
      addToPerson(String(row.contact_id), {
        id: String(row.id),
        type: "conversacion",
        kind: "mensaje",
        title: excerpt(String(row.body ?? ""), q),
        detail: channelLabel(str(row.channel)),
        at: iso(row.created_at),
        amount: null,
        matched: true,
        target: { screen: "conversacion", conversationId: String(row.conversation_id) },
      })
  }

  // --- Historia clínica: atenciones, notas, diagnósticos y recetas ----------
  if (seesPeople && can("clinical.read") && on("clinica") && !digits) {
    const clinical = (
      row: Row,
      kind: SearchItemKind,
      title: string,
      resource: ClinicalAccessResource,
      extra: Partial<SearchItem> = {},
    ) =>
      addToPerson(
        String(row.person_id),
        {
          id: String(row.id),
          type: "clinica",
          kind,
          title,
          detail: null,
          at: iso(row.at),
          amount: null,
          matched: true,
          target: { screen: "persona", personId: String(row.person_id), section: "historia" },
          ...extra,
        },
        { patientId: String(row.patient_id), resource },
      )
    const encounters = await rows(sql`
      select e.id, e.reason, e.started_at as at, p.id as patient_id, p.person_id
      from encounter e join patient p on p.organization_id = e.organization_id and p.id = e.patient_id
      where e.organization_id = ${orgId} and e.status <> 'anulada'
        and ${foldedWordsMatch([sql`e.reason`, sql`e.present_illness`, sql`e.evolution`, sql`e.indications`], q, { minWord: LONG_TEXT_WORD })}
      order by e.started_at desc nulls last limit ${PER_TYPE}`)
    for (const row of encounters)
      clinical(row, "atencion", excerpt(String(row.reason ?? "Atención"), q), "atenciones")
    const notes = await rows(sql`
      select n.id, n.note, n.created_at as at, p.id as patient_id, p.person_id
      from clinical_note n join patient p on p.organization_id = n.organization_id and p.id = n.patient_id
      where n.organization_id = ${orgId} and ${foldedWordsMatch([sql`n.note`], q, { minWord: LONG_TEXT_WORD })}
      order by n.created_at desc limit ${PER_TYPE}`)
    for (const row of notes) clinical(row, "nota", excerpt(String(row.note ?? ""), q), "notas")
    const diagnoses = await rows(sql`
      select d.id, d.diagnosis_code, dc.title, d.tooth_number, null as at, p.id as patient_id, p.person_id
      from encounter_diagnosis d
      join patient p on p.organization_id = d.organization_id and p.id = d.patient_id
      left join diagnosis_code dc on dc.system_key = d.diagnosis_system and dc.code = d.diagnosis_code
      where d.organization_id = ${orgId} and d.voided_at is null
        and ${foldedWordsMatch([sql`dc.title`, sql`d.diagnosis_code`, sql`d.note`], q)}
      limit ${PER_TYPE}`)
    for (const row of diagnoses)
      clinical(
        row,
        "diagnostico",
        [str(row.diagnosis_code), str(row.title)].filter(Boolean).join(" · "),
        "diagnosticos",
        {
          detail: row.tooth_number == null ? null : `Pieza ${row.tooth_number}`,
        },
      )
    const prescriptions = await rows(sql`
      select pi.id, pi.medication_name, pi.strength, pr.issued_at as at, p.id as patient_id, p.person_id
      from prescription_item pi
      join prescription pr on pr.organization_id = pi.organization_id and pr.id = pi.prescription_id
      join patient p on p.organization_id = pi.organization_id and p.id = pi.patient_id
      where pi.organization_id = ${orgId} and pr.status <> 'anulada'
        and ${foldedWordsMatch([sql`pi.medication_name`, sql`pi.generic_name`, sql`pi.brand_name`], q)}
      order by pr.issued_at desc nulls last limit ${PER_TYPE}`)
    for (const row of prescriptions)
      clinical(
        row,
        "receta",
        [str(row.medication_name), str(row.strength)].filter(Boolean).join(" "),
        "recetas",
        {
          target: { screen: "persona", personId: String(row.person_id), section: "documentos" },
        },
      )
  }

  // --- Documentos e imágenes (piden permiso clínico, como su lista) ---------
  if (seesPeople && can("clinical.read") && on("documento") && !digits) {
    const documents = await rows(sql`
      select d.id, d.label, d.category, coalesce(d.captured_at, d.created_at) as at, p.id as patient_id, p.person_id
      from patient_document d join patient p on p.organization_id = d.organization_id and p.id = d.patient_id
      where d.organization_id = ${orgId} and d.retired_at is null and ${foldedWordsMatch([sql`d.label`, sql`d.category`], q)}
      order by at desc limit ${PER_TYPE}`)
    for (const row of documents)
      addToPerson(
        String(row.person_id),
        {
          id: String(row.id),
          type: "documento",
          kind: "documento",
          title: str(row.label) ?? documentCategoryLabel(str(row.category)),
          detail: documentCategoryLabel(str(row.category)),
          at: iso(row.at),
          amount: null,
          matched: true,
          target: {
            screen: "persona",
            personId: String(row.person_id),
            section: "documentos",
            documentId: String(row.id),
          },
        },
        { patientId: String(row.patient_id), resource: "documentos" },
      )
    const consents = await rows(sql`
      select cd.id, cd.title_snapshot, cd.status, coalesce(cd.signed_at, cd.informed_at) as at, p.id as patient_id, p.person_id
      from consent_document cd join patient p on p.organization_id = cd.organization_id and p.id = cd.patient_id
      where cd.organization_id = ${orgId} and ${foldedWordsMatch([sql`cd.title_snapshot`], q)}
      order by at desc nulls last limit ${PER_TYPE}`)
    for (const row of consents)
      addToPerson(
        String(row.person_id),
        {
          id: String(row.id),
          type: "documento",
          kind: "consentimiento",
          title: str(row.title_snapshot) ?? "Consentimiento",
          detail: str(row.status),
          at: iso(row.at),
          amount: null,
          matched: true,
          target: { screen: "persona", personId: String(row.person_id), section: "documentos" },
        },
        { patientId: String(row.patient_id), resource: "consentimientos" },
      )
  }

  // --- Dinero: presupuestos, comprobantes, gastos y comisiones --------------
  // El número de un comprobante o presupuesto: «B001-000123» → 123, «P-0045» → 45.
  const docNumber = digits
    ? Number(digits.slice(-6))
    : referenceNumber(q, ["p", "ticket", "b001", "presupuesto"])
  if (seesPeople && can("budgets.read") && on("dinero")) {
    const budgets = await rows(sql`
      select b.id, b.budget_number, b.title, b.status, coalesce(b.presented_at, b.created_at) as at, p.person_id
      from treatment_budget b join patient p on p.organization_id = b.organization_id and p.id = b.patient_id
      where b.organization_id = ${orgId} and b.status not in ('sustituido', 'cancelado')
        ${professional ? sql`and ${ownBudgetOf({ id: sql`b.id`, organizationId: sql`b.organization_id`, createdBy: sql`b.created_by` }, input.viewer.userId)}` : sql``}
        and ${docNumber != null ? sql`b.budget_number = ${docNumber}` : foldedWordsMatch([sql`b.title`, sql`b.notes`], q)}
      order by at desc limit ${PER_TYPE}`)
    for (const row of budgets) addToPerson(String(row.person_id), budgetItem(row, true))
  }
  if (seesPeople && can("finance.read") && on("dinero") && docNumber != null) {
    const tickets = await rows(sql`
      select t.id, t.ticket_number, t.total_cents, t.currency, t.created_at, p.person_id
      from payment_ticket t join patient p on p.organization_id = t.organization_id and p.id = t.patient_id
      where t.organization_id = ${orgId} and t.voided_at is null and t.ticket_number = ${docNumber}
      order by t.created_at desc limit ${PER_TYPE}`)
    for (const row of tickets)
      addToPerson(String(row.person_id), {
        id: String(row.id),
        type: "dinero",
        kind: "comprobante",
        title: `Ticket N.º ${String(row.ticket_number).padStart(6, "0")}`,
        detail: null,
        at: iso(row.created_at),
        amount: { cents: num(row.total_cents), currency: String(row.currency) },
        matched: true,
        target: { screen: "persona", personId: String(row.person_id), section: "cuenta" },
      })
  }
  if (can("finance.read") && on("dinero") && !digits) {
    const expenses = await rows(sql`
      select e.id, e.concept, e.category, e.amount_cents, e.currency, e.spent_at, s.id as supplier_id, s.name as supplier
      from expense e
      left join purchase_order po on po.organization_id = e.organization_id and po.id = e.purchase_order_id
      left join supplier s on s.organization_id = po.organization_id and s.id = po.supplier_id
      where e.organization_id = ${orgId} and e.voided_at is null
        and ${foldedWordsMatch([sql`e.concept`, sql`e.category`, sql`e.notes`, sql`s.name`], q)}
      order by e.spent_at desc limit ${PER_TYPE}`)
    for (const row of expenses) {
      const item: SearchItem = {
        id: String(row.id),
        type: "dinero",
        kind: "gasto",
        title: [str(row.concept), str(row.category)].filter(Boolean).join(" · "),
        detail: null,
        at: iso(row.spent_at),
        amount: { cents: num(row.amount_cents), currency: String(row.currency) },
        matched: true,
        target: { screen: "gastos", spentAt: iso(row.spent_at) ?? now.toISOString() },
      }
      if (row.supplier_id && can("inventory.read"))
        addOwner(supplierOwner({ id: row.supplier_id, name: row.supplier }, false, [item]))
      else
        addOwner({
          key: `gasto:${row.id}`,
          kind: "gasto",
          type: "dinero",
          id: String(row.id),
          title: item.title,
          badge: "Gasto",
          detail: null,
          matched: true,
          target: item.target,
          items: [item],
          more: 0,
        })
    }
  }
  const seesAllCommissions = can("finance.read")
  if ((seesAllCommissions || can("commissions.read")) && on("dinero") && !digits) {
    const commissions = await rows(sql`
      select cs.id, cs.professional_user_id, cs.period_year, cs.period_month, cs.commission_cents, cs.currency, cs.status, u.name
      from commission_settlement cs join "user" u on u.id = cs.professional_user_id
      where cs.organization_id = ${orgId} and cs.voided_at is null
        ${seesAllCommissions ? sql`` : sql`and cs.professional_user_id = ${input.viewer.userId}`}
        and ${foldedWordsMatch([sql`u.name`, sql`'comision'`], q)}
      order by cs.period_year desc, cs.period_month desc limit ${PER_TYPE}`)
    for (const row of commissions)
      addOwner(
        professionalOwner({ id: row.professional_user_id, name: row.name }, false, [
          {
            id: String(row.id),
            type: "dinero",
            kind: "comision",
            title: `Comisión de ${monthName(num(row.period_month))} ${row.period_year}`,
            detail: str(row.status),
            at: null,
            amount: { cents: num(row.commission_cents), currency: String(row.currency) },
            matched: true,
            target: {
              screen: "comisiones",
              professionalUserId: String(row.professional_user_id),
              year: num(row.period_year),
              month: num(row.period_month),
            },
          },
        ]),
      )
  }

  // --- Tareas (con la misma regla de quién ve cuáles que su lista) ----------
  const looseTasks: SearchItem[] = []
  if (can("tasks.read") && on("tarea") && !digits) {
    const page = await pageTasks(tx, orgId, {
      viewer: {
        userId: input.viewer.userId,
        areas: taskAreasOfRole(input.viewer.role),
        all: can("tasks.all"),
      },
      view: "abiertas",
      q,
      limit: PER_TYPE,
    })
    const patientIds = page.items
      .filter((task) => !task.contactId && task.patientId)
      .map((task) => task.patientId as string)
    const personOf = await personIdsOfPatients(tx, orgId, patientIds)
    for (const task of page.items) {
      const item: SearchItem = {
        id: task.id,
        type: "tarea",
        kind: "tarea",
        title: task.title,
        detail: null,
        at: task.dueAt,
        amount: null,
        matched: true,
        target: { screen: "tarea", taskId: task.id },
      }
      const personId = task.contactId ?? (task.patientId ? personOf.get(task.patientId) : undefined)
      if (personId) addToPerson(personId, item)
      else looseTasks.push(item)
    }
  }

  // --- Oportunidades ---------------------------------------------------------
  if (seesNonPatients && on("oportunidad") && !digits) {
    const found = await rows(sql`
      select o.id, o.title, o.interest_text, o.contact_id, o.created_at from opportunity o
      where o.organization_id = ${orgId} and o.status = 'open' and ${foldedWordsMatch([sql`o.title`, sql`o.interest_text`], q)}
      order by o.created_at desc limit ${PER_TYPE}`)
    for (const row of found) addToPerson(String(row.contact_id), opportunityItem(row, true))
  }

  // --- Servicios y promociones ----------------------------------------------
  if (can("catalog.read") && on("servicio") && !digits) {
    const services = await rows(sql`
      select s.id, s.name, s.code, s.price_cents, s.currency, s.duration_min from service_catalog s
      where s.organization_id = ${orgId} and s.is_active and ${foldedWordsMatch([sql`s.name`, sql`s.code`], q)}
      order by ${foldedStartsWith(sql`s.name`, q)} desc, s.name limit ${PER_TYPE}`)
    for (const row of services) addOwner(serviceOwner(row, true))
    const promotions = await rows(sql`
      select pr.id, pr.name from promotion pr
      where pr.organization_id = ${orgId} and pr.is_active and (pr.ends_at is null or pr.ends_at >= ${now.toISOString()})
        and ${foldedWordsMatch([sql`pr.name`, sql`pr.conditions`], q)}
      order by pr.name limit ${PER_TYPE}`)
    for (const row of promotions) addOwner(promotionOwner(row, true))
  }

  // --- Inventario, compras y proveedores ------------------------------------
  // Con precios o sin ellos (recepción, `inventory.stock`): aquí no viaja ningún precio.
  if ((can("inventory.read") || can("inventory.stock")) && on("inventario")) {
    const order = referenceNumber(q, ["oc"])
    const suppliers = await rows(sql`
      select s.id, s.name, s.doc_number from supplier s
      where s.organization_id = ${orgId} and s.is_active
        and ${digits ? digitsContain(sql`s.doc_number`, digits) : foldedWordsMatch([sql`s.name`, sql`s.doc_number`], q)}
      order by s.name limit ${PER_TYPE}`)
    for (const row of suppliers) addOwner(supplierOwner(row, true, []))
    const orders = await rows(sql`
      select po.id, po.order_number, po.status, po.created_at, s.id as supplier_id, s.name as supplier
      from purchase_order po join supplier s on s.organization_id = po.organization_id and s.id = po.supplier_id
      where po.organization_id = ${orgId} and po.status <> 'cancelada'
        and ${order != null ? sql`po.order_number = ${order}` : digits ? sql`false` : foldedWordsMatch([sql`s.name`, sql`po.notes`], q)}
      order by po.created_at desc limit ${PER_TYPE}`)
    for (const row of orders)
      addOwner(
        supplierOwner({ id: row.supplier_id, name: row.supplier }, false, [purchaseItem(row)]),
      )
    if (!digits) {
      const products = await rows(sql`
        select pd.id, pd.name, pd.sku, pd.unit from product pd
        where pd.organization_id = ${orgId} and pd.is_active and ${foldedWordsMatch([sql`pd.name`, sql`pd.sku`], q)}
        order by ${foldedStartsWith(sql`pd.name`, q)} desc, pd.name limit ${PER_TYPE}`)
      for (const row of products)
        addOwner({
          key: `producto:${row.id}`,
          kind: "producto",
          type: "inventario",
          id: String(row.id),
          title: String(row.name),
          badge: "Producto",
          detail: [str(row.sku), str(row.unit)].filter(Boolean).join(" · ") || null,
          matched: true,
          target: { screen: "producto", productId: String(row.id) },
          items: [],
          more: 0,
        })
    }
  }

  // --- Equipo y sedes --------------------------------------------------------
  if (on("equipo") && !digits) {
    const team = await rows(sql`
      select u.id, u.name, pf.professional_title from member m
      join "user" u on u.id = m.user_id
      left join professional_profile pf on pf.organization_id = m.organization_id and pf.user_id = m.user_id
      where m.organization_id = ${orgId} and ${foldedWordsMatch([sql`u.name`, sql`pf.professional_title`], q)}
      order by u.name limit ${PER_TYPE}`)
    for (const row of team) addOwner(professionalOwner(row, true, []))
    const branches = await rows(sql`
      select b.id, b.name, b.address_line1, b.city from branch b
      where b.organization_id = ${orgId} and b.is_active and ${foldedWordsMatch([sql`b.name`, sql`b.city`, sql`b.address_line1`], q)}
      order by b.name limit ${PER_TYPE}`)
    for (const row of branches)
      addOwner({
        key: `sede:${row.id}`,
        kind: "sede",
        type: "equipo",
        id: String(row.id),
        title: String(row.name),
        badge: "Sede",
        detail: [str(row.address_line1), str(row.city)].filter(Boolean).join(" · ") || null,
        matched: true,
        target: { screen: "agenda", branchId: String(row.id) },
        items: [],
        more: 0,
      })
  }

  // --- Respuestas publicadas del agente --------------------------------------
  if (can("conversations.read") && on("respuesta") && !digits) {
    const answers = await rows(sql`
      select k.id, k.title, k.body from agent_knowledge_entry k
      where k.organization_id = ${orgId} and k.status = 'publicada' and ${foldedWordsMatch([sql`k.title`, sql`k.body`], q)}
      order by k.title limit ${PER_TYPE}`)
    for (const row of answers) addOwner(answerOwner(row, true))
  }

  // --- Dueños personas: los encontrados por su nombre, con lo pendiente -----
  const matchedIds = new Set(matchedPeople.map((row) => String(row.id)))
  const extraIds = [...itemsByPerson.keys()].filter((id) => !matchedIds.has(id))
  const extraPeople = extraIds.length
    ? await rows(sql`
        select ${personColumns}
        from contact c left join patient p on p.organization_id = c.organization_id and p.person_id = c.id
        where c.organization_id = ${orgId} and c.is_active and c.screen is null and c.id in ${inList(extraIds)}`)
    : []
  const pendingByPerson = await pendingOfPeople(tx, orgId, matchedPeople.slice(0, 6), {
    can,
    now,
    on,
    userId: input.viewer.userId,
    professional,
  })
  for (const [index, row] of [...matchedPeople, ...extraPeople].entries()) {
    const id = String(row.id)
    const matched = index < matchedPeople.length
    const found = itemsByPerson.get(id) ?? []
    itemsByPerson.delete(id)
    const pending = (pendingByPerson.get(id) ?? []).filter(
      (item) => !found.some((f) => itemKey(f) === itemKey(item)),
    )
    const items = [...found, ...pending]
    let target: SearchTarget = { screen: "persona", personId: id }
    // Sin crm.read, quien aún no es paciente no tiene página: solo su conversación.
    if (!row.patient_id && !seesNonPatients) {
      const conversation = items.find((item) => item.type === "conversacion")
      if (!conversation) {
        looseTasks.push(...items.filter((item) => item.type === "tarea"))
        continue
      }
      target = conversation.target
    }
    addOwner({
      key: `persona:${id}`,
      kind: "persona",
      type: "persona",
      id,
      title: String(row.display_name),
      badge: row.patient_id ? "Paciente" : row.speaks_for ? "Responsable" : "Aún no es paciente",
      detail: personDetail(row, seesPeople),
      matched,
      target,
      items,
      more: 0,
    })
  }
  // Lo de personas en Spam, archivadas o que no se ven: solo las tareas quedan, sueltas.
  for (const items of itemsByPerson.values())
    looseTasks.push(...items.filter((item) => item.type === "tarea"))
  for (const task of looseTasks)
    addOwner({
      key: `tarea:${task.id}`,
      kind: "tarea",
      type: "tarea",
      id: task.id,
      title: task.title,
      badge: "Tarea",
      detail: null,
      matched: true,
      target: task.target,
      items: [],
      more: 0,
    })

  // --- Orden, tope y lo clínico que se muestra -------------------------------
  const sorted = [...owners.values()].sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? -1 : 1
    if (a.matched && (a.kind === "persona") !== (b.kind === "persona"))
      return a.kind === "persona" ? -1 : 1
    if (!a.matched) return latest(b) - latest(a)
    return 0
  })
  const result = sorted.slice(0, MAX_OWNERS).map((owner) => {
    const items = [...owner.items].sort((a, b) => Number(b.matched) - Number(a.matched))
    return { ...owner, items: items.slice(0, perOwner), more: Math.max(items.length - perOwner, 0) }
  })
  const reads = new Map<string, Read>()
  for (const owner of result)
    for (const item of owner.items) {
      const read = readOf.get(itemKey(item))
      if (read) reads.set(`${read.patientId}:${read.resource}`, read)
    }
  const personal =
    result.some((owner) => owner.kind === "persona" && owner.matched) || readOf.size > 0
  return { owners: result, clinicalReads: [...reads.values()], personal }
}

/**
 * Lo que el significado encontró y las letras no: servicios, promociones y
 * respuestas, en el orden de `ranked`. `exclude` son las claves ya mostradas.
 */
export async function searchMeaningOwners(
  tx: Db,
  orgId: string,
  input: {
    can: (permission: string) => boolean
    types?: readonly SearchType[]
    ranked: { services: string[]; promotions: string[]; answers: string[] }
    exclude: ReadonlySet<string>
    now?: Date
  },
): Promise<SearchOwner[]> {
  const on = (type: SearchType) => !input.types || input.types.includes(type)
  const now = input.now ?? new Date()
  const rows = (query: SQL) => tx.execute<Row>(query) as unknown as Promise<Row[]>
  const pick = (ids: string[], found: Row[]) =>
    ids.map((id) => found.find((row) => String(row.id) === id)).filter((row): row is Row => !!row)
  const out: SearchOwner[] = []
  if (input.can("catalog.read") && on("servicio")) {
    const serviceIds = input.ranked.services.filter((id) => !input.exclude.has(`servicio:${id}`))
    if (serviceIds.length) {
      const found =
        await rows(sql`select s.id, s.name, s.code, s.price_cents, s.currency, s.duration_min from service_catalog s
        where s.organization_id = ${orgId} and s.is_active and s.id in ${inList(serviceIds)}`)
      out.push(...pick(serviceIds, found).map((row) => serviceOwner(row, false)))
    }
    const promotionIds = input.ranked.promotions.filter(
      (id) => !input.exclude.has(`promocion:${id}`),
    )
    if (promotionIds.length) {
      const found = await rows(sql`select pr.id, pr.name from promotion pr
        where pr.organization_id = ${orgId} and pr.is_active and (pr.ends_at is null or pr.ends_at >= ${now.toISOString()})
          and pr.id in ${inList(promotionIds)}`)
      out.push(...pick(promotionIds, found).map((row) => promotionOwner(row, false)))
    }
  }
  if (input.can("conversations.read") && on("respuesta")) {
    const answerIds = input.ranked.answers.filter((id) => !input.exclude.has(`respuesta:${id}`))
    if (answerIds.length) {
      const found = await rows(sql`select k.id, k.title, k.body from agent_knowledge_entry k
        where k.organization_id = ${orgId} and k.status = 'publicada' and k.id in ${inList(answerIds)}`)
      out.push(...pick(answerIds, found).map((row) => answerOwner(row, false)))
    }
  }
  return out.slice(0, 8)
}

/** Lo de hoy y lo pendiente de las personas encontradas por su nombre. */
async function pendingOfPeople(
  tx: Db,
  orgId: string,
  people: Row[],
  context: {
    can: (permission: string) => boolean
    now: Date
    on: (type: SearchType) => boolean
    userId: string
    professional: boolean
  },
): Promise<Map<string, SearchItem[]>> {
  const out = new Map<string, SearchItem[]>()
  const push = (personId: string, item: SearchItem) =>
    out.set(personId, [...(out.get(personId) ?? []), item])
  const patients = people.filter((row) => row.patient_id)
  const patientIds = patients.map((row) => String(row.patient_id))
  const personOfPatient = new Map(patients.map((row) => [String(row.patient_id), String(row.id)]))
  const personIds = people.map((row) => String(row.id))
  const { can, now, on } = context
  const run = (query: SQL) => tx.execute<Row>(query) as unknown as Promise<Row[]>

  if (patientIds.length && can("appointments.read") && on("cita")) {
    const next = await run(sql`
      select distinct on (a.patient_id) a.id, a.patient_id, a.service_name, a.reason, a.starts_at, u.name as professional
      from appointment a left join "user" u on u.id = a.professional_user_id
      where a.organization_id = ${orgId} and a.patient_id in ${inList(patientIds)}
        and a.status in ('programada', 'confirmada') and a.starts_at >= ${now.toISOString()}
      order by a.patient_id, a.starts_at`)
    for (const row of next)
      push(personOfPatient.get(String(row.patient_id)) as string, appointmentItem(row, false))
  }
  if (personIds.length && can("conversations.read") && on("conversacion")) {
    const latestConversation = await run(sql`
      select distinct on (conv.contact_id) conv.id, conv.contact_id, conv.last_message_at, ch.channel
      from conversation conv
      left join channel_connection ch on ch.organization_id = conv.organization_id and ch.id = conv.channel_connection_id
      where conv.organization_id = ${orgId} and conv.contact_id in ${inList(personIds)}
      order by conv.contact_id, conv.last_message_at desc nulls last`)
    for (const row of latestConversation)
      push(String(row.contact_id), {
        id: String(row.id),
        type: "conversacion",
        kind: "conversacion",
        title: channelLabel(str(row.channel)) ?? "Conversación",
        detail: null,
        at: iso(row.last_message_at),
        amount: null,
        matched: false,
        target: { screen: "conversacion", conversationId: String(row.id) },
      })
  }
  if (patientIds.length && can("finance.read") && on("dinero")) {
    const [charges, payments, applications, refunds] = await Promise.all([
      run(
        sql`select patient_id, currency, amount_cents, voided_at from patient_charge where organization_id = ${orgId} and patient_id in ${inList(patientIds)}`,
      ),
      run(
        sql`select id, patient_id, currency, amount_cents, voided_at from patient_payment where organization_id = ${orgId} and patient_id in ${inList(patientIds)}`,
      ),
      run(
        sql`select patient_id, payment_id, amount_cents, voided_at from patient_payment_application where organization_id = ${orgId} and patient_id in ${inList(patientIds)}`,
      ),
      run(sql`select pp.patient_id, r.payment_id, r.amount_cents from patient_payment_refund r
        join patient_payment pp on pp.organization_id = r.organization_id and pp.id = r.payment_id
        where r.organization_id = ${orgId} and pp.patient_id in ${inList(patientIds)}`),
    ])
    for (const patientId of patientIds) {
      const of = (list: Row[]) => list.filter((row) => String(row.patient_id) === patientId)
      const balances = accountBalances({
        charges: of(charges).map((r) => ({
          currency: String(r.currency),
          amountCents: num(r.amount_cents),
          voidedAt: r.voided_at as Date | null,
        })),
        payments: of(payments).map((r) => ({
          id: String(r.id),
          currency: String(r.currency),
          amountCents: num(r.amount_cents),
          voidedAt: r.voided_at as Date | null,
        })),
        applications: of(applications).map((r) => ({
          paymentId: String(r.payment_id),
          amountCents: num(r.amount_cents),
          voidedAt: r.voided_at as Date | null,
        })),
        refunds: of(refunds).map((r) => ({
          paymentId: String(r.payment_id),
          amountCents: num(r.amount_cents),
        })),
      })
      const personId = personOfPatient.get(patientId) as string
      for (const balance of balances.filter((b) => b.saldo > 0))
        push(personId, {
          id: `${patientId}:${balance.currency}`,
          type: "dinero",
          kind: "debe",
          title: "Saldo por cobrar",
          detail: null,
          at: null,
          amount: { cents: balance.saldo, currency: balance.currency },
          matched: false,
          target: { screen: "persona", personId, section: "cuenta" },
        })
    }
  }
  if (patientIds.length && can("budgets.read") && on("dinero")) {
    const open = await run(sql`
      select distinct on (b.patient_id) b.id, b.patient_id, b.budget_number, b.title, b.status, coalesce(b.presented_at, b.created_at) as at
      from treatment_budget b
      where b.organization_id = ${orgId} and b.patient_id in ${inList(patientIds)} and b.status in ('borrador', 'presentado', 'pospuesto')
        ${context.professional ? sql`and ${ownBudgetOf({ id: sql`b.id`, organizationId: sql`b.organization_id`, createdBy: sql`b.created_by` }, context.userId)}` : sql``}
      order by b.patient_id, at desc`)
    for (const row of open) {
      const personId = personOfPatient.get(String(row.patient_id)) as string
      push(personId, budgetItem({ ...row, person_id: personId }, false))
    }
  }
  if (personIds.length && can("crm.read") && on("oportunidad")) {
    const open = await run(sql`
      select distinct on (o.contact_id) o.id, o.title, o.interest_text, o.contact_id, o.created_at from opportunity o
      where o.organization_id = ${orgId} and o.contact_id in ${inList(personIds)} and o.status = 'open'
      order by o.contact_id, o.created_at desc`)
    for (const row of open) push(String(row.contact_id), opportunityItem(row, false))
  }
  return out
}

async function personIdsOfPatients(
  tx: Db,
  orgId: string,
  patientIds: string[],
): Promise<Map<string, string>> {
  if (!patientIds.length) return new Map()
  const found = (await tx.execute<Row>(
    sql`select id, person_id from patient where organization_id = ${orgId} and id in ${inList(patientIds)}`,
  )) as unknown as Row[]
  return new Map(found.map((row) => [String(row.id), String(row.person_id)]))
}

function personDetail(row: Row, seesPeople: boolean): string | null {
  const parts = [hc(row.patient_number)]
  if (seesPeople && row.doc_number)
    parts.push(`${str(row.doc_type)?.toUpperCase() ?? "Doc."} ${row.doc_number}`)
  if (row.speaks_for) parts.push(`Habla por ${row.speaks_for}`)
  else if (!row.patient_number && row.phone) parts.push(String(row.phone))
  return parts.filter(Boolean).join(" · ") || null
}

function appointmentItem(row: Row, matched: boolean): SearchItem {
  return {
    id: String(row.id),
    type: "cita",
    kind: "cita",
    title: [str(row.service_name) ?? str(row.reason) ?? "Cita", str(row.professional)]
      .filter(Boolean)
      .join(" · "),
    detail: null,
    at: iso(row.starts_at),
    amount: null,
    matched,
    target: { screen: "cita", appointmentId: String(row.id) },
  }
}

function budgetItem(row: Row, matched: boolean): SearchItem {
  const number = `Presupuesto N.º ${String(row.budget_number).padStart(4, "0")}`
  return {
    id: String(row.id),
    type: "dinero",
    kind: "presupuesto",
    title: [number, str(row.title)].filter(Boolean).join(" · "),
    detail: budgetStatusLabel(str(row.status)),
    at: iso(row.at),
    amount: null,
    matched,
    target: {
      screen: "persona",
      personId: String(row.person_id),
      section: "plan",
      budgetId: String(row.id),
    },
  }
}

function opportunityItem(row: Row, matched: boolean): SearchItem {
  return {
    id: String(row.id),
    type: "oportunidad",
    kind: "oportunidad",
    title: str(row.title) ?? str(row.interest_text) ?? "Oportunidad",
    detail: null,
    at: iso(row.created_at),
    amount: null,
    matched,
    target: { screen: "oportunidad", opportunityId: String(row.id) },
  }
}

function purchaseItem(row: Row): SearchItem {
  return {
    id: String(row.id),
    type: "inventario",
    kind: "compra",
    title: row.order_number == null ? "Compra" : purchaseOrderLabel(num(row.order_number)),
    detail: PURCHASE_STATUS_WORDS[String(row.status)] ?? null,
    at: iso(row.created_at),
    amount: null,
    matched: true,
    target: { screen: "compra", purchaseOrderId: String(row.id) },
  }
}

function serviceOwner(row: Row, matched: boolean): SearchOwner {
  return {
    key: `servicio:${row.id}`,
    kind: "servicio",
    type: "servicio",
    id: String(row.id),
    title: String(row.name),
    badge: "Servicio",
    detail:
      [str(row.code), row.duration_min ? `${row.duration_min} min` : null]
        .filter(Boolean)
        .join(" · ") || null,
    matched,
    target: { screen: "servicios", q: String(row.name) },
    items: [],
    more: 0,
    amount:
      row.price_cents == null
        ? null
        : { cents: num(row.price_cents), currency: String(row.currency) },
  }
}

function promotionOwner(row: Row, matched: boolean): SearchOwner {
  return {
    key: `promocion:${row.id}`,
    kind: "promocion",
    type: "servicio",
    id: String(row.id),
    title: String(row.name),
    badge: "Promoción",
    detail: null,
    matched,
    target: { screen: "promociones" },
    items: [],
    more: 0,
  }
}

function supplierOwner(row: Row, matched: boolean, items: SearchItem[]): SearchOwner {
  return {
    key: `proveedor:${row.id}`,
    kind: "proveedor",
    type: "inventario",
    id: String(row.id),
    title: String(row.name),
    badge: "Proveedor",
    detail: str(row.doc_number),
    matched,
    target: { screen: "proveedores" },
    items,
    more: 0,
  }
}

function professionalOwner(row: Row, matched: boolean, items: SearchItem[]): SearchOwner {
  return {
    key: `profesional:${row.id}`,
    kind: "profesional",
    type: "equipo",
    id: String(row.id),
    title: String(row.name),
    badge: "Equipo",
    detail: str(row.professional_title),
    matched,
    target: { screen: "agenda", professionalUserId: String(row.id) },
    items,
    more: 0,
  }
}

function answerOwner(row: Row, matched: boolean): SearchOwner {
  const body = String(row.body ?? "")
  return {
    key: `respuesta:${row.id}`,
    kind: "respuesta",
    type: "respuesta",
    id: String(row.id),
    title: String(row.title),
    badge: "Respuesta del agente",
    detail: excerpt(body, ""),
    matched,
    target: { screen: "conocimiento", q: String(row.title) },
    items: [],
    more: 0,
    text: body.slice(0, 2000),
  }
}

function latest(owner: SearchOwner): number {
  return Math.max(0, ...owner.items.map((item) => (item.at ? Date.parse(item.at) : 0)))
}

/** Una línea alrededor de lo encontrado: «…sigue con dolor en la muela…». */
export function excerpt(text: string, q: string, width = 90): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= width) return flat
  const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
  const word = q.trim().split(/\s+/)[0] ?? ""
  const at = word ? fold(flat).indexOf(fold(word)) : -1
  const start = at <= width / 3 ? 0 : Math.max(0, at - Math.floor(width / 3))
  const piece = flat.slice(start, start + width).trim()
  return `${start > 0 ? "…" : ""}${piece}${start + width < flat.length ? "…" : ""}`
}

function channelLabel(channel: string | null): string | null {
  const labels: Record<string, string> = {
    whatsapp: "WhatsApp",
    instagram: "Instagram",
    messenger: "Messenger",
    telegram: "Telegram",
    email: "Correo",
    webchat: "Chat de la web",
  }
  return channel ? (labels[channel] ?? channel) : null
}

function documentCategoryLabel(category: string | null): string {
  const labels: Record<string, string> = {
    consentimiento: "Consentimiento",
    radiografia: "Radiografía",
    foto_clinica: "Foto clínica",
    informe: "Informe",
    otro: "Documento",
  }
  return category ? (labels[category] ?? "Documento") : "Documento"
}

function budgetStatusLabel(status: string | null): string | null {
  const labels: Record<string, string> = {
    borrador: "Por enviar",
    presentado: "Por aceptar",
    aceptado: "Aceptado",
    parcial: "Aceptado en parte",
    rechazado: "Rechazado",
    pospuesto: "Pospuesto",
  }
  return status ? (labels[status] ?? status) : null
}

function monthName(month: number): string {
  return (
    [
      "enero",
      "febrero",
      "marzo",
      "abril",
      "mayo",
      "junio",
      "julio",
      "agosto",
      "septiembre",
      "octubre",
      "noviembre",
      "diciembre",
    ][month - 1] ?? String(month)
  )
}
