/**
 * Listas de diagnósticos de la clínica (fase 4, decisión 26 v3; ADR 0041).
 *
 * - Cada diagnóstico guarda su lista y su código. La clínica elige con qué
 *   lista trabaja (CIE-10 o CIE-11 de la OMS) en «Datos de la clínica»; al
 *   crearla viene la que recomienda su país.
 * - Los diagnósticos nuevos se eligen en la lista de la clínica. Lo anterior no
 *   se reescribe ni se convierte: nunca se calcula un código de una lista a
 *   partir de la otra. Una atención abierta conserva lo que ya tenía.
 * - Se elige en tres pasos: lo que propone el odontograma, los más usados de la
 *   clínica y el buscador de toda la lista, que ignora tildes y pone primero lo
 *   odontológico.
 *
 * Una sola regla para la atención, el panel de la pieza, el dictado y el
 * resto de lugares donde se escribe un código.
 */
import {
  clinicalProfileFor,
  DIAGNOSIS_SYSTEM_INFO,
  diagnosisCodeLabel,
  type DiagnosisSystemKey,
  findingDiagnosisCode,
  isDiagnosisSystem,
  isSelectableDiagnosisSystem,
  normalizeDiagnosisCode,
  normalizeSearchText,
  type SelectableDiagnosisSystem,
  ageInYears,
  withoutDiseaseOptions,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  clinicalFollowUp,
  diagnosisCatalog,
  encounter,
  encounterDiagnosis,
  encounterPlanItem,
  patientCondition,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { clinicalFormResponse } from "@odentia/db/schema/clinical-forms"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm"
import { notFound, validation } from "./errors.js"
import { formDiagnosesOf } from "./form-diagnoses.js"
import type { DiagnosisCandidate, SiteFields } from "./product-hooks.js"
import { productHooks } from "./products.js"

/** Un tratamiento cancelado o reemplazado ya no se continúa: ni propone su diagnóstico ni es motivo de una cita. */
export const DROPPED_PLAN_ITEM_STATUSES = ["cancelado", "reemplazado"]

/** Un código del catálogo, como se ofrece y se guarda. */
export interface DiagnosisCodeOption {
  system: DiagnosisSystemKey
  code: string
  description: string
  /** Categoría con subcódigos: no se registra como diagnóstico. */
  isCategory: boolean
}

/** La lista con la que trabaja la clínica: la guardada o, sin ella, la de su país. */
export async function orgDiagnosisSystem(tx: Db, orgId: string): Promise<DiagnosisSystemKey> {
  const [row] = await tx
    .select({ system: orgProfile.diagnosisSystem, country: orgProfile.countryCode })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  if (row?.system && isDiagnosisSystem(row.system)) return row.system
  return clinicalProfileFor(row?.country).diagnosis.recommended
}

function listName(system: DiagnosisSystemKey): string {
  return `la lista ${DIAGNOSIS_SYSTEM_INFO[system].title}`
}

/** El código de esa lista, o null si no está cargado. */
export async function findDiagnosisCode(
  tx: Db,
  system: DiagnosisSystemKey,
  rawCode: string,
): Promise<DiagnosisCodeOption | null> {
  const code = normalizeDiagnosisCode(system, rawCode.trim())
  if (!code) return null
  const [row] = await tx
    .select({
      code: diagnosisCatalog.code,
      title: diagnosisCatalog.title,
      isCategory: diagnosisCatalog.isCategory,
    })
    .from(diagnosisCatalog)
    .where(and(eq(diagnosisCatalog.systemKey, system), eq(diagnosisCatalog.code, code)))
    .limit(1)
  return row ? { system, code: row.code, description: row.title, isCategory: row.isCategory } : null
}

/**
 * El código de esa lista o, si no está, el más cercano que sí: su padre (K04.02 → K04.0 → K04).
 * Para lo que propone Clío (prueba con voz del 15 nov, c3): el modelo a veces escribe un subcódigo
 * de otra edición (K04.02 es de la CIE-10-MC de EE. UU.) que la lista de la clínica no tiene, y su
 * padre sí. Nunca cambia de lista: el padre es de la misma. Un padre que es categoría vuelve como tal.
 */
export async function closestDiagnosisCode(tx: Db, system: DiagnosisSystemKey, rawCode: string): Promise<DiagnosisCodeOption | null> {
  const code = normalizeDiagnosisCode(system, rawCode.trim())
  if (!code) return null
  // El código y sus padres, del más largo a la categoría de tres caracteres.
  const parents = Array.from({ length: Math.max(1, code.length - 2) }, (_, cut) => code.slice(0, code.length - cut)).filter((parent) => !parent.endsWith("."))
  const known = await codesIn(tx, system, parents)
  const found = parents.find((parent) => known.has(parent))
  const row = found ? known.get(found) : undefined
  return found && row ? { system, code: found, description: row.title, isCategory: row.isCategory } : null
}

/**
 * Los códigos de la lista cuyo nombre tiene todas esas palabras, sin tildes ni mayúsculas: de ahí
 * sale el hermano que calza con lo dictado (`diagnosisSibling`, prueba con voz del 15 nov, c4b).
 * Pocos: los que nombran lo mismo con el otro calificativo.
 */
export async function diagnosisCodesWith(tx: Db, system: DiagnosisSystemKey, words: readonly string[]): Promise<DiagnosisCodeOption[]> {
  const wanted = words.map((word) => normalizeSearchText(word)).filter((word) => /^[a-z0-9]+$/.test(word))
  if (!wanted.length) return []
  const rows = await tx
    .select({ code: diagnosisCatalog.code, title: diagnosisCatalog.title, isCategory: diagnosisCatalog.isCategory })
    .from(diagnosisCatalog)
    .where(and(eq(diagnosisCatalog.systemKey, system), ...wanted.map((word) => sql`${diagnosisCatalog.searchText} like ${`%${word}%`}`)))
    .orderBy(asc(diagnosisCatalog.code))
    .limit(40)
  return rows.map((row) => ({ system, code: row.code, description: row.title, isCategory: row.isCategory }))
}

export interface DiagnosisCodeInput {
  code: string
  /** Lista del código; sin ella, la de la clínica. */
  system?: string | null
}

/**
 * El código pedido, comprobado en su lista. `newDiagnosis`: es un diagnóstico
 * nuevo de la atención y solo vale la lista de la clínica. `codable`: no se
 * acepta una categoría con subcódigos (regla de codificación de la CIE).
 * `field`: el nombre del dato en el cuerpo; si viene, el rechazo lo nombra
 * (`fields`) para decirse junto a ese campo.
 */
export async function resolveDiagnosisCode(
  tx: Db,
  orgId: string,
  input: DiagnosisCodeInput,
  options: { newDiagnosis?: boolean; codable?: boolean; field?: string } = {},
): Promise<DiagnosisCodeOption> {
  const fail = (message: string) => validation(message, options.field ? { [options.field]: message } : undefined)
  const raw = input.code?.trim()
  if (!raw) throw fail("Elige el diagnóstico")
  const orgSystem = await orgDiagnosisSystem(tx, orgId)
  const requested = input.system?.trim() || orgSystem
  if (!isDiagnosisSystem(requested)) throw fail("Esa lista de diagnósticos no existe")
  if (options.newDiagnosis && requested !== orgSystem)
    throw fail(
      `Los diagnósticos nuevos se eligen en ${listName(orgSystem)}, la de la clínica`,
    )
  const found = await findDiagnosisCode(tx, requested, raw)
  if (!found) throw fail(`El código ${raw.toUpperCase()} no está en ${listName(requested)}`)
  if (options.codable && found.isCategory) {
    // La CIE-10 del MINSA escribe con X la categoría sin subdivisiones («I10X»):
    // si es su único subcódigo, «I10» es ese mismo diagnóstico y se registra así.
    if (requested === "ICD-10-PE") {
      const children = await tx
        .select({ code: diagnosisCatalog.code })
        .from(diagnosisCatalog)
        .where(
          and(
            eq(diagnosisCatalog.systemKey, requested),
            sql`starts_with(${diagnosisCatalog.code}, ${found.code})`,
            ne(diagnosisCatalog.code, found.code),
          ),
        )
        .limit(2)
      const only = children.length === 1 ? children[0]!.code : null
      if (only === `${found.code}.X`) {
        const coded = await findDiagnosisCode(tx, requested, only)
        if (coded) return coded
      }
    }
    const [sub] = await tx
      .select({ code: diagnosisCatalog.code })
      .from(diagnosisCatalog)
      .where(
        and(
          eq(diagnosisCatalog.systemKey, requested),
          sql`starts_with(${diagnosisCatalog.code}, ${found.code})`,
          ne(diagnosisCatalog.code, found.code),
        ),
      )
      .orderBy(asc(diagnosisCatalog.code))
      .limit(1)
    throw fail(
      `${found.code} es una categoría: registra el subcódigo más específico${sub ? ` (p. ej. ${sub.code})` : ""}`,
    )
  }
  return found
}

/**
 * Un código opcional (antecedentes, plan, receta, orden): null si no viene.
 * `field`: el nombre del dato en el cuerpo, para decir el rechazo junto a él.
 */
export async function resolveOptionalDiagnosisCode(
  tx: Db,
  orgId: string,
  input: { code?: string | null; system?: string | null },
  field?: string,
): Promise<
  | { diagnosisSystem: DiagnosisSystemKey; diagnosisCode: string }
  | { diagnosisSystem: null; diagnosisCode: null }
> {
  if (!input.code?.trim()) return { diagnosisSystem: null, diagnosisCode: null }
  const found = await resolveDiagnosisCode(tx, orgId, { code: input.code, system: input.system }, { field })
  return { diagnosisSystem: found.system, diagnosisCode: found.code }
}

/**
 * Buscador de toda la lista de la clínica: ignora tildes y mayúsculas («erupcion»
 * encuentra «erupción»), cada palabra debe aparecer y lo odontológico va primero.
 * Un código exacto o su comienzo («K02», «k021») sube al principio.
 */
export async function searchDiagnosisCodes(
  tx: Db,
  orgId: string,
  q: string,
  limit = 20,
): Promise<DiagnosisCodeOption[]> {
  const system = await orgDiagnosisSystem(tx, orgId)
  // Lo que el producto pone primero (odentIA: lo odontológico).
  const preferred = (await productHooks(tx, orgId)).preferredDiagnoses(system)
  const terms = normalizeSearchText(q).split(" ").filter(Boolean).slice(0, 8)
  if (terms.length === 0) return []
  const code = normalizeDiagnosisCode(system, q.trim())
  // Lo que la clínica ya usa (sus diagnósticos y los antecedentes de sus pacientes), con su
  // categoría: «hipertension» daba primero la hipertensión intracraneal (8D60) por orden de código
  // y la de todos los días quedaba debajo (repaso final de la ficha del 10 nov, B5). Es la misma
  // fuente de «los más usados» (`getDiagnosisSuggestions`); no hay otra lista de uso común.
  const used = sql<number>`(select count(*) from (
      select ${encounterDiagnosis.diagnosisCode} as used_code from ${encounterDiagnosis}
        where ${encounterDiagnosis.organizationId} = ${orgId} and ${encounterDiagnosis.diagnosisSystem} = ${system}
          and ${encounterDiagnosis.voidedAt} is null
      union all
      select ${patientCondition.diagnosisCode} as used_code from ${patientCondition}
        where ${patientCondition.organizationId} = ${orgId} and ${patientCondition.diagnosisSystem} = ${system}
          and ${patientCondition.diagnosisCode} is not null
    ) as clinic_used where starts_with(clinic_used.used_code, ${diagnosisCatalog.code}))`
  const rows = await tx
    .select({
      code: diagnosisCatalog.code,
      title: diagnosisCatalog.title,
      isCategory: diagnosisCatalog.isCategory,
    })
    .from(diagnosisCatalog)
    .where(
      and(
        eq(diagnosisCatalog.systemKey, system),
        ...terms.map(
          (term) =>
            sql`${diagnosisCatalog.searchText} like ${`%${term.replace(/[\\%_]/g, "\\$&")}%`}`,
        ),
      ),
    )
    .orderBy(
      desc(sql`${diagnosisCatalog.code} = ${code}`),
      desc(sql`starts_with(${diagnosisCatalog.code}, ${code})`),
      desc(used),
      // Lo odontológico primero (ADR 0079: lo dice el producto, no la lista).
      desc(preferred ? sql`${diagnosisCatalog.code} ~ ${preferred}` : sql`false`),
      asc(diagnosisCatalog.code),
    )
    .limit(Math.min(Math.max(limit, 1), 50))
  return rows.map((row) => ({
    system,
    code: row.code,
    description: row.title,
    isCategory: row.isCategory,
  }))
}

/**
 * Un diagnóstico propuesto, con lo que lo propone y su sitio como lo dice el
 * producto: un hallazgo de la atención (odentIA: el odontograma), un
 * tratamiento que la atención continúa o una ficha de la atención llenada a
 * mano (odentIA: el diagnóstico pulpar y apical de la de endodoncia).
 */
export type ProposedDiagnosis = DiagnosisCodeOption & {
  /**
   * Qué lo propone: un hallazgo, un tratamiento, una ficha o un diagnóstico que la persona
   * sigue teniendo activo de otra atención («Sigue activo»; solo cuando hoy nada más propone uno).
   */
  source: "hallazgo" | "tratamiento" | "ficha" | "activo"
  /**
   * Lo que lo propone, en palabras: el hallazgo («Lesión de caries dental»),
   * el tratamiento con su pieza («Endodoncia posterior vital · 46») o la
   * respuesta de la ficha («Pulpitis irreversible sintomática»).
   */
  finding: string
  /**
   * El tipo con que se registró la última vez ese código para la persona
   * (FHIR verificationStatus); null si nunca se registró o si lo propone un
   * hallazgo, que es una observación nueva. Lo de una ficha es definitivo:
   * es lo que concluyó quien la llenó.
   */
  diagnosisType: string | null
} & SiteFields

/**
 * Lo que una ficha de la atención dice que es un diagnóstico (estudio de la
 * atención, E10b), esté o no en Diagnóstico: la ficha muestra cada uno con
 * «Usar» o con «Ya está en Diagnóstico».
 */
export type FormProposedDiagnosis = DiagnosisCodeOption & {
  responseId: string
  fieldId: string
  /** La respuesta de la ficha: «Pulpitis irreversible sintomática». */
  term: string
  /** Lo que el término le suma al nombre del código («irreversible sintomática»), o null. */
  qualifier: string | null
  /** Ya hay un diagnóstico vigente con ese código en ese sitio en esta atención. */
  registered: boolean
} & SiteFields

export interface DiagnosisSuggestions {
  system: DiagnosisSystemKey
  /** «CIE-10 (OMS)». */
  systemTitle: string
  proposed: ProposedDiagnosis[]
  mostUsed: DiagnosisCodeOption[]
  /** Lo que dicen las fichas de la atención, con lo ya registrado (vacío sin atención o sin fichas que digan uno). */
  fromForms: FormProposedDiagnosis[]
  /**
   * «Sin enfermedad» (mesa del cierre, 19 nov): los atajos de la visita en la que no hay
   * enfermedad, con el código de la lista de la clínica. Solo con la atención sin diagnóstico,
   * sin hallazgos ni fichas que propongan uno y sin diagnósticos activos de la persona.
   */
  withoutDisease: WithoutDiseaseOption[]
}

/** Un atajo de «Sin enfermedad»: «Chequeo» con Z01.2, que se registra definitivo y no queda activo. */
export interface WithoutDiseaseOption extends DiagnosisCodeOption {
  key: string
  label: string
}

async function codesIn(tx: Db, system: DiagnosisSystemKey, codes: string[]) {
  if (codes.length === 0) return new Map<string, { title: string; isCategory: boolean }>()
  const rows = await tx
    .select({
      code: diagnosisCatalog.code,
      title: diagnosisCatalog.title,
      isCategory: diagnosisCatalog.isCategory,
    })
    .from(diagnosisCatalog)
    .where(
      and(
        eq(diagnosisCatalog.systemKey, system),
        inArray(diagnosisCatalog.code, [...new Set(codes)]),
      ),
    )
  return new Map(rows.map((row) => [row.code, { title: row.title, isCategory: row.isCategory }]))
}

/**
 * Los tratamientos que esta atención continúa y su diagnóstico: los unidos a
 * la atención y el del control reservado con su cita. En una sesión o un
 * control el diagnóstico ya está en el tratamiento: se ofrece, no se registra
 * solo (el clínico lo usa o no). Lo de otra lista no se propone.
 */
async function treatmentCandidates(
  tx: Db,
  orgId: string,
  system: DiagnosisSystemKey,
  patientId: string,
  encounterId: string,
): Promise<DiagnosisCandidate[]> {
  const [visit] = await tx
    .select({ appointmentId: encounter.appointmentId })
    .from(encounter)
    .where(
      and(eq(encounter.id, encounterId), eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId)),
    )
    .limit(1)
  if (!visit) return []
  const joined = tx
    .select({ id: encounterPlanItem.planItemId })
    .from(encounterPlanItem)
    .where(and(eq(encounterPlanItem.organizationId, orgId), eq(encounterPlanItem.encounterId, encounterId)))
  const fromControl = visit.appointmentId
    ? tx
        .select({ id: clinicalFollowUp.planItemId })
        .from(clinicalFollowUp)
        .where(
          and(
            eq(clinicalFollowUp.organizationId, orgId),
            eq(clinicalFollowUp.patientId, patientId),
            eq(clinicalFollowUp.appointmentId, visit.appointmentId),
            isNotNull(clinicalFollowUp.planItemId),
            ne(clinicalFollowUp.status, "cancelado"),
          ),
        )
    : null
  const rows = await tx
    .select({
      title: treatmentPlanItem.title,
      code: treatmentPlanItem.diagnosisCode,
      siteSystem: treatmentPlanItem.siteSystem,
      siteCode: treatmentPlanItem.siteCode,
      siteQualifiers: treatmentPlanItem.siteQualifiers,
    })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.diagnosisSystem, system),
        isNotNull(treatmentPlanItem.diagnosisCode),
        // Lo cancelado o reemplazado ya no se continúa: no propone su diagnóstico.
        notInArray(treatmentPlanItem.status, DROPPED_PLAN_ITEM_STATUSES),
        fromControl
          ? or(inArray(treatmentPlanItem.id, joined), inArray(treatmentPlanItem.id, fromControl))
          : inArray(treatmentPlanItem.id, joined),
      ),
    )
    .orderBy(asc(treatmentPlanItem.sortOrder), asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id))
  const { site } = await productHooks(tx, orgId)
  return rows.flatMap((row) => {
    if (!row.code) return []
    // «Endodoncia posterior vital · 46»: la pieza como la dice el producto (latidIA no tiene).
    const where = site.value(row.siteCode)
    const treatment = where != null ? `${row.title} · ${where}` : row.title
    return [
      {
        code: row.code,
        finding: treatment,
        site: { siteSystem: row.siteSystem, siteCode: row.siteCode, siteQualifiers: row.siteQualifiers },
      },
    ]
  })
}

/** Un código en un sitio (pieza, cuadrante o arcada; sin las caras), como se compara un diagnóstico con otro. */
const placeKey = (code: string, site: { siteSystem: string | null; siteCode: string | null }) =>
  `${code}|${site.siteSystem ?? ""}|${site.siteCode ?? ""}`

/**
 * El tipo con que se registró por última vez cada código en el mismo sitio
 * para la persona, en esa lista (por `placeKey`): el de la 46 no vale para la
 * 36, y sin pieza solo cuentan los registros sin pieza. Lo de una atención
 * anulada no cuenta, como en `wasDiagnosedBefore`.
 */
async function lastTypes(
  tx: Db,
  orgId: string,
  patientId: string,
  system: DiagnosisSystemKey,
  codes: string[],
): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map()
  const rows = await tx
    .selectDistinctOn([encounterDiagnosis.diagnosisCode, encounterDiagnosis.siteSystem, encounterDiagnosis.siteCode], {
      code: encounterDiagnosis.diagnosisCode,
      siteSystem: encounterDiagnosis.siteSystem,
      siteCode: encounterDiagnosis.siteCode,
      type: encounterDiagnosis.diagnosisType,
    })
    .from(encounterDiagnosis)
    .leftJoin(
      encounter,
      and(eq(encounter.id, encounterDiagnosis.encounterId), eq(encounter.organizationId, encounterDiagnosis.organizationId)),
    )
    .where(
      and(
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.patientId, patientId),
        eq(encounterDiagnosis.diagnosisSystem, system),
        inArray(encounterDiagnosis.diagnosisCode, [...new Set(codes)]),
        isNull(encounterDiagnosis.voidedAt),
        isNotNull(encounterDiagnosis.diagnosisType),
        or(isNull(encounter.status), ne(encounter.status, "anulada")),
      ),
    )
    .orderBy(
      encounterDiagnosis.diagnosisCode,
      encounterDiagnosis.siteSystem,
      encounterDiagnosis.siteCode,
      desc(encounterDiagnosis.createdAt),
      desc(encounterDiagnosis.id),
    )
  return new Map(rows.flatMap((row) => (row.type ? [[placeKey(row.code, row), row.type] as const] : [])))
}

/**
 * Los pasos 1 y 2 del diagnóstico (tablero 6): lo que proponen los hallazgos
 * de esta atención (o el hallazgo que se está marcando en la pieza) y los
 * tratamientos que la atención continúa (con el tipo de la última vez), y los
 * códigos que más usa la clínica en su lista. Un código que la lista cargada
 * no trae, que es una categoría o que ya está en la atención, no se propone.
 */
export async function getDiagnosisSuggestions(
  tx: Db,
  orgId: string,
  input: {
    patientId?: string | null
    encounterId?: string | null
    finding?: {
      condition: string
      variant?: string | null
      toothNumber?: number | null
      surfaces?: string[]
    } | null
  } = {},
): Promise<DiagnosisSuggestions> {
  const system = await orgDiagnosisSystem(tx, orgId)
  // Lo que propone lo registrado lo dice el producto (odentIA: los hallazgos del
  // odontograma de esta atención y el que se está marcando en la pieza).
  const hooks = await productHooks(tx, orgId)
  const found = await hooks.diagnosisCandidates(tx, {
    orgId,
    system,
    patientId: input.patientId,
    encounterId: input.encounterId,
    finding: input.finding ?? null,
  })
  // Lo de los tratamientos es común a todos los productos (latidIA también, sin pieza).
  const treatments =
    input.patientId && input.encounterId
      ? await treatmentCandidates(tx, orgId, system, input.patientId, input.encounterId)
      : []
  const types =
    input.patientId && treatments.length > 0
      ? await lastTypes(tx, orgId, input.patientId, system, treatments.map((candidate) => candidate.code))
      : new Map<string, string>()
  // Lo que dicen las fichas de la atención llenadas a mano (odentIA: el diagnóstico pulpar y apical de
  // la de endodoncia, estudio de la atención E10b). Sus códigos son de la CIE-10, como en el dictado:
  // con la CIE-11 no se propone ninguno. Con su pieza; lo que no la tiene se propone sin ella.
  const said =
    input.patientId && input.encounterId && hooks.forms.diagnoses && (system === "ICD-10" || system === "ICD-10-PE")
      ? formDiagnosesOf(
          await tx
            .select({
              id: clinicalFormResponse.id,
              encounterId: clinicalFormResponse.encounterId,
              templateSnapshot: clinicalFormResponse.templateSnapshot,
              answers: clinicalFormResponse.answers,
            })
            .from(clinicalFormResponse)
            .where(
              and(
                eq(clinicalFormResponse.organizationId, orgId),
                eq(clinicalFormResponse.patientId, input.patientId),
                eq(clinicalFormResponse.encounterId, input.encounterId),
                ne(clinicalFormResponse.status, "descartado"),
              ),
            )
            .orderBy(asc(clinicalFormResponse.createdAt), asc(clinicalFormResponse.id)),
          hooks.forms,
        ).flatMap((item) => {
          // Una pieza que el producto no acepta no se propone en ella.
          try {
            return [{ item, site: hooks.site.columns(item.toothNumber === null ? {} : { toothNumber: item.toothNumber }) }]
          } catch {
            return []
          }
        })
      : []
  // Primero lo de los tratamientos: si un hallazgo propone lo mismo en el mismo sitio,
  // queda la propuesta del tratamiento, que trae el tipo de la última vez y se usa desde la tarjeta.
  // Después lo de la ficha, definitivo: es lo que concluyó quien la llenó.
  const candidates = [
    ...treatments.map((candidate) => ({
      ...candidate,
      source: "tratamiento" as const,
      diagnosisType: types.get(placeKey(candidate.code, candidate.site)) ?? null,
    })),
    ...said.map(({ item, site }) => ({ code: item.code, finding: item.term, site, source: "ficha" as const, diagnosisType: "confirmed" })),
    ...found.map((candidate) => ({ ...candidate, source: "hallazgo" as const, diagnosisType: null })),
  ]
  const already = new Set<string>()
  if (input.patientId && input.encounterId) {
    const diagnosed = await tx
      .select({ code: encounterDiagnosis.diagnosisCode, siteSystem: encounterDiagnosis.siteSystem, siteCode: encounterDiagnosis.siteCode })
      .from(encounterDiagnosis)
      .where(
        and(
          eq(encounterDiagnosis.organizationId, orgId),
          eq(encounterDiagnosis.encounterId, input.encounterId),
          eq(encounterDiagnosis.diagnosisSystem, system),
          isNull(encounterDiagnosis.voidedAt),
        ),
      )
    // Con la misma clave con que el alta reconoce un diagnóstico ya registrado (`recordEncounterDiagnosis`).
    for (const row of diagnosed) already.add(placeKey(row.code, row))
  }
  const known = await codesIn(
    tx,
    system,
    candidates.map((candidate) => candidate.code),
  )
  const proposed: ProposedDiagnosis[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const row = known.get(candidate.code)
    const key = placeKey(candidate.code, candidate.site)
    if (!row || row.isCategory || already.has(key) || seen.has(key)) continue
    seen.add(key)
    proposed.push({
      system,
      code: candidate.code,
      description: row.title,
      isCategory: false,
      source: candidate.source,
      finding: candidate.finding,
      diagnosisType: candidate.diagnosisType,
      ...hooks.site.fields(candidate.site),
    })
  }
  // En la ficha, cada uno con «Usar» o con «Ya está en Diagnóstico»: proponer no es registrar.
  const fromForms: FormProposedDiagnosis[] = said.flatMap(({ item, site }) => {
    const row = known.get(item.code)
    if (!row || row.isCategory) return []
    return [
      {
        system,
        code: item.code,
        description: row.title,
        isCategory: false,
        responseId: item.responseId,
        fieldId: item.fieldId,
        term: item.term,
        qualifier: item.qualifier,
        registered: already.has(placeKey(item.code, site)),
        ...hooks.site.fields(site),
      },
    ]
  })
  // «Sin enfermedad» y «Sigue activo»: solo si hoy no se registró ningún diagnóstico y ni un
  // hallazgo ni una ficha proponen uno (lo que propone un tratamiento, como el control, no lo impide).
  let withoutDisease: WithoutDiseaseOption[] = []
  const diseaseToday = proposed.some((item) => item.source === "hallazgo" || item.source === "ficha")
  if (input.patientId && input.encounterId && already.size === 0 && !diseaseToday && !input.finding) {
    const visit = await withoutDiseaseOf(tx, orgId, system, hooks.withoutDisease, input.patientId, input.encounterId)
    for (const active of visit.active) {
      const key = placeKey(active.code, active)
      if (seen.has(key)) continue
      seen.add(key)
      proposed.push({
        system,
        code: active.code,
        description: active.title,
        isCategory: false,
        source: "activo",
        finding: active.title,
        diagnosisType: active.type,
        ...hooks.site.fields(active),
      })
    }
    withoutDisease = visit.active.length > 0 ? [] : visit.options
  }
  const usage = count()
  const used = await tx
    .select({ code: encounterDiagnosis.diagnosisCode, title: diagnosisCatalog.title, uses: usage })
    .from(encounterDiagnosis)
    .innerJoin(
      diagnosisCatalog,
      and(
        eq(diagnosisCatalog.systemKey, encounterDiagnosis.diagnosisSystem),
        eq(diagnosisCatalog.code, encounterDiagnosis.diagnosisCode),
      ),
    )
    .where(
      and(
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.diagnosisSystem, system),
        isNull(encounterDiagnosis.voidedAt),
        eq(diagnosisCatalog.isCategory, false),
      ),
    )
    .groupBy(encounterDiagnosis.diagnosisCode, diagnosisCatalog.title)
    .orderBy(desc(usage), asc(encounterDiagnosis.diagnosisCode))
    .limit(6)
  return {
    system,
    systemTitle: DIAGNOSIS_SYSTEM_INFO[system].title,
    proposed,
    mostUsed: used.map((row) => ({
      system,
      code: row.code,
      description: row.title,
      isCategory: false,
    })),
    fromForms,
    withoutDisease,
  }
}

/** Lo que la persona sigue teniendo activo, de otra atención, sin anular. Hasta 6, lo más reciente primero. */
const ACTIVE_LIMIT = 6

/**
 * Lo que decide «Sin enfermedad» en esta visita: los diagnósticos que la persona sigue teniendo
 * activos (si tiene, se proponen y no sale ningún atajo: un chequeo «sano» con una caries activa
 * sería falso) y, si no, los atajos que le corresponden por su edad y sus tratamientos, con los
 * códigos que la lista de la clínica trae.
 */
async function withoutDiseaseOf(
  tx: Db,
  orgId: string,
  system: DiagnosisSystemKey,
  rules: Parameters<typeof withoutDiseaseOptions>[0],
  patientId: string,
  encounterId: string,
): Promise<{
  active: Array<{ code: string; title: string; type: string | null; siteSystem: string | null; siteCode: string | null; siteQualifiers: string[] }>
  options: WithoutDiseaseOption[]
}> {
  const active = await tx.execute<{
    code: string
    title: string
    type: string | null
    site_system: string | null
    site_code: string | null
    site_qualifiers: string[] | null
  }>(sql`
    select distinct on (d.diagnosis_code, d.site_system, d.site_code)
      d.diagnosis_code as code, c.title, d.diagnosis_type as type,
      d.site_system, d.site_code, d.site_qualifiers
    from encounter_diagnosis d
    join diagnosis_code c on c.system_key = d.diagnosis_system and c.code = d.diagnosis_code
    left join encounter e on e.organization_id = d.organization_id and e.id = d.encounter_id
    where d.organization_id = ${orgId} and d.patient_id = ${patientId}
      and d.diagnosis_system = ${system} and d.status = 'activo' and d.voided_at is null
      and (d.encounter_id is null or d.encounter_id <> ${encounterId})
      and (e.status is null or e.status <> 'anulada')
    order by d.diagnosis_code, d.site_system, d.site_code, d.created_at desc`)
  if (active.length > 0)
    return {
      active: active.slice(0, ACTIVE_LIMIT).map((row) => ({
        code: row.code,
        title: row.title,
        type: row.type,
        siteSystem: row.site_system,
        siteCode: row.site_code,
        siteQualifiers: row.site_qualifiers ?? [],
      })),
      options: [],
    }
  if (rules.length === 0) return { active: [], options: [] }
  const [facts] = await tx.execute<{
    birth_date: string | null
    visit_day: string
    treated: boolean
    protesis: boolean
    ortodoncia: boolean
  }>(sql`
    select person.birth_date::text as birth_date,
      to_char(e.started_at, 'YYYY-MM-DD') as visit_day,
      (exists (
        select 1 from treatment_plan_item t
        where t.organization_id = ${orgId} and t.patient_id = ${patientId} and t.status = 'realizado'
      ) or exists (
        select 1 from clinical_follow_up f
        where f.organization_id = ${orgId} and f.patient_id = ${patientId} and f.status <> 'cancelado'
      )) as treated,
      exists (${specialtyPlanItem(orgId, patientId, ["protesis", "implantologia"])}) as protesis,
      exists (${specialtyPlanItem(orgId, patientId, ["ortodoncia"])}) as ortodoncia
    from encounter e
    join patient p on p.organization_id = e.organization_id and p.id = e.patient_id
    join contact person on person.organization_id = p.organization_id and person.id = p.person_id
    where e.organization_id = ${orgId} and e.id = ${encounterId} and e.patient_id = ${patientId}`)
  if (!facts) return { active: [], options: [] }
  const wanted = withoutDiseaseOptions(rules, {
    system,
    ageYears: ageInYears(facts.birth_date, facts.visit_day),
    treated: facts.treated,
    protesis: facts.protesis,
    ortodoncia: facts.ortodoncia,
  })
  // Solo lo que la lista de la clínica trae, y no una categoría: el botón registraría un código que no existe.
  const known = await codesIn(
    tx,
    system,
    wanted.map((option) => option.code),
  )
  return {
    active: [],
    options: wanted.flatMap((option) => {
      const row = known.get(option.code)
      if (!row || row.isCategory) return []
      return [{ system, code: option.code, description: row.title, isCategory: false, key: option.key, label: option.label }]
    }),
  }
}

/** Un tratamiento vigente de la persona cuyo servicio es de esas especialidades (biblioteca o la de la clínica). */
function specialtyPlanItem(orgId: string, patientId: string, kinds: string[]) {
  return sql`
    select 1 from treatment_plan_item t
    join service_catalog s on s.organization_id = t.organization_id and s.id = t.service_id
    left join catalog.treatment_template tt on tt.id = s.template_id
    left join org_specialty os on os.organization_id = s.organization_id and os.id = s.specialty_id
    where t.organization_id = ${orgId} and t.patient_id = ${patientId}
      and t.status not in ('cancelado', 'reemplazado')
      and coalesce(tt.specialty, os.key) in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})`
}

/**
 * «Ya diagnosticado antes» (decisión 11): la persona ya tenía este código, en
 * la misma lista, en otra atención que no se anuló. Un código de otra lista
 * nunca cuenta, aunque nombre lo mismo.
 */
export async function wasDiagnosedBefore(
  tx: Db,
  orgId: string,
  patientId: string,
  diagnosis: { system: DiagnosisSystemKey; code: string },
  encounterId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: encounterDiagnosis.id })
    .from(encounterDiagnosis)
    .leftJoin(
      encounter,
      and(
        eq(encounter.id, encounterDiagnosis.encounterId),
        eq(encounter.organizationId, encounterDiagnosis.organizationId),
      ),
    )
    .where(
      and(
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.patientId, patientId),
        eq(encounterDiagnosis.diagnosisSystem, diagnosis.system),
        eq(encounterDiagnosis.diagnosisCode, diagnosis.code),
        isNull(encounterDiagnosis.voidedAt),
        or(isNull(encounterDiagnosis.encounterId), ne(encounterDiagnosis.encounterId, encounterId)),
        or(isNull(encounter.status), ne(encounter.status, "anulada")),
      ),
    )
    .limit(1)
  return Boolean(row)
}

/**
 * Cambia la lista de la clínica. Desde ahora los diagnósticos nuevos se eligen
 * en ella; nada de lo registrado se reescribe. Se puede volver atrás y cada
 * cambio queda en la actividad de la clínica.
 */
export async function setOrgDiagnosisSystem(
  tx: Db,
  orgId: string,
  actorUserId: string,
  system: string,
): Promise<{ diagnosisSystem: SelectableDiagnosisSystem }> {
  if (!isSelectableDiagnosisSystem(system))
    throw validation("Elige la CIE-10 del MINSA, la CIE-10 de la OMS o la CIE-11")
  const [current] = await tx
    .select({ system: orgProfile.diagnosisSystem })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .for("update")
    .limit(1)
  if (!current) throw notFound("Perfil de organización")
  const from = await orgDiagnosisSystem(tx, orgId)
  if (from === system && current.system === system) return { diagnosisSystem: system }
  await tx
    .update(orgProfile)
    .set({ diagnosisSystem: system, updatedAt: new Date() })
    .where(eq(orgProfile.organizationId, orgId))
  if (from !== system)
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "settings.diagnosis_system_changed",
      entity: "org_profile",
      entityId: orgId,
      metadata: { from, to: system },
    })
  return { diagnosisSystem: system }
}

// El agente no depende de @odentia/clinical: recibe de aquí lo que necesita para el dictado de práctica.
export { type DiagnosisSystemKey, findingDiagnosisCode } from "@odentia/clinical"

/**
 * El nombre del catálogo de cada diagnóstico codificado, por lista y código
 * («Pulpitis»): la historia y el Resumen lo dicen con su nombre, no solo con el
 * código (QA de la ficha del 8 nov). Lo que el catálogo no trae queda sin nombre.
 */
export async function diagnosisTitlesOf(
  tx: Db,
  coded: ReadonlyArray<{ system: string | null | undefined; code: string | null | undefined }>,
): Promise<Map<string, string>> {
  const codes = [...new Set(coded.flatMap((row) => (row.code ? [row.code] : [])))]
  if (codes.length === 0) return new Map()
  const rows = await tx
    .select({ system: diagnosisCatalog.systemKey, code: diagnosisCatalog.code, title: diagnosisCatalog.title })
    .from(diagnosisCatalog)
    .where(inArray(diagnosisCatalog.code, codes))
  return new Map(rows.map((row) => [`${row.system}|${row.code}`, row.title]))
}

/** «Pulpitis (CIE-11 DA09.0)»: el nombre con su código; sin nombre en el catálogo, solo el código. */
export function namedDiagnosis(
  titles: ReadonlyMap<string, string>,
  system: string | null | undefined,
  code: string,
): string {
  const label = diagnosisCodeLabel(system, code)
  const title = titles.get(`${system}|${code}`)
  return title ? `${title} (${label.replace(" · ", " ")})` : label
}
