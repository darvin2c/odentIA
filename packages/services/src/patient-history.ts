import { budgetStateText, diagnosisCodeLabel } from "@odentia/clinical"
import { dentalSiteOfRow, toothOfRow } from "./dental/site.js"
import { ISO_3950, isValidTooth, toothSiteCode } from "@odentia/dental"
import type { Db } from "@odentia/db"
import {
  clinicalFollowUp,
  clinicalNote,
  encounter,
  encounterPlanItem,
  encounterDiagnosis,
  encounterProcedure,
  encounterSite,
  patientAnamnesis,
  patientDocument,
  prescription,
  prescriptionItem,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentBudgetOption,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { clinicalFormResponse, clinicalOrder, consentDocument } from "@odentia/db/schema/clinical-forms"
import { orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, inArray, isNull, notInArray, type SQL, sql } from "drizzle-orm"
import { budgetAwaitsAnswerSql } from "./budget-awaiting.js"
import { valueOptionOf } from "./budgets.js"
import { getCurrentDocumentContexts, listPatientDocuments } from "./clinical.js"
import { decodeCursor, encodeCursor } from "./cursors.js"
import { validation } from "./errors.js"
import { NEUTRAL_LOCALE, NEUTRAL_TIMEZONE } from "./locale.js"
import { checkEncounterClosing, type ClosingRequirement } from "./encounters.js"
import { requirePatient } from "./patients.js"
import type { ProductParts } from "./product-hooks.js"
import { productHooks } from "./products.js"
import { listTreatmentJourneys } from "./treatment-journey.js"

/** Presupuestos que ya no representan trabajo vigente. */
const RETIRED_BUDGETS = ["cancelado"] as const

export interface AcceptedPendingItem {
  id: string
  title: string
  toothNumber: number | null
  diagnosisCode: string | null
  /** «CIE-10 · K02.1»: el código con su lista, para leerlo. */
  diagnosisLabel: string | null
  priceCents: number | null
  currency: string
  status: string
  planId: string
  budgetId: string | null
  budgetNumber: number
  budgetTitle: string
}

export interface ProposedBudget {
  id: string
  budgetNumber: number
  title: string
  currency: string
  status: string
  itemsCount: number
  unpricedCount: number
  /** null si hay más de una moneda o ítems sin precio: nunca se mezclan. */
  totalCents: number | null
  totals: Array<{ currency: string; count: number; totalCents: number }>
  createdAt: Date
}

export interface AnamnesisBrief {
  version: number
  createdAt: Date
  motivo: string | null
  tiempo: string | null
  answeredCount: number
}

export interface RecentDocument {
  id: string
  label: string
  category: string
  contentType: string
  imageType: string | null
  capturedAt: Date | null
  hasThumbnail: boolean
  encounterId: string | null
  planItemId: string | null
  toothNumbers: number[]
  tags: string[]
  createdAt: Date
}

export interface PlannedLink {
  id: string
  title: string
  toothNumber: number | null
  status: string
  planId: string
  budgetId: string | null
}
export interface RelatedDocument {
  id: string
  label: string
  category: string
}

interface LastVisit {
  encounterId: string
  reason: string | null
  evolution: string | null
  indications: string | null
  finalizedAt: Date | null
  teeth: number[]
  procedures: Array<
    Pick<typeof encounterProcedure.$inferSelect, "description" | "diagnosisCode" | "diagnosisSystem"> & { toothNumber: number | null }
  >
  diagnoses: string[]
  plannedItems: PlannedLink[]
  documents: RelatedDocument[]
}

async function loadDocsForEncounters(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterIds: string[],
): Promise<Map<string, RelatedDocument[]>> {
  const grouped = new Map<string, RelatedDocument[]>()
  if (encounterIds.length === 0) return grouped
  const ids = new Set(encounterIds)
  const docs = await listPatientDocuments(tx, orgId, patientId)
  for (const doc of docs) {
    if (!doc.encounterId || !ids.has(doc.encounterId)) continue
    const items = grouped.get(doc.encounterId) ?? []
    items.push({ id: doc.id, label: doc.label, category: doc.category })
    grouped.set(doc.encounterId, items)
  }
  return grouped
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}
async function loadPlannedForEncounters(
  tx: Db,
  orgId: string,
  encounterIds: string[],
): Promise<Map<string, PlannedLink[]>> {
  const grouped = new Map<string, PlannedLink[]>()
  if (encounterIds.length === 0) return grouped
  const rows = await tx
    .select({
      encounterId: encounterPlanItem.encounterId,
      id: treatmentPlanItem.id,
      title: treatmentPlanItem.title,
      siteSystem: treatmentPlanItem.siteSystem,
      siteCode: treatmentPlanItem.siteCode,
      status: treatmentPlanItem.status,
      planId: treatmentPlanItem.planId,
      budgetId: treatmentPlanItem.budgetId,
    })
    .from(encounterPlanItem)
    .innerJoin(
      treatmentPlanItem,
      and(
        eq(treatmentPlanItem.id, encounterPlanItem.planItemId),
        eq(treatmentPlanItem.organizationId, encounterPlanItem.organizationId),
      ),
    )
    .where(
      and(
        eq(encounterPlanItem.organizationId, orgId),
        inArray(encounterPlanItem.encounterId, encounterIds),
      ),
    )
    .orderBy(asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id))
  for (const row of rows) {
    const list = grouped.get(row.encounterId) ?? []
    list.push({
      id: row.id,
      title: row.title,
      toothNumber: toothOfRow(row),
      status: row.status,
      planId: row.planId,
      budgetId: row.budgetId,
    })
    grouped.set(row.encounterId, list)
  }
  return grouped
}

/** Atención en curso tal como la necesita quien abre la ficha. */
export interface OpenEncounterBrief {
  id: string
  reason: string | null
  startedAt: Date
  professionalUserId: string
  appointmentId: string | null
  diagnosisCount: number
  procedureCount: number
  missing: ClosingRequirement[]
}

export async function getPatientSummary(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId)
  const [lastEncounter] = await tx
    .select()
    .from(encounter)
    .where(
      and(
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
        eq(encounter.status, "finalizada"),
      ),
    )
    .orderBy(desc(encounter.finalizedAt), desc(encounter.id))
    .limit(1)
  const [draft] = await tx
    .select()
    .from(encounter)
    .where(
      and(
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
        eq(encounter.status, "borrador"),
      ),
    )
    .limit(1)
  // Atención en curso: lo que lleva y lo que le falta para cerrarse, con la
  // firma de quien la atiende (no de quien consulta el resumen).
  let openEncounter: OpenEncounterBrief | null = null
  if (draft) {
    const [[dx], [proc], closing] = await Promise.all([
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(encounterDiagnosis)
        .where(
          and(
            eq(encounterDiagnosis.organizationId, orgId),
            eq(encounterDiagnosis.encounterId, draft.id),
            isNull(encounterDiagnosis.voidedAt),
          ),
        ),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(encounterProcedure)
        .where(
          and(
            eq(encounterProcedure.organizationId, orgId),
            eq(encounterProcedure.encounterId, draft.id),
            isNull(encounterProcedure.voidedAt),
          ),
        ),
      checkEncounterClosing(tx, orgId, draft.professionalUserId, draft),
    ])
    openEncounter = {
      id: draft.id,
      reason: draft.reason,
      startedAt: draft.startedAt,
      professionalUserId: draft.professionalUserId,
      appointmentId: draft.appointmentId,
      diagnosisCount: dx?.n ?? 0,
      procedureCount: proc?.n ?? 0,
      missing: closing.missing,
    }
  }
  const pendingConsentRows = await tx
    .select({ id: consentDocument.id, title: consentDocument.titleSnapshot })
    .from(consentDocument)
    .where(
      and(
        eq(consentDocument.organizationId, orgId),
        eq(consentDocument.patientId, patientId),
        eq(consentDocument.status, "pendiente"),
      ),
    )
    .orderBy(asc(consentDocument.createdAt))
  // Trabajo pendiente real: ítems aceptados con estado clínico pendiente o
  // programado, en presupuestos vigentes (nunca presentados sin decisión,
  // rechazados, cancelados ni históricos).
  const acceptedRows = await tx
    .select({
      id: treatmentPlanItem.id,
      title: treatmentPlanItem.title,
      siteSystem: treatmentPlanItem.siteSystem,
      siteCode: treatmentPlanItem.siteCode,
      diagnosisCode: treatmentPlanItem.diagnosisCode,
      diagnosisSystem: treatmentPlanItem.diagnosisSystem,
      priceCents: treatmentPlanItem.priceCents,
      currency: treatmentPlanItem.currency,
      status: treatmentPlanItem.status,
      planId: treatmentPlanItem.planId,
      budgetId: treatmentPlanItem.budgetId,
      budgetNumber: treatmentBudget.budgetNumber,
      budgetTitle: treatmentBudget.title,
    })
    .from(treatmentPlanItem)
    .innerJoin(
      treatmentBudgetItem,
      and(
        eq(treatmentBudgetItem.planItemId, treatmentPlanItem.id),
        eq(treatmentBudgetItem.budgetId, treatmentPlanItem.budgetId),
        eq(treatmentBudgetItem.organizationId, treatmentPlanItem.organizationId),
        // Con opciones, el tratamiento está una vez por opción: cuenta la línea aceptada.
        eq(treatmentBudgetItem.decision, "aceptado"),
      ),
    )
    .innerJoin(
      treatmentBudget,
      and(
        eq(treatmentBudget.id, treatmentPlanItem.budgetId),
        eq(treatmentBudget.organizationId, treatmentPlanItem.organizationId),
      ),
    )
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        inArray(treatmentPlanItem.status, ["pendiente", "programado", "en_curso", "suspendido"]),
        eq(treatmentPlanItem.decisionStatus, "aceptado"),
        notInArray(treatmentBudget.status, [...RETIRED_BUDGETS]),
      ),
    )
    .orderBy(asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id))
  const totals = new Map<string, { currency: string; count: number; totalCents: number }>()
  let unpricedCount = 0
  for (const item of acceptedRows) {
    if (item.priceCents === null) {
      unpricedCount++
      continue
    }
    const total = totals.get(item.currency) ?? { currency: item.currency, count: 0, totalCents: 0 }
    total.count++
    total.totalCents += item.priceCents
    totals.set(item.currency, total)
  }
  const amounts = [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency))

  let lastVisit: LastVisit | null = null
  if (lastEncounter) {
    const [teethRows, procedures, encounterNotes] = await Promise.all([
      tx
        .select({ siteSystem: encounterSite.siteSystem, siteCode: encounterSite.siteCode })
        .from(encounterSite)
        .where(
          and(
            eq(encounterSite.organizationId, orgId),
            eq(encounterSite.encounterId, lastEncounter.id),
          ),
        )
        .orderBy(asc(encounterSite.siteCode)),
      tx
        .select({
          description: encounterProcedure.description,
          siteSystem: encounterProcedure.siteSystem,
          siteCode: encounterProcedure.siteCode,
          diagnosisCode: encounterProcedure.diagnosisCode,
          diagnosisSystem: encounterProcedure.diagnosisSystem,
        })
        .from(encounterProcedure)
        .where(
          and(
            eq(encounterProcedure.organizationId, orgId),
            eq(encounterProcedure.encounterId, lastEncounter.id),
            isNull(encounterProcedure.voidedAt),
          ),
        )
        .orderBy(asc(encounterProcedure.createdAt), asc(encounterProcedure.id)),
      tx
        .select({ diagnosisCode: encounterDiagnosis.diagnosisCode, diagnosisSystem: encounterDiagnosis.diagnosisSystem })
        .from(encounterDiagnosis)
        .where(
          and(
            eq(encounterDiagnosis.organizationId, orgId),
            eq(encounterDiagnosis.encounterId, lastEncounter.id),
            isNull(encounterDiagnosis.voidedAt),
          ),
        ),
    ])
    const [planned, docs] = await Promise.all([
      loadPlannedForEncounters(tx, orgId, [lastEncounter.id]),
      loadDocsForEncounters(tx, orgId, patientId, [lastEncounter.id]),
    ])
    const diagnoses = [
      ...new Set(
        [
          ...procedures.map((p) => (p.diagnosisCode ? diagnosisCodeLabel(p.diagnosisSystem, p.diagnosisCode) : null)),
          ...encounterNotes.map((n) => diagnosisCodeLabel(n.diagnosisSystem, n.diagnosisCode)),
        ].filter((code): code is string => !!code),
      ),
    ].sort()
    lastVisit = {
      encounterId: lastEncounter.id,
      reason: lastEncounter.reason,
      evolution: lastEncounter.evolution,
      indications: lastEncounter.indications,
      finalizedAt: lastEncounter.finalizedAt,
      teeth: teethRows.map(toothOfRow).filter((tooth): tooth is number => tooth != null),
      procedures: procedures.map(({ siteSystem, siteCode, ...procedure }) => ({ ...procedure, toothNumber: toothOfRow({ siteSystem, siteCode }) })),
      diagnoses,
      plannedItems: planned.get(lastEncounter.id) ?? [],
      documents: docs.get(lastEncounter.id) ?? [],
    }
  }

  const acceptedPending: AcceptedPendingItem[] = acceptedRows.slice(0, 10).map((row) => ({
    id: row.id,
    title: row.title,
    toothNumber: toothOfRow(row),
    diagnosisCode: row.diagnosisCode,
    diagnosisLabel: row.diagnosisCode ? diagnosisCodeLabel(row.diagnosisSystem, row.diagnosisCode) : null,
    priceCents: row.priceCents,
    currency: row.currency,
    status: row.status,
    planId: row.planId,
    budgetId: row.budgetId,
    budgetNumber: row.budgetNumber,
    budgetTitle: row.budgetTitle,
  }))

  // Propuestas aparte: los presupuestos que esperan respuesta (la única regla,
  // `budgetAwaitsAnswerSql`; un borrador nunca cuenta) con sus totales
  // propuestos (nunca saldos ni deuda).
  const budgetRows = await tx
    .select()
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
        budgetAwaitsAnswerSql(treatmentBudget),
      ),
    )
    .orderBy(
      sql`case status when 'presentado' then 0 else 1 end`,
      desc(treatmentBudget.createdAt),
      desc(treatmentBudget.id),
    )
    .limit(6)
  let proposedBudgets: ProposedBudget[] = []
  if (budgetRows.length > 0) {
    // Con varias opciones, el total propuesto es el de la que vale (la elegida
    // o la recomendada): nunca la suma de las opciones.
    const options = await tx
      .select()
      .from(treatmentBudgetOption)
      .where(
        and(
          eq(treatmentBudgetOption.organizationId, orgId),
          inArray(
            treatmentBudgetOption.budgetId,
            budgetRows.map((b) => b.id),
          ),
        ),
      )
      .orderBy(asc(treatmentBudgetOption.position))
    const valued = new Set(
      budgetRows.flatMap((b) => valueOptionOf(options.filter((o) => o.budgetId === b.id))?.id ?? []),
    )
    const items = (
      await tx
        .select({
          budgetId: treatmentBudgetItem.budgetId,
          optionId: treatmentBudgetItem.optionId,
          priceCents: treatmentBudgetItem.priceCents,
          currency: treatmentBudgetItem.currency,
        })
        .from(treatmentBudgetItem)
        .where(
          and(
            eq(treatmentBudgetItem.organizationId, orgId),
            inArray(
              treatmentBudgetItem.budgetId,
              budgetRows.map((b) => b.id),
            ),
          ),
        )
    ).filter((item) => valued.has(item.optionId))
    const byBudget = new Map<string, typeof items>()
    for (const item of items) {
      const list = byBudget.get(item.budgetId) ?? []
      list.push(item)
      byBudget.set(item.budgetId, list)
    }
    proposedBudgets = budgetRows.map((b) => {
      const list = byBudget.get(b.id) ?? []
      const perCurrency = new Map<string, { currency: string; count: number; totalCents: number }>()
      let unpriced = 0
      for (const item of list) {
        if (item.priceCents === null) {
          unpriced++
          continue
        }
        const entry = perCurrency.get(item.currency) ?? {
          currency: item.currency,
          count: 0,
          totalCents: 0,
        }
        entry.count++
        entry.totalCents += item.priceCents
        perCurrency.set(item.currency, entry)
      }
      const budgetTotals = [...perCurrency.values()].sort((a, b2) =>
        a.currency.localeCompare(b2.currency),
      )
      return {
        id: b.id,
        budgetNumber: b.budgetNumber,
        title: b.title,
        currency: b.currency,
        status: b.status,
        itemsCount: list.length,
        unpricedCount: unpriced,
        totalCents:
          budgetTotals.length === 1 && unpriced === 0 ? budgetTotals[0]!.totalCents : null,
        totals: budgetTotals,
        createdAt: b.createdAt,
      }
    })
  }

  const [latestAnamnesis] = await tx
    .select()
    .from(patientAnamnesis)
    .where(
      and(eq(patientAnamnesis.organizationId, orgId), eq(patientAnamnesis.patientId, patientId)),
    )
    .orderBy(desc(patientAnamnesis.version))
    .limit(1)
  let anamnesisBrief: AnamnesisBrief | null = null
  if (latestAnamnesis) {
    const answers = (latestAnamnesis.answers ?? {}) as Record<string, unknown>
    const answeredCount = Object.values(answers).filter(
      (value) =>
        value !== null &&
        value !== undefined &&
        value !== "" &&
        !(Array.isArray(value) && value.length === 0),
    ).length
    anamnesisBrief = {
      version: latestAnamnesis.version,
      createdAt: latestAnamnesis.createdAt,
      motivo: stringField(answers.motivoConsulta),
      tiempo: stringField(answers.tiempoEnfermedad),
      answeredCount,
    }
  }

  const docRows = await tx
    .select()
    .from(patientDocument)
    .where(
      and(
        eq(patientDocument.organizationId, orgId),
        eq(patientDocument.patientId, patientId),
        isNull(patientDocument.retiredAt),
      ),
    )
    .orderBy(desc(patientDocument.createdAt), desc(patientDocument.id))
    .limit(8)
  const contexts = await getCurrentDocumentContexts(
    tx,
    orgId,
    patientId,
    docRows.map((d) => d.id),
  )
  const recentDocuments: RecentDocument[] = docRows.map((doc) => {
    const ctx = contexts.get(doc.id)
    return {
      id: doc.id,
      label: doc.label,
      category: doc.category,
      contentType: doc.contentType,
      imageType: doc.imageType,
      capturedAt: doc.capturedAt,
      hasThumbnail: doc.thumbnailKey !== null,
      encounterId: ctx?.encounterId ?? null,
      planItemId: ctx?.planItemId ?? null,
      toothNumbers: ctx?.toothNumbers ?? [],
      tags: ctx?.tags ?? [],
      createdAt: doc.createdAt,
    }
  })

  const summary = {
    treatmentJourneys: await listTreatmentJourneys(tx, orgId, patientId, 10),
    lastEncounter: lastEncounter ?? null,
    openEncounterId: draft?.id ?? null,
    openEncounter,
    pendingConsents: pendingConsentRows,
    // Nunca sumar monedas distintas: la UI muestra un total por moneda.
    planPending: {
      count: acceptedRows.length,
      unpricedCount,
      totalCents: amounts.length > 1 || unpricedCount ? null : (amounts[0]?.totalCents ?? 0),
      currency: amounts.length === 1 ? amounts[0]!.currency : null,
      totals: amounts,
    },
    lastVisit,
    acceptedPending,
    proposedBudgets,
    anamnesisBrief,
    recentDocuments,
  }
  // Lo del producto (odentIA: diagnósticos por pieza y «Encías»).
  const product = await (await productHooks(tx, orgId)).summaryParts(tx, { orgId, patientId })
  return { ...summary, ...product } as typeof summary & ProductParts
}

export const TIMELINE_TYPES = [
  "encounter",
  "note",
  "anamnesis",
  "document",
  "odontogram",
  "plan",
  "budget",
  "follow_up",
  "prescription",
  // Los papeles como hechos de la historia (ADR 0035): «firmó», «se pidió»,
  // «se completó». El papel se busca en Documentos.
  "consent",
  "order",
  "form",
  // El odontograma firmado (Perú, NTS 188) es un hecho de la historia: el que
  // firmó el cierre de una atención va dentro de ella; el del botón, aparte.
  "odontogram_signed",
] as const
export type TimelineType = (typeof TIMELINE_TYPES)[number]
/** Un hecho de la historia; el producto agrega lo suyo (odentIA: el periodontograma de la atención). */
export type TimelineItem = TimelineItemBase & ProductParts

export interface TimelineItemBase {
  id: string
  type: TimelineType
  createdAt: Date
  title: string
  detail?: string | null
  toothNumbers: number[]
  authorId?: string | null
  refId: string
  /** «CIE-10 · K02.1»: el código con su lista, para leerlo. */
  diagnosisCode?: string | null
  category?: string
  version?: number
  condition?: string
  surface?: string | null
  status?: string
  procedures?: string[]
  documentsCount?: number
  indications?: string | null
  /** CIE-10 distintos de procedimientos y notas de la atención. */
  diagnoses?: string[]
  /** Tratamientos del plan vinculados a la atención (misma unidad clínica). */
  plannedItems?: PlannedLink[]
  /** Documentos con contexto vigente que apuntan a la atención. */
  documents?: RelatedDocument[]
  tags?: string[]
  encounterId?: string | null
  planItemId?: string | null
  budgetId?: string | null
  followUpId?: string | null
  prescriptionId?: string | null
  /** Plan clínico del tratamiento, para abrir su recorrido desde la historia. */
  planId?: string | null
  /** Decisión vigente del tratamiento (aceptado, pendiente, etc.). */
  decision?: string | null
  /** El estado dicho con el nombre único de la aplicación (`budgetStateText` para un presupuesto). */
  statusText?: string | null
  /** Vencimiento de un control, para leerlo sin consultar otra pantalla. */
  dueAt?: Date | null
  /** Motivo de una atención anulada: la historia la muestra con él. */
  voidReason?: string | null
}

/** Cómo se dice el tipo de una orden en la historia. */
const ORDER_KIND_WORDS: Record<string, string> = {
  imagen: "Orden de imagen",
  laboratorio: "Orden de laboratorio",
  interconsulta: "Derivación",
}

export async function getTimeline(
  tx: Db,
  orgId: string,
  patientId: string,
  input: {
    cursor?: string
    limit?: number
    types?: readonly TimelineType[]
    toothNumber?: number
    documentCategory?: "radiografia" | "foto_clinica"
    order?: "desc" | "asc"
  } = {},
): Promise<{ data: TimelineItem[]; nextCursor: string | null; timezone: string; locale: string }> {
  await requirePatient(tx, orgId, patientId)
  const [profile] = await tx
    .select({ timezone: orgProfile.timezone, locale: orgProfile.locale })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  const timezone = profile?.timezone || NEUTRAL_TIMEZONE
  const locale = profile?.locale || NEUTRAL_LOCALE
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100)
  const types = input.types ?? TIMELINE_TYPES
  const order = input.order ?? "desc"
  if (order !== "desc" && order !== "asc") throw validation("Orden inválido")
  if (input.toothNumber != null && !isValidTooth(input.toothNumber))
    throw validation("Pieza FDI inválida")
  const cursor = input.cursor ? decodeCursor(input.cursor) : null
  if (
    input.cursor &&
    (!cursor || Number.isNaN(Date.parse(cursor.ts)) || !/^[0-9a-f-]{36}$/i.test(cursor.id))
  )
    throw validation("Cursor inválido")
  const tooth = input.toothNumber
  const cmp = order === "desc" ? sql`<` : sql`>`
  const direction = order === "desc" ? sql`desc` : sql`asc`
  const branches: SQL[] = []
  // Las atenciones firmadas y las anuladas (con su motivo, a la hora en que se
  // anularon): Historia absorbe la lista de Atenciones (ADR 0035). El borrador
  // en curso no es todavía un hecho: lo continúa la cabecera.
  if (types.includes("encounter"))
    branches.push(sql`select id, 'encounter'::text as kind, case when status = 'anulada' then coalesce(voided_at, created_at) else created_at end as created_at from encounter where organization_id = ${orgId} and patient_id = ${patientId}::uuid and status in ('finalizada', 'anulada')
    ${tooth == null ? sql`` : sql`and exists (select 1 from encounter_site et where et.encounter_id = encounter.id and et.organization_id = ${orgId} and et.site_system = ${ISO_3950} and et.site_code = ${toothSiteCode(tooth)})`}`)
  // Los papeles, a la hora de lo que pasó con ellos: el consentimiento cuando se
  // firmó o se revocó, la orden cuando se pidió y el formulario al completarse.
  if (types.includes("consent") && tooth == null)
    branches.push(
      sql`select id, 'consent'::text as kind, coalesce(revoked_at, signed_at, created_at) as created_at from consent_document where organization_id = ${orgId} and patient_id = ${patientId}::uuid`,
    )
  if (types.includes("order") && tooth == null)
    branches.push(
      sql`select id, 'order'::text as kind, created_at from clinical_order where organization_id = ${orgId} and patient_id = ${patientId}::uuid`,
    )
  if (types.includes("form") && tooth == null)
    branches.push(
      sql`select id, 'form'::text as kind, finalized_at as created_at from clinical_form_response where organization_id = ${orgId} and patient_id = ${patientId}::uuid and status = 'finalizado' and finalized_at is not null`,
    )
  if (types.includes("note") && tooth == null)
    branches.push(
      sql`select id, 'note'::text as kind, created_at from clinical_note where organization_id = ${orgId} and patient_id = ${patientId}::uuid and encounter_id is null`,
    )
  if (types.includes("anamnesis") && tooth == null)
    branches.push(
      sql`select id, 'anamnesis'::text as kind, created_at from patient_anamnesis where organization_id = ${orgId} and patient_id = ${patientId}::uuid`,
    )
  // Los hechos propios del producto (odentIA: hallazgos y odontogramas firmados).
  const hooks = await productHooks(tx, orgId)
  branches.push(
    ...hooks.timelineSources({ orgId, patientId, types, outsideEncountersOnly: types.includes("encounter"), tooth: tooth ?? null }),
  )
  if (types.includes("document")) {
    const toothFilter =
      tooth == null
        ? sql``
        : sql`and exists (select 1 from patient_document_context c where c.document_id = patient_document.id and c.organization_id = ${orgId} and c.version = (select max(version) from patient_document_context where document_id = patient_document.id and organization_id = ${orgId}) and c.site_system = ${ISO_3950} and ${toothSiteCode(tooth)} = any(c.site_codes))`
    // En la historia completa viven dentro de su atención; al filtrar documentos
    // deben seguir visibles aunque no se estén solicitando las atenciones.
    const linkedFilter =
      types.includes("encounter") && !input.documentCategory
        ? sql`and not exists (select 1 from patient_document_context c where c.document_id = patient_document.id and c.organization_id = ${orgId} and c.version = (select max(version) from patient_document_context where document_id = patient_document.id and organization_id = ${orgId}) and c.encounter_id is not null)`
        : sql``
    branches.push(
      sql`select id, 'document'::text as kind, created_at from patient_document where organization_id = ${orgId} and patient_id = ${patientId}::uuid ${linkedFilter} ${toothFilter} ${input.documentCategory ? sql`and category = ${input.documentCategory}` : sql``}`,
    )
  }
  const journeySources = [
    { type: "plan", table: "treatment_plan_item", ref: "planItemId" },
    { type: "budget", table: "treatment_budget", ref: "budgetId" },
    { type: "follow_up", table: "clinical_follow_up", ref: "followUpId" },
    { type: "prescription", table: "prescription", ref: "prescriptionId" },
  ] as const
  for (const source of journeySources) {
    if (!types.includes(source.type) || tooth != null) continue
    branches.push(sql`select id, ${source.type}::text as kind, created_at from ${sql.identifier(source.table)}
      where organization_id = ${orgId} and patient_id = ${patientId}::uuid`)
  }
  if (!branches.length) return { data: [], nextCursor: null, timezone, locale }
  const rows = await tx.execute<{ id: string; kind: TimelineType; cursor_ts: string }>(sql`
  select id, kind, created_at::text as cursor_ts from (${sql.join(branches, sql` union all `)}) events
  ${cursor ? sql`where (created_at, id) ${cmp} (${cursor.ts}::timestamptz, ${cursor.id}::uuid)` : sql``}
  order by created_at ${direction}, id ${direction} limit ${limit + 1}`)
  const page = rows.slice(0, limit)
  if (!page.length) return { data: [], nextCursor: null, timezone, locale }
  const ids = (type: TimelineType) => page.filter((row) => row.kind === type).map((row) => row.id)
  const hydrated = new Map<string, TimelineItem>()
  const encounters = ids("encounter")
  if (encounters.length) {
    const [records, teeth, procedures, notes] = await Promise.all([
      tx
        .select()
        .from(encounter)
        .where(and(eq(encounter.organizationId, orgId), inArray(encounter.id, encounters))),
      tx
        .select()
        .from(encounterSite)
        .where(
          and(
            eq(encounterSite.organizationId, orgId),
            inArray(encounterSite.encounterId, encounters),
          ),
        ),
      tx
        .select()
        .from(encounterProcedure)
        .where(
          and(
            eq(encounterProcedure.organizationId, orgId),
            inArray(encounterProcedure.encounterId, encounters),
            isNull(encounterProcedure.voidedAt),
          ),
        ),
      tx
        .select({
          encounterId: encounterDiagnosis.encounterId,
          diagnosisCode: encounterDiagnosis.diagnosisCode,
          diagnosisSystem: encounterDiagnosis.diagnosisSystem,
        })
        .from(encounterDiagnosis)
        .where(
          and(
            eq(encounterDiagnosis.organizationId, orgId),
            inArray(encounterDiagnosis.encounterId, encounters),
            isNull(encounterDiagnosis.voidedAt),
          ),
        ),
    ])
    const [planned, docs, productParts] = await Promise.all([
      loadPlannedForEncounters(tx, orgId, encounters),
      loadDocsForEncounters(tx, orgId, patientId, encounters),
      hooks.encounterParts(tx, orgId, encounters),
    ])
    for (const row of records) {
      const rowProcedures = procedures.filter((p) => p.encounterId === row.id)
      const rowNotes = notes.filter((n) => n.encounterId === row.id)
      const related = docs.get(row.id) ?? []
      const diagnoses = [
        ...new Set(
          [
            ...rowProcedures.map((p) => (p.diagnosisCode ? diagnosisCodeLabel(p.diagnosisSystem, p.diagnosisCode) : null)),
            ...rowNotes.map((n) => diagnosisCodeLabel(n.diagnosisSystem, n.diagnosisCode)),
          ].filter((code): code is string => !!code),
        ),
      ].sort()
      hydrated.set(row.id, {
        id: row.id,
        refId: row.id,
        type: "encounter",
        createdAt: row.status === "anulada" ? (row.voidedAt ?? row.createdAt) : row.createdAt,
        voidReason: row.voidReason,
        title: row.reason || "Atención",
        detail: row.evolution,
        toothNumbers: teeth
          .filter((t) => t.encounterId === row.id)
          .map(toothOfRow)
          .filter((tooth): tooth is number => tooth != null)
          .sort((a, b) => a - b),
        authorId: row.professionalUserId,
        status: row.status,
        procedures: rowProcedures.map((p) => p.description),
        documentsCount: related.length,
        documents: related,
        diagnoses,
        plannedItems: planned.get(row.id) ?? [],
        indications: row.indications,
        encounterId: row.id,
        ...(productParts.get(row.id) ?? {}),
      })
    }
  }
  const notes = ids("note")
  if (notes.length)
    for (const row of await tx
      .select()
      .from(clinicalNote)
      .where(and(eq(clinicalNote.organizationId, orgId), inArray(clinicalNote.id, notes)))) {
      hydrated.set(row.id, {
        id: row.id,
        refId: row.id,
        type: "note",
        createdAt: row.createdAt,
        title: "Nota clínica",
        detail: row.note,
        toothNumbers: [],
        authorId: row.authorUserId,
        encounterId: null,
      })
    }
  const anamneses = ids("anamnesis")
  if (anamneses.length)
    for (const row of await tx
      .select()
      .from(patientAnamnesis)
      .where(
        and(eq(patientAnamnesis.organizationId, orgId), inArray(patientAnamnesis.id, anamneses)),
      )) {
      const answers = row.answers as Record<string, unknown>
      hydrated.set(row.id, {
        id: row.id,
        refId: row.id,
        type: "anamnesis",
        createdAt: row.createdAt,
        title: `Anamnesis v${row.version}`,
        detail: typeof answers.motivoConsulta === "string" ? answers.motivoConsulta : null,
        version: row.version,
        toothNumbers: [],
        authorId: row.createdBy,
        encounterId: null,
      })
    }
  const documents = ids("document")
  if (documents.length) {
    const docRows = await tx
      .select()
      .from(patientDocument)
      .where(and(eq(patientDocument.organizationId, orgId), inArray(patientDocument.id, documents)))
    const ctxByDoc = await getCurrentDocumentContexts(tx, orgId, patientId, documents)
    for (const row of docRows) {
      const ctx = ctxByDoc.get(row.id)
      hydrated.set(row.id, {
        id: row.id,
        refId: row.id,
        type: "document",
        createdAt: row.createdAt,
        title: row.label,
        category: row.category,
        toothNumbers: ctx?.toothNumbers ?? [],
        tags: ctx?.tags ?? [],
        authorId: row.uploadedBy,
        encounterId: ctx?.encounterId ?? null,
        version: ctx?.version,
      })
    }
  }
  for (const [id, item] of await hooks.timelineItems(tx, orgId, (type) => ids(type as TimelineType))) hydrated.set(id, item)
  for (const source of journeySources) {
    const sourceIds = ids(source.type)
    if (!sourceIds.length) continue
    const records = await tx.execute<{ id: string }>(
      sql`select id from ${sql.identifier(source.table)}
        where organization_id = ${orgId} and patient_id = ${patientId}::uuid
        and id in (${sql.join(
          sourceIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
    )
    for (const row of records)
      hydrated.set(row.id, {
        id: row.id,
        refId: row.id,
        type: source.type,
        createdAt: new Date(0),
        title: "",
        toothNumbers: [],
        [source.ref]: row.id,
      })
  }
  // Contexto legible de cada evento del recorrido: la historia no muestra
  // "plan"/"payment" sin decir de qué tratamiento o pago se trata ni adónde ir.
  const planIds = ids("plan")
  if (planIds.length)
    for (const row of await tx
      .select()
      .from(treatmentPlanItem)
      .where(
        and(eq(treatmentPlanItem.organizationId, orgId), inArray(treatmentPlanItem.id, planIds)),
      )) {
      const dental = dentalSiteOfRow(row)
      const site =
        dental.toothNumber != null
          ? `Pieza ${dental.toothNumber}${dental.surfaces.length > 0 ? ` (${dental.surfaces.join(", ")})` : ""}`
          : row.scope === "quadrant" && dental.quadrant != null
            ? `Cuadrante ${dental.quadrant}`
            : row.scope === "arch" && dental.arch === "upper"
              ? "Arcada superior"
              : row.scope === "arch" && dental.arch === "lower"
                ? "Arcada inferior"
                : "General"
      hydrated.set(row.id, {
        ...hydrated.get(row.id)!,
        createdAt: row.createdAt,
        title: row.title,
        detail: `${site} · ${row.status}`,
        status: row.status,
        decision: row.decisionStatus,
        toothNumbers: dental.toothNumber != null ? [dental.toothNumber] : [],
        authorId: row.createdBy,
        planId: row.planId,
        planItemId: row.id,
      })
    }
  const budgetIds = ids("budget")
  if (budgetIds.length)
    for (const row of await tx
      .select()
      .from(treatmentBudget)
      .where(
        and(eq(treatmentBudget.organizationId, orgId), inArray(treatmentBudget.id, budgetIds)),
      )) {
      const lines = await tx
        .select({
          planItemId: treatmentBudgetItem.planItemId,
          currency: treatmentBudgetItem.currency,
          decision: treatmentBudgetItem.decision,
          optionId: treatmentBudgetItem.optionId,
        })
        .from(treatmentBudgetItem)
        .where(
          and(
            eq(treatmentBudgetItem.organizationId, orgId),
            eq(treatmentBudgetItem.budgetId, row.id),
          ),
        )
      const options = await tx
        .select({ id: treatmentBudgetOption.id, decision: treatmentBudgetOption.decision })
        .from(treatmentBudgetOption)
        .where(and(eq(treatmentBudgetOption.organizationId, orgId), eq(treatmentBudgetOption.budgetId, row.id)))
      // Un tratamiento cuenta una vez aunque esté en varias opciones.
      const total = new Set(lines.map((line) => line.planItemId)).size
      const currency = lines.map((line) => line.currency).sort()[0]
      hydrated.set(row.id, {
        ...hydrated.get(row.id)!,
        createdAt: row.createdAt,
        title: `Presupuesto N.º ${row.budgetNumber} · ${row.title}`,
        detail: `Revisión ${row.revisionNumber} · ${total} tratamiento(s) · ${currency ?? row.currency}`,
        status: row.status,
        // Los mismos nombres que Plan (ADR 0034): «Enviado · espera respuesta», «Aceptó 2 de 3»…
        statusText: budgetStateText({ status: row.status, items: lines, options }),
        authorId: row.createdBy,
        planId: row.planId,
        budgetId: row.id,
      })
    }
  const followUpIds = ids("follow_up")
  if (followUpIds.length)
    for (const row of await tx
      .select()
      .from(clinicalFollowUp)
      .where(
        and(eq(clinicalFollowUp.organizationId, orgId), inArray(clinicalFollowUp.id, followUpIds)),
      )) {
      hydrated.set(row.id, {
        ...hydrated.get(row.id)!,
        createdAt: row.createdAt,
        title: row.title,
        detail: row.outcome ?? row.instructions ?? null,
        status: row.status,
        dueAt: row.dueAt,
        authorId: row.createdBy,
        planItemId: row.planItemId,
        followUpId: row.id,
      })
    }
  const prescriptionIds = ids("prescription")
  if (prescriptionIds.length)
    for (const row of await tx
      .select()
      .from(prescription)
      .where(
        and(eq(prescription.organizationId, orgId), inArray(prescription.id, prescriptionIds)),
      )) {
      const medications = await tx
        .select({ medicationName: prescriptionItem.medicationName, dose: prescriptionItem.dose })
        .from(prescriptionItem)
        .where(
          and(
            eq(prescriptionItem.organizationId, orgId),
            eq(prescriptionItem.prescriptionId, row.id),
          ),
        )
        .orderBy(asc(prescriptionItem.createdAt), asc(prescriptionItem.id))
      hydrated.set(row.id, {
        ...hydrated.get(row.id)!,
        createdAt: row.issuedAt,
        title: `Receta N.º ${row.prescriptionNumber}`,
        detail:
          medications.map((m) => `${m.medicationName} ${m.dose}`).join(" · ") || "Sin medicamentos",
        status: row.status,
        authorId: row.issuedBy,
        planItemId: row.planItemId,
        prescriptionId: row.id,
      })
    }
  const consentIds = ids("consent")
  if (consentIds.length)
    for (const row of await tx
      .select()
      .from(consentDocument)
      .where(and(eq(consentDocument.organizationId, orgId), inArray(consentDocument.id, consentIds)))) {
      const fact =
        row.status === "revocado"
          ? { at: row.revokedAt, title: `Revocó el consentimiento: ${row.titleSnapshot}`, detail: row.revokeReason }
          : row.status === "firmado"
            ? { at: row.signedAt, title: `Firmó el consentimiento: ${row.titleSnapshot}`, detail: `Firmó ${row.signerName}` }
            : row.status === "anulado"
              ? { at: null, title: `Se anuló el consentimiento: ${row.titleSnapshot}`, detail: null }
              : { at: null, title: `Se preparó el consentimiento: ${row.titleSnapshot}`, detail: "Falta la firma" }
      hydrated.set(row.id, {
        id: row.id,
        refId: row.id,
        type: "consent",
        createdAt: fact.at ?? row.createdAt,
        title: fact.title,
        detail: fact.detail ?? row.procedureRef,
        status: row.status,
        toothNumbers: [],
        authorId: row.authorUserId,
        encounterId: row.encounterId,
        planItemId: row.planItemId,
      })
    }
  const orderIds = ids("order")
  if (orderIds.length)
    for (const row of await tx
      .select()
      .from(clinicalOrder)
      .where(and(eq(clinicalOrder.organizationId, orgId), inArray(clinicalOrder.id, orderIds)))) {
      const state =
        row.status === "completado"
          ? "con resultado"
          : row.status === "cancelado"
            ? `cancelada${row.cancelReason ? `: ${row.cancelReason}` : ""}`
            : "sin resultado"
      hydrated.set(row.id, {
        id: row.id,
        refId: row.id,
        type: "order",
        createdAt: row.createdAt,
        title: `Se pidió: ${row.title}`,
        detail: `${ORDER_KIND_WORDS[row.kind] ?? "Orden"} · ${state}`,
        status: row.status,
        diagnosisCode: row.diagnosisCode ? diagnosisCodeLabel(row.diagnosisSystem, row.diagnosisCode) : null,
        toothNumbers: [],
        authorId: row.fromUserId,
        encounterId: row.encounterId,
      })
    }
  const formIds = ids("form")
  if (formIds.length)
    for (const row of await tx
      .select()
      .from(clinicalFormResponse)
      .where(and(eq(clinicalFormResponse.organizationId, orgId), inArray(clinicalFormResponse.id, formIds)))) {
      hydrated.set(row.id, {
        id: row.id,
        refId: row.id,
        type: "form",
        createdAt: row.finalizedAt ?? row.createdAt,
        title: `Se completó el formulario: ${row.templateTitle ?? "Formulario clínico"}`,
        detail: row.source === "portal" ? "Lo respondió la persona y el equipo lo revisó" : null,
        status: row.status,
        toothNumbers: [],
        authorId: row.authorUserId,
        encounterId: row.encounterId,
      })
    }
  // Los pagos no son historia clínica: sus movimientos viven en la cuenta.
  const last = page[page.length - 1]!
  return {
    data: page.map((row) => hydrated.get(row.id)!),
    nextCursor: rows.length > limit ? encodeCursor(last.cursor_ts, last.id) : null,
    timezone,
    locale,
  }
}
