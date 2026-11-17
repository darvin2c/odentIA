/**
 * La hoja de atención (ADR 0133): lo que el seguro pide de una atención para reembolsarla.
 * Sale solo de una atención firmada, que ya no cambia, y lleva lo que piden: diagnóstico,
 * fecha, lo que se hizo, exámenes y tratamiento sugerido. No lleva evolución, examen ni
 * antecedentes: el papel sale de la clínica y nadie los pide.
 */
import {
  budgetOptionLabel,
  DIAGNOSIS_VERIFICATION_LABELS,
  type DiagnosisVerification,
  diagnosisCodeLabel,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { treatmentBudgetItem, treatmentBudgetOption } from "@odentia/db/schema/clinical"
import { and, asc, eq, inArray } from "drizzle-orm"
import { listClinicalOrders } from "./clinical-forms.js"
import { ORDER_KIND_WORDS } from "./clinical-papers.js"
import { type EncounterItem, getEncounterDetail } from "./encounters.js"
import { ServiceError } from "./errors.js"
import { requirePatient } from "./patients.js"
import { productHooks } from "./products.js"
import { drawnSignatureAt } from "./professional-profiles.js"

export const ATTENTION_SHEET_LABEL = "Hoja de atención"

/** Lo que se le manda a hacer y lo que indica; una derivación no es un examen. */
const EXAM_KINDS = new Set(["imagen", "laboratorio"])
/** Lo ya hecho va en procedimientos, y lo que no sigue en pie no se sugiere. */
const DROPPED_TREATMENTS = new Set(["realizado", "cancelado", "reemplazado"])
/**
 * Lo que la persona no eligió o rechazó tampoco (QA del 16 nov): la hoja sale de la clínica y
 * no puede sugerir la exodoncia de la opción que no eligió. Se mira la decisión, no solo la
 * ejecución.
 */
const DROPPED_DECISIONS = new Set(["no_elegida", "rechazado", "reemplazado"])

/** «Tratamiento sugerido», o con opciones «Tratamiento sugerido · Opción A (elegida)». */
export interface AttentionSheetTreatments {
  heading: string
  items: string[]
}

const SUGGESTED = "Tratamiento sugerido"

/**
 * Lo sugerido, agrupado como lo decidió la persona: lo que va en todas las opciones de su
 * presupuesto (o sin opciones) bajo «Tratamiento sugerido»; lo de una opción, bajo su nombre,
 * «(elegida)» si la eligió o «(a elegir)» si todavía no. Sin opciones, la hoja queda como antes.
 */
async function suggestedTreatments(
  tx: Db,
  orgId: string,
  items: EncounterItem[],
  words: (item: EncounterItem) => string,
): Promise<AttentionSheetTreatments[]> {
  const budgetIds = [...new Set(items.flatMap((item) => (item.budgetId ? [item.budgetId] : [])))]
  const options =
    budgetIds.length === 0
      ? []
      : await tx
          .select({
            id: treatmentBudgetOption.id,
            budgetId: treatmentBudgetOption.budgetId,
            position: treatmentBudgetOption.position,
            decision: treatmentBudgetOption.decision,
          })
          .from(treatmentBudgetOption)
          .where(
            and(
              eq(treatmentBudgetOption.organizationId, orgId),
              inArray(treatmentBudgetOption.budgetId, budgetIds),
            ),
          )
          .orderBy(asc(treatmentBudgetOption.position))
  const withPaths = new Set(
    budgetIds.filter((id) => options.filter((option) => option.budgetId === id).length > 1),
  )
  const lines =
    withPaths.size === 0
      ? []
      : await tx
          .select({
            optionId: treatmentBudgetItem.optionId,
            planItemId: treatmentBudgetItem.planItemId,
          })
          .from(treatmentBudgetItem)
          .where(
            and(
              eq(treatmentBudgetItem.organizationId, orgId),
              inArray(treatmentBudgetItem.budgetId, [...withPaths]),
            ),
          )
  const common: string[] = []
  const byOption = new Map<string, string[]>()
  for (const item of items) {
    const paths =
      item.budgetId && withPaths.has(item.budgetId)
        ? options.filter((option) => option.budgetId === item.budgetId)
        : []
    const mine = paths.filter((option) =>
      lines.some((line) => line.optionId === option.id && line.planItemId === item.id),
    )
    // En todas sus opciones (lo común) o sin opciones: sin nombre de opción.
    const own =
      mine.length > 0 && mine.length < paths.length
        ? (mine.find((option) => option.decision === "elegida") ??
          mine.find((option) => option.decision !== "no_elegida"))
        : undefined
    if (!own) common.push(words(item))
    else byOption.set(own.id, [...(byOption.get(own.id) ?? []), words(item)])
  }
  return [
    ...(common.length > 0 ? [{ heading: SUGGESTED, items: common }] : []),
    ...options.flatMap((option) => {
      const chosen = byOption.get(option.id)
      if (!chosen) return []
      const how = option.decision === "elegida" ? "elegida" : "a elegir"
      return [
        { heading: `${SUGGESTED} · ${budgetOptionLabel(option.position)} (${how})`, items: chosen },
      ]
    }),
  ]
}

export async function getAttentionSheetPrint(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
) {
  const detail = await getEncounterDetail(tx, orgId, patientId, encounterId)
  const { encounter } = detail
  if (encounter.status !== "finalizada" || !encounter.finalizedAt)
    throw new ServiceError(
      "ATTENTION_NOT_SIGNED",
      409,
      "La hoja de atención sale cuando la atención está firmada",
    )
  const { site } = await productHooks(tx, orgId)
  const withSiteWords = (text: string, row: Parameters<typeof site.words>[0]) => {
    const where = site.words(row, "full")
    return where ? `${text} · ${where}` : text
  }
  const person = await requirePatient(tx, orgId, patientId)
  const orders = await listClinicalOrders(tx, orgId, { patientId, encounterId })
  return {
    encounter,
    signedAt: encounter.finalizedAt,
    patient: {
      displayName: person.displayName,
      patientNumber: person.patientNumber,
      docType: person.docType,
      docNumber: person.docNumber,
      birthDate: person.birthDate,
    },
    diagnoses: detail.diagnoses
      .filter((dx) => !dx.voidedAt)
      .map((dx) => {
        const code = diagnosisCodeLabel(dx.diagnosisSystem, dx.diagnosisCode)
        const kind = dx.diagnosisType
          ? DIAGNOSIS_VERIFICATION_LABELS[dx.diagnosisType as DiagnosisVerification]
          : null
        return withSiteWords(
          [dx.diagnosisTitle ? `${code} · ${dx.diagnosisTitle}` : code, kind]
            .filter(Boolean)
            .join(" · "),
          dx,
        )
      }),
    procedures: detail.procedures
      .filter((row) => !row.voidedAt)
      .map((row) =>
        withSiteWords(
          row.quantity > 1 ? `${row.description} (${row.quantity})` : row.description,
          row,
        ),
      ),
    exams: orders
      .filter((order) => EXAM_KINDS.has(order.kind) && order.status !== "cancelado")
      .map((order) => `${ORDER_KIND_WORDS[order.kind] ?? "Orden"}: ${order.title}`),
    treatments: await suggestedTreatments(
      tx,
      orgId,
      detail.indicatedItems.filter(
        (item) =>
          !DROPPED_TREATMENTS.has(item.status) && !DROPPED_DECISIONS.has(item.decisionStatus),
      ),
      (item) => withSiteWords(item.title, item),
    ),
    signerStrokes: await drawnSignatureAt(tx, orgId, encounter.finalizedBy, encounter.finalizedAt),
  }
}
