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
  type DiagnosisSystemKey,
  findingDiagnosisCode,
  isDiagnosisSystem,
  isSelectableDiagnosisSystem,
  normalizeDiagnosisCode,
  normalizeSearchText,
  type SelectableDiagnosisSystem,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { diagnosisCatalog, encounter, encounterDiagnosis } from "@odentia/db/schema/clinical"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { notFound, validation } from "./errors.js"
import type { SiteFields } from "./product-hooks.js"
import { productHooks } from "./products.js"

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

export interface DiagnosisCodeInput {
  code: string
  /** Lista del código; sin ella, la de la clínica. */
  system?: string | null
}

/**
 * El código pedido, comprobado en su lista. `newDiagnosis`: es un diagnóstico
 * nuevo de la atención y solo vale la lista de la clínica. `codable`: no se
 * acepta una categoría con subcódigos (regla de codificación de la CIE).
 */
export async function resolveDiagnosisCode(
  tx: Db,
  orgId: string,
  input: DiagnosisCodeInput,
  options: { newDiagnosis?: boolean; codable?: boolean } = {},
): Promise<DiagnosisCodeOption> {
  const raw = input.code?.trim()
  if (!raw) throw validation("Elige el diagnóstico")
  const orgSystem = await orgDiagnosisSystem(tx, orgId)
  const requested = input.system?.trim() || orgSystem
  if (!isDiagnosisSystem(requested)) throw validation("Esa lista de diagnósticos no existe")
  if (options.newDiagnosis && requested !== orgSystem)
    throw validation(
      `Los diagnósticos nuevos se eligen en ${listName(orgSystem)}, la de la clínica`,
    )
  const found = await findDiagnosisCode(tx, requested, raw)
  if (!found) throw validation(`El código ${raw.toUpperCase()} no está en ${listName(requested)}`)
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
    throw validation(
      `${found.code} es una categoría: registra el subcódigo más específico${sub ? ` (p. ej. ${sub.code})` : ""}`,
    )
  }
  return found
}

/** Un código opcional (antecedentes, plan, receta, orden): null si no viene. */
export async function resolveOptionalDiagnosisCode(
  tx: Db,
  orgId: string,
  input: { code?: string | null; system?: string | null },
): Promise<
  | { diagnosisSystem: DiagnosisSystemKey; diagnosisCode: string }
  | { diagnosisSystem: null; diagnosisCode: null }
> {
  if (!input.code?.trim()) return { diagnosisSystem: null, diagnosisCode: null }
  const found = await resolveDiagnosisCode(tx, orgId, { code: input.code, system: input.system })
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

/** Lo que el odontograma propone: un código por hallazgo, en la lista de la clínica. */
/** Un diagnóstico propuesto, con lo que lo propone y su sitio como lo dice el producto. */
export type ProposedDiagnosis = DiagnosisCodeOption & {
  /** «Lesión de caries dental»: el hallazgo que lo propone. */
  finding: string
} & SiteFields

export interface DiagnosisSuggestions {
  system: DiagnosisSystemKey
  /** «CIE-10 (OMS)». */
  systemTitle: string
  proposed: ProposedDiagnosis[]
  mostUsed: DiagnosisCodeOption[]
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
 * Los pasos 1 y 2 del diagnóstico (tablero 6): lo que proponen los hallazgos
 * de esta atención (o el hallazgo que se está marcando en la pieza) y los
 * códigos que más usa la clínica en su lista. Un código que la lista cargada
 * no trae, o que es una categoría, no se propone.
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
  const candidates = await hooks.diagnosisCandidates(tx, {
    orgId,
    system,
    patientId: input.patientId,
    encounterId: input.encounterId,
    finding: input.finding ?? null,
  })
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
    for (const row of diagnosed) already.add(`${row.code}|${row.siteSystem ?? ""}|${row.siteCode ?? ""}`)
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
    const key = `${candidate.code}|${candidate.site.siteSystem ?? ""}|${candidate.site.siteCode ?? ""}`
    if (!row || row.isCategory || already.has(key) || seen.has(key)) continue
    seen.add(key)
    proposed.push({
      system,
      code: candidate.code,
      description: row.title,
      isCategory: false,
      finding: candidate.finding,
      ...hooks.site.fields(candidate.site),
    })
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
  }
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
