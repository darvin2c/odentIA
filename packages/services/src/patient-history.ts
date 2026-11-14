import {
  budgetStateText,
  diagnosisCodeLabel,
  doneSessionWords,
  isRetiredPlanStatus,
  LEFT_OUT_DECISIONS,
  planItemStateText,
  sumByCurrency,
} from "@odentia/clinical"
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
import { user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, inArray, isNull, notInArray, type SQL, sql } from "drizzle-orm"
import { budgetAwaitsAnswerSql, budgetValueOptionSql } from "./budget-awaiting.js"
import { valueOptionOf } from "./budgets.js"
import { getCurrentDocumentContexts, listPatientDocuments } from "./clinical.js"
import { decodeCursor, encodeCursor } from "./cursors.js"
import { diagnosisTitlesOf, namedDiagnosis } from "./diagnosis-codes.js"
import { validation } from "./errors.js"
import { NEUTRAL_LOCALE, NEUTRAL_TIMEZONE } from "./locale.js"
import { checkEncounterClosing, type ClosingRequirement } from "./encounters.js"
import { listFollowUps } from "./follow-ups.js"
import { requirePatient } from "./patients.js"
import type { ProductParts, ProductSite, SiteColumns } from "./product-hooks.js"
import { productHooks } from "./products.js"

/** El sitio suelto de una fila como lo dice el producto (odentIA: su pieza). */
const looseValue = (site: ProductSite, row: Pick<SiteColumns, "siteSystem" | "siteCode">): number | null =>
  row.siteSystem === site.system ? site.value(row.siteCode) : null
import { listTreatmentJourneys } from "./treatment-journey.js"
import { encounterSessionKey, encounterSessionsOf } from "./to-schedule.js"

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
  /** Su fecha propia (la de toma, en una imagen), que puede ser de otro día que la atención. */
  capturedAt: Date | null
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
    items.push({ id: doc.id, label: doc.label, category: doc.category, capturedAt: doc.capturedAt })
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
  const site = (await productHooks(tx, orgId)).site
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
      toothNumber: looseValue(site, row),
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

/** Las líneas con precio, un total por moneda; las que no lo tienen, cuántas son. */
function pricedTotals(rows: ReadonlyArray<{ priceCents: number | null; currency: string }>) {
  const priced = rows.flatMap((item) =>
    item.priceCents === null ? [] : [{ currency: item.currency, cents: item.priceCents }],
  )
  return {
    totals: sumByCurrency(priced).map(({ currency, count, cents }) => ({
      currency,
      count,
      totalCents: cents,
    })),
    unpriced: rows.length - priced.length,
  }
}

export async function getPatientSummary(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId)
  const site = (await productHooks(tx, orgId)).site
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
    .select({
      id: consentDocument.id,
      title: consentDocument.titleSnapshot,
      // Firmado por su enlace falta confirmarlo; enviado, espera su firma: no es «sin firmar».
      personSignedAt: consentDocument.personSignedAt,
      linkSentAt: consentDocument.linkSentAt,
    })
    .from(consentDocument)
    .leftJoin(
      treatmentPlanItem,
      and(
        eq(treatmentPlanItem.id, consentDocument.planItemId),
        eq(treatmentPlanItem.organizationId, consentDocument.organizationId),
      ),
    )
    .where(
      and(
        eq(consentDocument.organizationId, orgId),
        eq(consentDocument.patientId, patientId),
        eq(consentDocument.status, "pendiente"),
        // El preparado para lo que no aceptó o no eligió ya no se pide (`isLeftOut`), salvo
        // que ya vaya por su enlace: eso sigue su curso.
        sql`not (${treatmentPlanItem.decisionStatus} is not null
          and ${treatmentPlanItem.decisionStatus} in (${sql.join(
            LEFT_OUT_DECISIONS.map((decision) => sql`${decision}`),
            sql`, `,
          )})
          and ${consentDocument.linkSentAt} is null and ${consentDocument.personSignedAt} is null)`,
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
        // Con opciones, el tratamiento está una vez por opción: cuenta la línea aceptada
        // de la opción que vale (lo común aceptado sin elegir camino está en todas).
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
        sql`${treatmentBudgetItem.optionId} = ${budgetValueOptionSql(treatmentBudget)}`,
      ),
    )
    .orderBy(asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id))
  const { totals: amounts, unpriced: unpricedCount } = pricedTotals(acceptedRows)

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
    // Por su nombre en el catálogo («Caries dental»), como en la atención; sin nombre, el código.
    const coded = [
      ...procedures.map((p) => ({ system: p.diagnosisSystem, code: p.diagnosisCode })),
      ...encounterNotes.map((n) => ({ system: n.diagnosisSystem, code: n.diagnosisCode })),
    ].filter((row): row is { system: string; code: string } => !!row.code && !!row.system)
    const titleOf = await diagnosisTitlesOf(tx, coded)
    const diagnoses = [
      ...new Set(coded.map((row) => titleOf.get(`${row.system}|${row.code}`) ?? diagnosisCodeLabel(row.system, row.code))),
    ].sort()
    lastVisit = {
      encounterId: lastEncounter.id,
      reason: lastEncounter.reason,
      evolution: lastEncounter.evolution,
      indications: lastEncounter.indications,
      finalizedAt: lastEncounter.finalizedAt,
      teeth: teethRows.map((row) => looseValue(site, row)).filter((tooth): tooth is number => tooth != null),
      procedures: procedures.map(({ siteSystem, siteCode, ...procedure }) => ({ ...procedure, toothNumber: looseValue(site, { siteSystem, siteCode }) })),
      diagnoses,
      plannedItems: planned.get(lastEncounter.id) ?? [],
      documents: docs.get(lastEncounter.id) ?? [],
    }
  }

  const acceptedPending: AcceptedPendingItem[] = acceptedRows.slice(0, 10).map((row) => ({
    id: row.id,
    title: row.title,
    toothNumber: looseValue(site, row),
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
      const { totals: budgetTotals, unpriced } = pricedTotals(list)
      return {
        id: b.id,
        budgetNumber: b.budgetNumber,
        title: b.title,
        // Sale de sus líneas: la cabecera no se lee. Con dos monedas, las dice `totals`.
        currency: budgetTotals[0]?.currency ?? list[0]?.currency ?? "",
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
  /** Motivo de una atención anulada (o de un archivo retirado): la historia la muestra con él. */
  voidReason?: string | null
  /** Un documento: cuándo se subió, que puede ser otro día que el de su fecha (`createdAt`). */
  uploadedAt?: Date
  /** Quién atendió, y en una anulada quién la anuló y cuándo. */
  professionalName?: string | null
  /** Quién firmó la atención y cuándo. */
  signerName?: string | null
  signedAt?: Date | null
  /** Hecho de una atención que sigue en curso (sin firmar): la historia lo dice. */
  openEncounter?: boolean
  voidedByName?: string | null
  voidedAt?: Date | null
  /**
   * Lo que nació en la atención, dentro de su tarjeta (QA de la ficha del 8 nov:
   * un día eran 14 tarjetas sueltas). Solo en la historia completa; lo anulado
   * o cancelado viene marcado (`retired`) para plegarlo al pie de la tarjeta.
   */
  born?: EncounterBorn
}

/** Lo nacido en una atención: lo que se indicó, se pidió y se firmó. */
export interface EncounterBorn {
  /** Tratamientos indicados en ella, con su estado dicho en palabras. */
  indicated: Array<{ id: string; title: string; where: string | null; stateText: string; retired: boolean; budgetId: string | null }>
  /** Sus presupuestos (los de lo indicado en ella), con su estado en palabras. */
  budgets: Array<{ id: string; budgetNumber: number; stateText: string; retired: boolean }>
  /** Consentimientos (no los revocados: la revocación es un hecho propio, con su fecha). */
  consents: Array<{ id: string; title: string; status: string; signerName: string | null; relation: string | null }>
  prescriptions: Array<{ id: string; number: number; detail: string; voided: boolean; reason: string | null }>
  orders: Array<{ id: string; title: string; state: string }>
  /**
   * Sus formularios del equipo: el que sigue a medias y el finalizado, con cuándo
   * se terminó y si fue después de firmar la atención. `retired`: la atención se
   * anuló y lo finalizado en ella va con lo que ya no vale. De una atención
   * anulada vienen además los descartados, con su motivo: es el único lugar donde
   * la persona ve qué pasó con lo que había empezado (`discardedWithAttention`:
   * lo descartó la propia anulación).
   */
  forms: Array<{
    id: string
    title: string
    state: "a_medias" | "finalizado" | "descartado"
    finalizedAt: Date | null
    afterSigning: boolean
    retired: boolean
    discardReason: string | null
    discardedWithAttention: boolean
  }>
  followUps: Array<{ id: string; title: string; dueAt: Date; stateText: string; retired: boolean }>
}

const FOLLOW_UP_STATE_WORDS: Record<string, string> = {
  pendiente: "Por reservar",
  programado: "Con cita",
  realizado: "Hecho",
  cancelado: "Cancelado",
}

/**
 * Lo nacido en cada atención, de una vez para todas (sin una consulta por
 * fila): lo indicado, sus presupuestos, consentimientos, recetas, pedidos,
 * formularios y controles. La pantalla lo pone dentro de su tarjeta.
 */
async function loadBornForEncounters(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterIds: string[],
): Promise<Map<string, EncounterBorn>> {
  const out = new Map<string, EncounterBorn>()
  if (encounterIds.length === 0) return out
  const site = (await productHooks(tx, orgId)).site
  const of = (id: string): EncounterBorn => {
    let born = out.get(id)
    if (!born) {
      born = { indicated: [], budgets: [], consents: [], prescriptions: [], orders: [], forms: [], followUps: [] }
      out.set(id, born)
    }
    return born
  }
  const [items, consents, recipes, orders, forms, controls] = await Promise.all([
    tx
      .select()
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
          inArray(treatmentPlanItem.sourceEncounterId, encounterIds),
        ),
      )
      .orderBy(asc(treatmentPlanItem.sortOrder), asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id)),
    tx
      .select()
      .from(consentDocument)
      .where(
        and(
          eq(consentDocument.organizationId, orgId),
          eq(consentDocument.patientId, patientId),
          inArray(consentDocument.encounterId, encounterIds),
        ),
      )
      .orderBy(asc(consentDocument.createdAt), asc(consentDocument.id)),
    tx
      .select()
      .from(prescription)
      .where(and(eq(prescription.organizationId, orgId), eq(prescription.patientId, patientId), inArray(prescription.encounterId, encounterIds)))
      .orderBy(asc(prescription.prescriptionNumber)),
    tx
      .select()
      .from(clinicalOrder)
      .where(and(eq(clinicalOrder.organizationId, orgId), eq(clinicalOrder.patientId, patientId), inArray(clinicalOrder.encounterId, encounterIds)))
      .orderBy(asc(clinicalOrder.createdAt), asc(clinicalOrder.id)),
    tx
      .select({
        id: clinicalFormResponse.id,
        encounterId: clinicalFormResponse.encounterId,
        templateTitle: clinicalFormResponse.templateTitle,
        status: clinicalFormResponse.status,
        finalizedAt: clinicalFormResponse.finalizedAt,
        discardedAt: clinicalFormResponse.discardedAt,
        discardReason: clinicalFormResponse.discardReason,
        attentionStatus: encounter.status,
        attentionSignedAt: encounter.finalizedAt,
        attentionVoidedAt: encounter.voidedAt,
      })
      .from(clinicalFormResponse)
      .innerJoin(
        encounter,
        and(eq(encounter.organizationId, clinicalFormResponse.organizationId), eq(encounter.id, clinicalFormResponse.encounterId)),
      )
      .where(
        and(
          eq(clinicalFormResponse.organizationId, orgId),
          eq(clinicalFormResponse.patientId, patientId),
          inArray(clinicalFormResponse.encounterId, encounterIds),
          // Lo finalizado y lo que el equipo dejó a medias. Lo descartado no es de la historia, salvo
          // en una atención anulada: ahí se dice qué formularios tenía y qué pasó con cada uno.
          sql`(${clinicalFormResponse.status} = 'finalizado'
            or (${clinicalFormResponse.status} = 'borrador' and ${clinicalFormResponse.source} = 'staff')
            or (${clinicalFormResponse.status} = 'descartado' and ${encounter.status} = 'anulada'))`,
        ),
      )
      .orderBy(asc(clinicalFormResponse.createdAt), asc(clinicalFormResponse.id)),
    tx
      .select()
      .from(clinicalFollowUp)
      .where(
        and(
          eq(clinicalFollowUp.organizationId, orgId),
          eq(clinicalFollowUp.patientId, patientId),
          inArray(clinicalFollowUp.originEncounterId, encounterIds),
        ),
      )
      .orderBy(asc(clinicalFollowUp.dueAt), asc(clinicalFollowUp.id)),
  ])
  for (const item of items) {
    if (!item.sourceEncounterId) continue
    of(item.sourceEncounterId).indicated.push({
      id: item.id,
      title: item.title,
      where: site.words(item, "full"),
      stateText: planItemStateText(item.status, item.decisionStatus),
      retired: isRetiredPlanStatus(item.status),
      budgetId: item.budgetId,
    })
  }
  // Sus presupuestos, por sus líneas (no por el presupuesto al que hoy apunta cada
  // tratamiento: al cancelarse o revisarse, ese vínculo cambia). Es la misma regla
  // que lo saca del listado suelto (`getTimeline`): va dentro solo si todo lo que
  // lleva nació en atenciones que se muestran, y en la más reciente de ellas.
  const touched = await tx.execute<{ budgetId: string; encounterId: string | null; status: string | null; startedAt: string | null }>(sql`
    select distinct line.budget_id as "budgetId", item.source_encounter_id as "encounterId", born.status, born.started_at::text as "startedAt"
    from treatment_budget_item line
    join treatment_plan_item item on item.organization_id = line.organization_id and item.id = line.plan_item_id
    left join encounter born on born.organization_id = item.organization_id and born.id = item.source_encounter_id
    where line.organization_id = ${orgId} and item.patient_id = ${patientId}::uuid
      and line.budget_id in (select own_line.budget_id from treatment_budget_item own_line
        join treatment_plan_item own_item on own_item.organization_id = own_line.organization_id and own_item.id = own_line.plan_item_id
        where own_line.organization_id = ${orgId} and own_item.source_encounter_id in (${sql.join(
          encounterIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}))`)
  const ownerOf = new Map<string, string>()
  for (const budgetId of new Set(touched.map((row) => row.budgetId))) {
    const sources = touched.filter((row) => row.budgetId === budgetId)
    if (sources.some((row) => !row.encounterId || !["finalizada", "anulada", "borrador"].includes(row.status ?? ""))) continue
    const owner = sources.reduce((a, b) => ((a.startedAt ?? "") >= (b.startedAt ?? "") ? a : b))
    if (owner.encounterId && encounterIds.includes(owner.encounterId)) ownerOf.set(budgetId, owner.encounterId)
  }
  const budgetIds = [...ownerOf.keys()]
  if (budgetIds.length) {
    const [budgets, lines, options] = await Promise.all([
      tx.select().from(treatmentBudget).where(and(eq(treatmentBudget.organizationId, orgId), inArray(treatmentBudget.id, budgetIds))),
      tx
        .select({
          budgetId: treatmentBudgetItem.budgetId,
          planItemId: treatmentBudgetItem.planItemId,
          decision: treatmentBudgetItem.decision,
          optionId: treatmentBudgetItem.optionId,
        })
        .from(treatmentBudgetItem)
        .where(and(eq(treatmentBudgetItem.organizationId, orgId), inArray(treatmentBudgetItem.budgetId, budgetIds))),
      tx
        .select({
          id: treatmentBudgetOption.id,
          budgetId: treatmentBudgetOption.budgetId,
          decision: treatmentBudgetOption.decision,
          position: treatmentBudgetOption.position,
        })
        .from(treatmentBudgetOption)
        .where(and(eq(treatmentBudgetOption.organizationId, orgId), inArray(treatmentBudgetOption.budgetId, budgetIds))),
    ])
    for (const budget of budgets.sort((a, b) => a.budgetNumber - b.budgetNumber)) {
      const owner = ownerOf.get(budget.id)
      if (!owner) continue
      of(owner).budgets.push({
        id: budget.id,
        budgetNumber: budget.budgetNumber,
        stateText: budgetStateText({
          status: budget.status,
          items: lines.filter((line) => line.budgetId === budget.id),
          options: options.filter((option) => option.budgetId === budget.id),
        }),
        // Cancelado o reemplazado por su revisión: ya no vale, se pliega.
        retired: budget.status === "cancelado" || budget.status === "sustituido",
      })
    }
  }
  for (const row of consents) {
    // La revocación sale aparte, en su día (`getTimeline`).
    if (!row.encounterId || row.status === "revocado") continue
    of(row.encounterId).consents.push({
      id: row.id,
      title: row.titleSnapshot,
      status: row.status,
      signerName: row.status === "firmado" ? row.signerName : null,
      relation: row.status === "firmado" ? row.representativeRelation : null,
    })
  }
  const recipeIds = recipes.map((row) => row.id)
  const medications = recipeIds.length
    ? await tx
        .select({ prescriptionId: prescriptionItem.prescriptionId, medicationName: prescriptionItem.medicationName, dose: prescriptionItem.dose })
        .from(prescriptionItem)
        .where(and(eq(prescriptionItem.organizationId, orgId), inArray(prescriptionItem.prescriptionId, recipeIds)))
        .orderBy(asc(prescriptionItem.createdAt), asc(prescriptionItem.id))
    : []
  for (const row of recipes) {
    if (!row.encounterId) continue
    of(row.encounterId).prescriptions.push({
      id: row.id,
      number: row.prescriptionNumber,
      detail:
        medications
          .filter((m) => m.prescriptionId === row.id)
          .map((m) => `${m.medicationName} ${m.dose}`)
          .join(" · ") || "Sin medicamentos",
      // Una receta anulada se ve: la impresa pudo salir (mesa del 9 nov).
      voided: row.status === "anulada",
      reason: row.status === "anulada" ? row.cancelReason : null,
    })
  }
  for (const row of orders) {
    if (!row.encounterId) continue
    of(row.encounterId).orders.push({
      id: row.id,
      title: row.title,
      state: row.status === "completado" ? "con resultado" : row.status === "cancelado" ? "cancelada" : "sin resultado",
    })
  }
  for (const row of forms) {
    if (!row.encounterId) continue
    const finalized = row.status === "finalizado"
    const discarded = row.status === "descartado"
    of(row.encounterId).forms.push({
      id: row.id,
      title: row.templateTitle ?? "Formulario clínico",
      state: finalized ? "finalizado" : discarded ? "descartado" : "a_medias",
      finalizedAt: row.finalizedAt,
      // Terminado después de firmar la atención: lleva su propia fecha, y la Historia lo dice.
      afterSigning: finalized && !!row.finalizedAt && !!row.attentionSignedAt && row.finalizedAt > row.attentionSignedAt,
      retired: row.attentionStatus === "anulada",
      discardReason: discarded ? row.discardReason : null,
      // La anulación lo descartó en su misma transacción: el mismo instante.
      discardedWithAttention:
        discarded && !!row.discardedAt && !!row.attentionVoidedAt && row.discardedAt.getTime() === row.attentionVoidedAt.getTime(),
    })
  }
  // Vencido con la misma regla del Plan, el Resumen y «Control vencido».
  const overdue = controls.some((row) => row.status === "pendiente")
    ? new Set((await listFollowUps(tx, orgId, patientId)).filter((row) => row.overdue).map((row) => row.id))
    : new Set<string>()
  for (const row of controls) {
    if (!row.originEncounterId) continue
    of(row.originEncounterId).followUps.push({
      id: row.id,
      title: row.title,
      dueAt: row.dueAt,
      stateText: overdue.has(row.id) ? "Vencido" : (FOLLOW_UP_STATE_WORDS[row.status] ?? "Por reservar"),
      retired: row.status === "cancelado",
    })
  }
  return out
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
  const site = (await productHooks(tx, orgId)).site
  const toothCode = input.toothNumber == null ? null : site.code(input.toothNumber)
  if (input.toothNumber != null && toothCode === null) throw validation(site.invalid(input.toothNumber))
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
  // Las atenciones firmadas y las anuladas, a la hora en que empezaron (la de su
  // detalle y su resumen): una anulada queda en el día en que ocurrió, con su
  // motivo y cuándo se anuló (QA de la ficha del 8 nov: salía en otro día,
  // arriba de lo vigente). Historia absorbe la lista de Atenciones (ADR 0035).
  // La atención en curso también es su tarjeta, marcada sin firmar (QA del 9 nov): antes
  // lo nacido en ella salía suelto y la atención no se veía.
  if (types.includes("encounter"))
    branches.push(sql`select id, 'encounter'::text as kind, started_at as created_at from encounter where organization_id = ${orgId} and patient_id = ${patientId}::uuid and status in ('finalizada', 'anulada', 'borrador')
    ${tooth == null ? sql`` : sql`and exists (select 1 from encounter_site et where et.encounter_id = encounter.id and et.organization_id = ${orgId} and et.site_system = ${site.system} and et.site_code = ${toothCode})`}`)
  // En la historia completa, lo que nació en una atención que se muestra va dentro
  // de su tarjeta (`born`) y no sale suelto, como sus documentos (QA de la ficha
  // del 8 nov: un día eran 14 tarjetas). Lo de la atención en curso, también.
  const absorb = types.includes("encounter")
  const shown = (column: SQL) =>
    sql`(${column} is not null and exists (select 1 from encounter shown where shown.organization_id = ${orgId} and shown.id = ${column} and shown.status in ('finalizada', 'anulada', 'borrador')))`
  const outside = (column: SQL) => (absorb ? sql`and not ${shown(column)}` : sql``)
  // Los papeles, a la hora de lo que pasó con ellos: el consentimiento cuando se
  // firmó o se revocó, la orden cuando se pidió y el formulario al completarse.
  // La revocación es un hecho propio, en su día: no se esconde en la atención.
  if (types.includes("consent") && tooth == null)
    branches.push(
      sql`select id, 'consent'::text as kind, coalesce(revoked_at, signed_at, created_at) as created_at from consent_document where organization_id = ${orgId} and patient_id = ${patientId}::uuid
        ${absorb ? sql`and (status = 'revocado' or not ${shown(sql`consent_document.encounter_id`)})` : sql``}`,
    )
  if (types.includes("order") && tooth == null)
    branches.push(
      sql`select id, 'order'::text as kind, created_at from clinical_order where organization_id = ${orgId} and patient_id = ${patientId}::uuid ${outside(sql`clinical_order.encounter_id`)}`,
    )
  if (types.includes("form") && tooth == null)
    branches.push(
      sql`select id, 'form'::text as kind, finalized_at as created_at from clinical_form_response where organization_id = ${orgId} and patient_id = ${patientId}::uuid and status = 'finalizado' and finalized_at is not null ${outside(sql`clinical_form_response.encounter_id`)}`,
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
        : sql`and exists (select 1 from patient_document_context c where c.document_id = patient_document.id and c.organization_id = ${orgId} and c.version = (select max(version) from patient_document_context where document_id = patient_document.id and organization_id = ${orgId}) and c.site_system = ${site.system} and ${toothCode} = any(c.site_codes))`
    // En la historia completa viven dentro de su atención; al filtrar documentos
    // deben seguir visibles aunque no se estén solicitando las atenciones.
    // Lo retirado ya no está en la tarjeta de su atención: sale suelto, plegado como retirado.
    const linkedFilter =
      types.includes("encounter") && !input.documentCategory
        ? sql`and (patient_document.retired_at is not null or not exists (select 1 from patient_document_context c where c.document_id = patient_document.id and c.organization_id = ${orgId} and c.version = (select max(version) from patient_document_context where document_id = patient_document.id and organization_id = ${orgId}) and c.encounter_id is not null))`
        : sql``
    // El PDF de un consentimiento no es otro hecho: «Firmó: …» ya lo dice y
    // lleva a Documentos (QA de la ficha del 8 nov: el consentimiento salía dos veces).
    const consentPaper = types.includes("consent")
      ? sql`and not exists (select 1 from consent_document paper where paper.organization_id = ${orgId} and paper.patient_id = ${patientId}::uuid
          and patient_document.id in (paper.pdf_document_id, paper.revoke_pdf_document_id, paper.paper_document_id))`
      : sql``
    // Cada papel va el día de su fecha (la de toma, en una imagen), aunque se haya subido
    // después: la historia de otra clínica no se amontona en el día en que se cargó.
    branches.push(
      sql`select id, 'document'::text as kind, coalesce(captured_at, created_at) as created_at from patient_document where organization_id = ${orgId} and patient_id = ${patientId}::uuid ${linkedFilter} ${consentPaper} ${toothFilter} ${input.documentCategory ? sql`and category = ${input.documentCategory}` : sql``}`,
    )
  }
  const journeySources = [
    { type: "plan", table: "treatment_plan_item", ref: "planItemId" },
    { type: "budget", table: "treatment_budget", ref: "budgetId" },
    { type: "follow_up", table: "clinical_follow_up", ref: "followUpId" },
    { type: "prescription", table: "prescription", ref: "prescriptionId" },
  ] as const
  // Dónde nació cada uno: el tratamiento en la atención que lo indicó, el control
  // en la que lo indicó, la receta en la suya. El presupuesto no guarda su
  // atención: va dentro solo si todo lo que lleva nació en atenciones que se ven.
  const bornIn: Record<(typeof journeySources)[number]["type"], SQL> = {
    plan: outside(sql`treatment_plan_item.source_encounter_id`),
    follow_up: outside(sql`clinical_follow_up.origin_encounter_id`),
    prescription: outside(sql`prescription.encounter_id`),
    budget: absorb
      ? sql`and not (exists (select 1 from treatment_budget_item line where line.organization_id = ${orgId} and line.budget_id = treatment_budget.id)
          and not exists (select 1 from treatment_budget_item line join treatment_plan_item item on item.organization_id = line.organization_id and item.id = line.plan_item_id
            where line.organization_id = ${orgId} and line.budget_id = treatment_budget.id and not ${shown(sql`item.source_encounter_id`)}))`
      : sql``,
  }
  for (const source of journeySources) {
    if (!types.includes(source.type) || tooth != null) continue
    branches.push(sql`select id, ${source.type}::text as kind, created_at from ${sql.identifier(source.table)}
      where organization_id = ${orgId} and patient_id = ${patientId}::uuid ${bornIn[source.type]}`)
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
          status: encounterDiagnosis.status,
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
    const people = [...new Set(records.flatMap((row) => [row.professionalUserId, row.voidedBy].filter((id): id is string => !!id)))]
    const [planned, docs, productParts, born, titles, names, sessions] = await Promise.all([
      loadPlannedForEncounters(tx, orgId, encounters),
      loadDocsForEncounters(tx, orgId, patientId, encounters),
      hooks.encounterParts(tx, orgId, encounters),
      types.includes("encounter") ? loadBornForEncounters(tx, orgId, patientId, encounters) : Promise.resolve(new Map<string, EncounterBorn>()),
      diagnosisTitlesOf(tx, [
        ...procedures.map((p) => ({ system: p.diagnosisSystem, code: p.diagnosisCode })),
        ...notes.map((n) => ({ system: n.diagnosisSystem, code: n.diagnosisCode })),
      ]),
      people.length ? tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, people)) : Promise.resolve([]),
      encounterSessionsOf(tx, orgId, encounters),
    ])
    const nameOf = new Map(names.map((row) => [row.id, row.name]))
    for (const row of records) {
      const rowProcedures = procedures.filter((p) => p.encounterId === row.id)
      const rowNotes = notes.filter((n) => n.encounterId === row.id)
      const related = docs.get(row.id) ?? []
      // Con su nombre: «Pulpitis (CIE-11 DA09.0)», no solo el código (QA de la ficha del 8 nov).
      // Resuelto, lo dice sin abrir la tarjeta, con la palabra del detalle (tercer repaso del 9 nov, E8).
      // Solo si todas las piezas con ese diagnóstico quedaron resueltas: la caries de la 26 sigue
      // activa aunque la resina resolviera la de la 16 (revisión antes de entregar).
      const noteName = (n: (typeof rowNotes)[number]) => namedDiagnosis(titles, n.diagnosisSystem, n.diagnosisCode)
      const resolved = new Set(
        rowNotes
          .filter((n) => n.status === "resuelto")
          .map(noteName)
          .filter((name) => rowNotes.every((other) => noteName(other) !== name || other.status === "resuelto")),
      )
      const diagnoses = [
        ...new Set(
          [
            ...rowProcedures.map((p) => (p.diagnosisCode ? namedDiagnosis(titles, p.diagnosisSystem, p.diagnosisCode) : null)),
            ...rowNotes.map((n) => namedDiagnosis(titles, n.diagnosisSystem, n.diagnosisCode)),
          ].filter((code): code is string => !!code),
        ),
      ]
        .sort()
        .map((name) => (resolved.has(name) ? `${name} · resuelto` : name))
      hydrated.set(row.id, {
        id: row.id,
        refId: row.id,
        type: "encounter",
        createdAt: row.startedAt,
        voidReason: row.voidReason,
        voidedAt: row.voidedAt,
        voidedByName: row.voidedBy ? (nameOf.get(row.voidedBy) ?? null) : null,
        professionalName: nameOf.get(row.professionalUserId) ?? null,
        // Quién la firmó y cuándo: lo que se lee es definitivo (segunda mesa del 9 nov).
        signerName: row.status === "finalizada" ? row.signerName : null,
        signedAt: row.status === "finalizada" ? row.finalizedAt : null,
        // Lo que se hizo en ella no se repite en «Se indicó».
        ...(born.has(row.id)
          ? {
              born: {
                ...born.get(row.id)!,
                indicated: born
                  .get(row.id)!
                  .indicated.filter((item) => !rowProcedures.some((p) => p.planItemId === item.id)),
              },
            }
          : {}),
        title: row.reason || "Atención",
        detail: row.evolution,
        toothNumbers: teeth
          .filter((t) => t.encounterId === row.id)
          .map((t) => looseValue(site, t))
          .filter((tooth): tooth is number => tooth != null)
          .sort((a, b) => a - b),
        authorId: row.professionalUserId,
        status: row.status,
        // Con su pieza: un procedimiento sin el diente tratado no se lee (segunda mesa del 9 nov).
        // Y con su sesión: «sesión 2 de 2 · tratamiento terminado» sin abrir la tarjeta (E8).
        procedures: rowProcedures.map((p) => {
          const session = p.planItemId ? sessions.get(encounterSessionKey(row.id, p.planItemId)) : undefined
          return [p.description, site.words(p, "full"), session ? doneSessionWords(session.n, session.m, session.finished) : null]
            .filter(Boolean)
            .join(" · ")
        }),
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
        createdAt: row.capturedAt ?? row.createdAt,
        uploadedAt: row.createdAt,
        // Lo retirado queda en su día, plegado y con su motivo, no como vigente.
        ...(row.retiredAt ? { status: "retirado", voidReason: row.retireReason } : {}),
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
      // Indicado sin decir la pieza (se define al hacerlo): no es «General».
      const where = site.words(row, "full") ?? (row.scope && site.pending?.(row, row.scope) ? "Pieza por definir" : "General")
      hydrated.set(row.id, {
        ...hydrated.get(row.id)!,
        createdAt: row.createdAt,
        title: row.title,
        // El estado va una vez, en palabras (QA de la ficha del 8 nov: «Pieza 46 · en_curso»).
        detail: where,
        status: row.status,
        statusText: planItemStateText(row.status, row.decisionStatus),
        decision: row.decisionStatus,
        toothNumbers: [looseValue(site, row)].filter((tooth): tooth is number => tooth !== null),
        authorId: row.createdBy,
        planId: row.planId,
        planItemId: row.id,
        encounterId: row.sourceEncounterId,
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
        .select({ id: treatmentBudgetOption.id, decision: treatmentBudgetOption.decision, position: treatmentBudgetOption.position })
        .from(treatmentBudgetOption)
        .where(and(eq(treatmentBudgetOption.organizationId, orgId), eq(treatmentBudgetOption.budgetId, row.id)))
      // Un tratamiento cuenta una vez aunque esté en varias opciones.
      const total = new Set(lines.map((line) => line.planItemId)).size
      hydrated.set(row.id, {
        ...hydrated.get(row.id)!,
        createdAt: row.createdAt,
        // Sin repetir el número si su nombre ya lo lleva («Presupuesto N.º 453 · Presupuesto N.º 453»).
        title: row.title && !row.title.includes(`N.º ${row.budgetNumber}`) ? `Presupuesto N.º ${row.budgetNumber} · ${row.title}` : `Presupuesto N.º ${row.budgetNumber}`,
        detail: [`${total} ${total === 1 ? "tratamiento" : "tratamientos"}`, row.revisionNumber > 1 ? `revisión ${row.revisionNumber}` : null].filter(Boolean).join(" · "),
        status: row.status,
        // Los mismos nombres que Plan (ADR 0034): «Entregado · espera respuesta», «Aceptó 2 de 3»…
        statusText: budgetStateText({ status: row.status, items: lines, options }),
        authorId: row.createdBy,
        planId: row.planId,
        budgetId: row.id,
      })
    }
  const followUpIds = ids("follow_up")
  // Vencido con la misma regla del Plan, el Resumen y «Control vencido» (QA del 8 nov, B4:
  // la Historia decía «Pendiente · Vence 5/5/2026» de un control que el Plan llama «Vencido»).
  const overdueControls = followUpIds.length
    ? new Set((await listFollowUps(tx, orgId, patientId)).filter((row) => row.overdue).map((row) => row.id))
    : new Set<string>()
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
        statusText: overdueControls.has(row.id) ? "Vencido" : null,
        dueAt: row.dueAt,
        authorId: row.createdBy,
        planItemId: row.planItemId,
        followUpId: row.id,
        encounterId: row.originEncounterId,
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
        title:
          row.status === "anulada" ? `Se anuló la receta N.º ${row.prescriptionNumber}` : `Receta N.º ${row.prescriptionNumber}`,
        detail:
          [
            medications.map((m) => `${m.medicationName} ${m.dose}`).join(" · ") || "Sin medicamentos",
            row.status === "anulada" ? row.cancelReason : null,
          ]
            .filter(Boolean)
            .join(" · "),
        status: row.status,
        authorId: row.issuedBy,
        planItemId: row.planItemId,
        prescriptionId: row.id,
        encounterId: row.encounterId,
      })
    }
  const consentIds = ids("consent")
  if (consentIds.length)
    for (const row of await tx
      .select()
      .from(consentDocument)
      .where(and(eq(consentDocument.organizationId, orgId), inArray(consentDocument.id, consentIds)))) {
      // El rótulo ya dice «Consentimiento»: el título dice qué pasó una sola vez (QA de la ficha del 8 nov).
      const fact =
        row.status === "revocado"
          ? { at: row.revokedAt, title: `Revocó: ${row.titleSnapshot}`, detail: row.revokeReason }
          : row.status === "firmado"
            ? {
                at: row.signedAt,
                title: `Firmó: ${row.titleSnapshot}`,
                detail: row.signerName ? `Lo firmó ${row.signerName}${row.representativeRelation ? ` (${row.representativeRelation})` : ""}` : null,
              }
            : row.status === "anulado"
              ? { at: null, title: `Se anuló: ${row.titleSnapshot}`, detail: null }
              : { at: null, title: `Falta la firma: ${row.titleSnapshot}`, detail: null }
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
  const orderRows = orderIds.length
    ? await tx.select().from(clinicalOrder).where(and(eq(clinicalOrder.organizationId, orgId), inArray(clinicalOrder.id, orderIds)))
    : []
  const orderTitles = await diagnosisTitlesOf(tx, orderRows.map((row) => ({ system: row.diagnosisSystem, code: row.diagnosisCode })))
  for (const row of orderRows) {
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
        diagnosisCode: row.diagnosisCode ? namedDiagnosis(orderTitles, row.diagnosisSystem, row.diagnosisCode) : null,
        toothNumbers: [],
        authorId: row.fromUserId,
        encounterId: row.encounterId,
      })
    }
  const formIds = ids("form")
  if (formIds.length)
    for (const { row, reviewer } of await tx
      .select({ row: clinicalFormResponse, reviewer: user.name })
      .from(clinicalFormResponse)
      .leftJoin(user, eq(user.id, clinicalFormResponse.finalizedBy))
      .where(and(eq(clinicalFormResponse.organizationId, orgId), inArray(clinicalFormResponse.id, formIds)))) {
      hydrated.set(row.id, {
        id: row.id,
        refId: row.id,
        type: "form",
        createdAt: row.finalizedAt ?? row.createdAt,
        title: `Se completó el formulario: ${row.templateTitle ?? "Formulario clínico"}`,
        // Lo que envió el paciente: quién lo revisó, si quedó guardado; nunca se afirma sin saberlo.
        detail:
          row.source === "portal"
            ? reviewer
              ? `Lo respondió la persona y lo revisó ${reviewer}`
              : "Lo respondió la persona y el equipo lo revisó"
            : null,
        status: row.status,
        toothNumbers: [],
        authorId: row.authorUserId,
        encounterId: row.encounterId,
      })
    }
  // Lo de una atención que sigue en curso sale suelto (el borrador no es todavía un
  // hecho de la historia) y lo dice, para no leerlo como cerrado (segunda mesa del 9 nov).
  const drafts = new Set(
    (
      await tx
        .select({ id: encounter.id })
        .from(encounter)
        .where(and(eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId), eq(encounter.status, "borrador")))
    ).map((row) => row.id),
  )
  if (drafts.size)
    for (const item of hydrated.values())
      if (item.type !== "encounter" && item.encounterId && drafts.has(item.encounterId)) item.openEncounter = true
  // Los pagos no son historia clínica: sus movimientos viven en la cuenta.
  const last = page[page.length - 1]!
  return {
    data: page.map((row) => hydrated.get(row.id)!),
    nextCursor: rows.length > limit ? encodeCursor(last.cursor_ts, last.id) : null,
    timezone,
    locale,
  }
}
