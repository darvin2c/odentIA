/**
 * Lo que una ficha llenada a mano dice que es un diagnóstico (estudio de la atención del 16 nov,
 * E10b): «Pulpitis irreversible sintomática» en la ficha de endodoncia es K04.0 de la CIE-10 en la
 * pieza de esa ficha. Antes solo lo veía el dictado (`withFormDiagnoses`); escrito a mano, la ficha no
 * proponía nada y la periodontitis apical quedaba fuera de Diagnóstico. Con el mismo mapa del
 * producto (`ProductForms.diagnoses`), la ficha lo propone con «Usar» y la Historia dice el término
 * junto al código (`ProductForms.qualifiers`). Proponer no es registrar: nada entra solo.
 */
import { normalizeSearchText } from "@odentia/clinical"
import type { FormSchemaDef } from "./clinical-forms.js"
import type { ProductForms } from "./product-hooks.js"

/** Una respuesta de una ficha, como la guarda la atención. */
export interface FormAnswersRow {
  id: string
  encounterId: string | null
  templateSnapshot: unknown
  answers: unknown
}

/** Un diagnóstico que dice una ficha: su código de la CIE-10, el término tal cual y su pieza. */
export interface FormDiagnosis {
  responseId: string
  encounterId: string | null
  /** La pregunta que lo dice («Diagnóstico pulpar»). */
  fieldId: string
  fieldLabel: string
  /** La respuesta, como se escribe en la ficha: «Pulpitis irreversible sintomática». */
  term: string
  code: string
  /** Lo que el término le suma al nombre del código («irreversible sintomática»), o null. */
  qualifier: string | null
  /** La pieza de su ficha; null si no la tiene. */
  toothNumber: number | null
}

/** Las preguntas de un esquema guardado, sin suponer su forma: lo que no es un esquema no tiene ninguna. */
function fieldsOf(snapshot: unknown): FormSchemaDef["sections"][number]["fields"] {
  const sections = (snapshot as Partial<FormSchemaDef> | null)?.sections
  return Array.isArray(sections) ? sections.flatMap((section) => (Array.isArray(section?.fields) ? section.fields : [])) : []
}

/**
 * Los diagnósticos que dicen las respuestas de unas fichas, en el orden de sus preguntas: cada
 * respuesta de opción única que el producto sabe que es un diagnóstico, con la pieza de su misma
 * ficha. Sin el mapa del producto (latidIA, vistIA), nada.
 */
export function formDiagnosesOf(rows: readonly FormAnswersRow[], forms: Pick<ProductForms, "diagnoses" | "qualifiers">): FormDiagnosis[] {
  const codes = forms.diagnoses
  if (!codes) return []
  const byTerm = new Map(Object.entries(codes).map(([term, code]) => [normalizeSearchText(term), { term, code }]))
  const qualifiers = new Map(Object.entries(forms.qualifiers ?? {}).map(([term, words]) => [normalizeSearchText(term), words]))
  const out: FormDiagnosis[] = []
  for (const row of rows) {
    const fields = fieldsOf(row.templateSnapshot)
    const answers = (row.answers ?? {}) as Record<string, unknown>
    const toothField = fields.find((field) => field.type === "pieza")
    const tooth = toothField ? answers[toothField.id] : undefined
    const toothNumber = typeof tooth === "number" && Number.isInteger(tooth) ? tooth : null
    for (const field of fields) {
      if (field.type !== "opcion_unica") continue
      const value = answers[field.id]
      if (typeof value !== "string") continue
      const key = normalizeSearchText(value)
      const known = byTerm.get(key)
      if (!known) continue
      out.push({
        responseId: row.id,
        encounterId: row.encounterId,
        fieldId: field.id,
        fieldLabel: field.label,
        term: known.term,
        code: known.code,
        qualifier: qualifiers.get(key) ?? null,
        toothNumber,
      })
    }
  }
  return out
}

/** La clave con que la Historia junta el término de la ficha con su diagnóstico: atención, código y pieza. */
export const formDiagnosisKey = (encounterId: string, code: string, toothNumber: number | null): string =>
  `${encounterId}|${code}|${toothNumber ?? ""}`
