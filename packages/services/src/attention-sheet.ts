/**
 * La hoja de atención (ADR 0133): lo que el seguro pide de una atención para reembolsarla.
 * Sale solo de una atención firmada, que ya no cambia, y lleva lo que piden: diagnóstico,
 * fecha, lo que se hizo, exámenes y tratamiento sugerido. No lleva evolución, examen ni
 * antecedentes: el papel sale de la clínica y nadie los pide.
 */
import {
  DIAGNOSIS_VERIFICATION_LABELS,
  type DiagnosisVerification,
  diagnosisCodeLabel,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { listClinicalOrders } from "./clinical-forms.js"
import { ORDER_KIND_WORDS } from "./clinical-papers.js"
import { getEncounterDetail } from "./encounters.js"
import { ServiceError } from "./errors.js"
import { requirePatient } from "./patients.js"
import { productHooks } from "./products.js"
import { drawnSignatureAt } from "./professional-profiles.js"

export const ATTENTION_SHEET_LABEL = "Hoja de atención"

/** Lo que se le manda a hacer y lo que indica; una derivación no es un examen. */
const EXAM_KINDS = new Set(["imagen", "laboratorio"])
/** Lo ya hecho va en procedimientos, y lo que no sigue en pie no se sugiere. */
const DROPPED_TREATMENTS = new Set(["realizado", "cancelado", "reemplazado"])

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
    treatments: detail.indicatedItems
      .filter((item) => !DROPPED_TREATMENTS.has(item.status))
      .map((item) => withSiteWords(item.title, item)),
    signerStrokes: await drawnSignatureAt(tx, orgId, encounter.finalizedBy, encounter.finalizedAt),
  }
}
