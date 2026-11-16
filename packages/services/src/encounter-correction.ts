/**
 * Lo que nace junto se corrige junto (QA del 16 nov, E2). El odontólogo marca una caries con
 * su diagnóstico y su endodoncia en la 47, y era la 46: anular el hallazgo trae, marcados, su
 * diagnóstico de esta atención y lo indicado hoy desde él, con un solo motivo y en una sola
 * transacción: nunca queda uno anulado y el otro no. Desde Diagnóstico, al revés: el
 * diagnóstico trae su hallazgo.
 *
 * El vínculo es el del producto (odentIA: `dental.diagnosis_finding` y
 * `dental.plan_item_finding`), no la pieza: dos caries de la misma pieza comparten un
 * diagnóstico, que sigue vigente mientras la otra lo use. Lo que ya tiene respuesta, lo hecho y
 * el consentimiento firmado no se deshacen aquí: la vista previa lo dice. La pieza sale de las
 * piezas de la atención si ya no le queda nada en ella.
 */
import type { Db } from "@odentia/db"
import {
  encounterDiagnosis,
  encounterPlanItem,
  encounterProcedure,
  encounterSite,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { consentDocument } from "@odentia/db/schema/clinical-forms"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, inArray, isNull, ne, notInArray } from "drizzle-orm"
import type { BudgetActorOpts } from "./budgets.js"
import { diagnosisTitlesOf } from "./diagnosis-codes.js"
import { voidEncounterDiagnosis } from "./encounter-diagnoses.js"
import { removableFromEncounter, removeIndicatedFromEncounter } from "./encounter-plan-remove.js"
import { invalidField, notFound, ServiceError } from "./errors.js"
import { requirePatient } from "./patients.js"
import { lockDraftEncounter } from "./plan.js"
import type { CorrectionFinding } from "./product-hooks.js"
import { productHooks } from "./products.js"

/** Desde dónde se corrige: un hallazgo (sus filas) o un diagnóstico de esta atención. */
export type CorrectionStart = { findingIds: string[] } | { diagnosisId: string }

/** Algo que cae con lo que se anula: marcado si se puede; si no, `note` dice por qué no. */
export interface CorrectionChoice {
  /** Un hallazgo son sus filas (las caras de una caries): todas van juntas. */
  ids: string[]
  label: string
  offered: boolean
  note: string | null
}

export interface CorrectionPreview {
  /** Lo que se pidió anular. */
  target: { kind: "finding" | "diagnosis"; ids: string[]; label: string }
  /** Desde un diagnóstico: su hallazgo. */
  findings: CorrectionChoice[]
  /** Desde un hallazgo: su diagnóstico de esta atención. */
  diagnoses: CorrectionChoice[]
  /** Lo indicado hoy desde ese hallazgo. */
  planItems: CorrectionChoice[]
  /** Lo que ya no se deshace aquí: el consentimiento firmado y lo hecho hoy. */
  notices: string[]
}

export interface CorrectionInput {
  reason: string
  /** Desde un diagnóstico: las filas de los hallazgos que caen con él. */
  findingIds?: string[]
  /** Desde un hallazgo: los diagnósticos que caen con él. */
  diagnosisIds?: string[]
  planItemIds?: string[]
}

const conflict = (code: string, message: string): ServiceError => new ServiceError(code, 409, message)

/** Los hallazgos agrupados como se ven: uno por grupo, con todas sus filas. */
function grouped(findings: readonly CorrectionFinding[]): Array<CorrectionFinding & { ids: string[] }> {
  const out = new Map<string, CorrectionFinding & { ids: string[] }>()
  for (const finding of findings) {
    const seen = out.get(finding.group)
    if (seen) {
      seen.ids.push(finding.id)
      seen.diagnosisIds = [...new Set([...seen.diagnosisIds, ...finding.diagnosisIds])]
      seen.planItemIds = [...new Set([...seen.planItemIds, ...finding.planItemIds])]
    } else out.set(finding.group, { ...finding, ids: [finding.id] })
  }
  return [...out.values()]
}

/** Lo que cae con un hallazgo o un diagnóstico de esta atención, calculado en el servidor. */
async function computePreview(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  start: CorrectionStart,
): Promise<CorrectionPreview> {
  const hooks = await productHooks(tx, orgId)
  const findings = grouped(hooks.correction ? await hooks.correction.findings(tx, { orgId, patientId, encounterId }) : [])
  const diagnoses = await tx
    .select()
    .from(encounterDiagnosis)
    .where(
      and(
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.patientId, patientId),
        eq(encounterDiagnosis.encounterId, encounterId),
        isNull(encounterDiagnosis.voidedAt),
      ),
    )
  const titles = await diagnosisTitlesOf(
    tx,
    diagnoses.map((row) => ({ system: row.diagnosisSystem, code: row.diagnosisCode })),
  )
  // «K04.0 Pulpitis · 36»: el código, su nombre y la pieza, como lo dice la Historia.
  const diagnosisLabel = (row: (typeof diagnoses)[number]) =>
    [row.diagnosisCode, titles.get(`${row.diagnosisSystem}|${row.diagnosisCode}`) ?? null].filter(Boolean).join(" ") +
    (row.siteCode ? ` · ${row.siteCode}` : "")
  const byDiagnosis = new Map(diagnoses.map((row) => [row.id, row]))

  let target: CorrectionPreview["target"]
  const findingChoices: CorrectionChoice[] = []
  const diagnosisChoices: CorrectionChoice[] = []
  let sources: Array<CorrectionFinding & { ids: string[] }> = []
  if ("findingIds" in start) {
    const asked = new Set(start.findingIds)
    sources = findings.filter((finding) => finding.ids.some((id) => asked.has(id)))
    const found = new Set(sources.flatMap((finding) => finding.ids))
    if (sources.length === 0 || start.findingIds.some((id) => !found.has(id)))
      throw conflict("ALREADY_VOIDED", "Ese hallazgo ya está anulado o no es de esta atención")
    target = { kind: "finding", ids: [...found], label: sources.map((finding) => finding.label).join(", ") }
    const others = findings.filter((finding) => !sources.includes(finding))
    for (const id of new Set(sources.flatMap((finding) => finding.diagnosisIds))) {
      const row = byDiagnosis.get(id)
      if (!row) continue
      const user = others.find((finding) => finding.diagnosisIds.includes(id))
      diagnosisChoices.push({
        ids: [id],
        label: diagnosisLabel(row),
        offered: !user,
        note: user ? `Sigue: lo usa ${user.label}` : null,
      })
    }
  } else {
    const row = byDiagnosis.get(start.diagnosisId)
    if (!row) throw conflict("ALREADY_VOIDED", "Ese diagnóstico ya está anulado o no es de esta atención")
    target = { kind: "diagnosis", ids: [row.id], label: diagnosisLabel(row) }
    for (const finding of findings.filter((candidate) => candidate.diagnosisIds.includes(row.id))) {
      const other = finding.diagnosisIds.find((id) => id !== row.id && byDiagnosis.has(id))
      findingChoices.push({
        ids: finding.ids,
        label: finding.label,
        offered: !other,
        note: other ? `Sigue: es también de ${diagnosisLabel(byDiagnosis.get(other)!)}` : null,
      })
      if (!other) sources.push(finding)
    }
  }

  // Lo indicado hoy desde esos hallazgos: se quita si nadie respondió y su presupuesto sigue en borrador.
  const itemIds = [...new Set(sources.flatMap((finding) => finding.planItemIds))]
  const items =
    itemIds.length === 0
      ? []
      : await tx
          .select()
          .from(treatmentPlanItem)
          .where(
            and(
              eq(treatmentPlanItem.organizationId, orgId),
              eq(treatmentPlanItem.patientId, patientId),
              inArray(treatmentPlanItem.id, itemIds),
              eq(treatmentPlanItem.sourceEncounterId, encounterId),
              notInArray(treatmentPlanItem.status, ["cancelado", "reemplazado"]),
            ),
          )
  const removable = items.length > 0 ? await removableFromEncounter(tx, orgId, encounterId, actorUserId) : new Set<string>()
  const site = hooks.site
  const itemLabel = (item: (typeof items)[number]) =>
    [item.title, site.words(item, "short")].filter(Boolean).join(" · ")
  const planChoices: CorrectionChoice[] = items.map((item) => ({
    ids: [item.id],
    label: itemLabel(item),
    offered: removable.has(item.id),
    note: removable.has(item.id)
      ? null
      : item.status === "pendiente"
        ? "Ya tiene respuesta o su presupuesto se entregó: cámbialo en el Plan"
        : "Ya empezó: no se quita aquí",
  }))

  // Lo que no se deshace: el consentimiento firmado y lo registrado como hecho hoy.
  const notices: string[] = []
  if (items.length > 0) {
    const signed = await tx
      .select({ title: consentDocument.titleSnapshot })
      .from(consentDocument)
      .where(
        and(
          eq(consentDocument.organizationId, orgId),
          inArray(
            consentDocument.planItemId,
            items.map((item) => item.id),
          ),
          eq(consentDocument.status, "firmado"),
        ),
      )
    for (const title of new Set(signed.map((row) => row.title)))
      notices.push(`El consentimiento «${title}» ya está firmado y no se deshace: si no corresponde, revócalo aparte.`)
    const done = await tx
      .select({ description: encounterProcedure.description })
      .from(encounterProcedure)
      .where(
        and(
          eq(encounterProcedure.organizationId, orgId),
          eq(encounterProcedure.encounterId, encounterId),
          inArray(
            encounterProcedure.planItemId,
            items.map((item) => item.id),
          ),
          isNull(encounterProcedure.voidedAt),
        ),
      )
    for (const description of new Set(done.map((row) => row.description)))
      notices.push(`«${description}» ya se registró como hecho hoy y no se deshace: si no se hizo, anúlalo en «Hecho hoy».`)
  }
  return { target, findings: findingChoices, diagnoses: diagnosisChoices, planItems: planChoices, notices }
}

/** La vista previa: qué cae con lo que se anula, sin efectos. Solo quien lleva la atención. */
export async function getCorrectionPreview(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  start: CorrectionStart,
): Promise<CorrectionPreview> {
  await requirePatient(tx, orgId, patientId)
  await lockDraftEncounter(tx, orgId, patientId, encounterId, actorUserId)
  return computePreview(tx, orgId, actorUserId, patientId, encounterId, start)
}

/**
 * Anula lo pedido y lo marcado de la vista previa, con un solo motivo y en la transacción de
 * quien llama. La vista previa se vuelve a calcular aquí: un id que no está marcable en ella se
 * rechaza, sin confiar en lo que mande la pantalla.
 */
export async function voidWithCorrection(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  start: CorrectionStart,
  input: CorrectionInput,
  opts: BudgetActorOpts = {},
): Promise<{ findings: number; diagnoses: number; planItems: number; sitesLeft: string[] }> {
  await requirePatient(tx, orgId, patientId)
  await lockDraftEncounter(tx, orgId, patientId, encounterId, actorUserId)
  const reason = input.reason?.trim() ?? ""
  if (!reason || reason.length > 2000)
    throw invalidField("reason", "Escribe el motivo de la anulación (hasta 2000 caracteres).")
  const preview = await computePreview(tx, orgId, actorUserId, patientId, encounterId, start)
  const allowed = (choices: CorrectionChoice[]) => new Set(choices.filter((choice) => choice.offered).flatMap((choice) => choice.ids))
  const pick = (asked: string[] | undefined, choices: CorrectionChoice[]) => {
    const ok = allowed(choices)
    const ids = [...new Set(asked ?? [])]
    if (ids.some((id) => !ok.has(id)))
      throw conflict("CORRECTION_CHANGED", "Lo que cae con esta anulación cambió: vuelve a abrirla")
    return ids
  }
  const findingIds = pick(input.findingIds, preview.findings)
  const diagnosisIds = pick(input.diagnosisIds, preview.diagnoses)
  const planItemIds = pick(input.planItemIds, preview.planItems)
  // Un hallazgo cae entero, con todas sus caras.
  for (const choice of preview.findings)
    if (choice.ids.some((id) => findingIds.includes(id)) && choice.ids.some((id) => !findingIds.includes(id)))
      throw conflict("CORRECTION_CHANGED", "Lo que cae con esta anulación cambió: vuelve a abrirla")

  const hooks = await productHooks(tx, orgId)
  const sitesBefore = await sitesOf(tx, orgId, patientId, encounterId, hooks, {
    findingIds: preview.target.kind === "finding" ? preview.target.ids : findingIds,
    diagnosisIds: preview.target.kind === "diagnosis" ? preview.target.ids : diagnosisIds,
    planItemIds,
  })
  const moment = { orgId, actorUserId, patientId, encounterId }
  const voidFindings = preview.target.kind === "finding" ? preview.target.ids : findingIds
  if (voidFindings.length > 0) {
    if (!hooks.correction) throw notFound("Hallazgo")
    await hooks.correction.voidFindings(tx, { ...moment, ids: voidFindings, reason })
  }
  const voidDiagnoses = preview.target.kind === "diagnosis" ? preview.target.ids : diagnosisIds
  for (const id of voidDiagnoses)
    await voidEncounterDiagnosis(tx, orgId, actorUserId, patientId, encounterId, id, { reason })
  for (const id of planItemIds)
    await removeIndicatedFromEncounter(tx, orgId, actorUserId, patientId, encounterId, id, opts)

  // La pieza sale de las piezas de la atención si ya no le queda nada en ella.
  const sitesLeft: string[] = []
  for (const site of sitesBefore) {
    if (await siteStillUsed(tx, orgId, patientId, encounterId, hooks, site)) continue
    await tx
      .delete(encounterSite)
      .where(
        and(
          eq(encounterSite.organizationId, orgId),
          eq(encounterSite.encounterId, encounterId),
          eq(encounterSite.siteSystem, site.system),
          eq(encounterSite.siteCode, site.code),
        ),
      )
    sitesLeft.push(site.code)
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "encounter.corrected",
    entity: "encounter",
    entityId: encounterId,
    metadata: {
      patientId,
      reason,
      from: preview.target.kind,
      findings: voidFindings.length,
      diagnoses: voidDiagnoses.length,
      planItemIds,
      sitesLeft,
    },
  })
  return { findings: voidFindings.length, diagnoses: voidDiagnoses.length, planItems: planItemIds.length, sitesLeft }
}

type Site = { system: string; code: string }

/** Las piezas (los sitios) de lo que se va a anular. */
async function sitesOf(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
  hooks: Awaited<ReturnType<typeof productHooks>>,
  scope: { findingIds: string[]; diagnosisIds: string[]; planItemIds: string[] },
): Promise<Site[]> {
  const out = new Map<string, Site>()
  const add = (system: string | null, code: string | null) => {
    if (system && code) out.set(`${system}|${code}`, { system, code })
  }
  if (scope.findingIds.length > 0 && hooks.correction) {
    for (const finding of await hooks.correction.findings(tx, { orgId, patientId, encounterId }))
      if (scope.findingIds.includes(finding.id)) add(finding.siteSystem, finding.siteCode)
  }
  if (scope.diagnosisIds.length > 0) {
    const rows = await tx
      .select({ system: encounterDiagnosis.siteSystem, code: encounterDiagnosis.siteCode })
      .from(encounterDiagnosis)
      .where(and(eq(encounterDiagnosis.organizationId, orgId), inArray(encounterDiagnosis.id, scope.diagnosisIds)))
    for (const row of rows) add(row.system, row.code)
  }
  if (scope.planItemIds.length > 0) {
    const rows = await tx
      .select({ system: treatmentPlanItem.siteSystem, code: treatmentPlanItem.siteCode })
      .from(treatmentPlanItem)
      .where(and(eq(treatmentPlanItem.organizationId, orgId), inArray(treatmentPlanItem.id, scope.planItemIds)))
    for (const row of rows) add(row.system, row.code)
  }
  return [...out.values()]
}

/**
 * Si a la pieza le queda algo en esta atención: un hallazgo, un diagnóstico, un procedimiento,
 * algo indicado hoy o un tratamiento traído a ella. Si no, deja de ser pieza de la atención.
 */
async function siteStillUsed(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
  hooks: Awaited<ReturnType<typeof productHooks>>,
  site: Site,
): Promise<boolean> {
  if (hooks.correction) {
    const findings = await hooks.correction.findings(tx, { orgId, patientId, encounterId })
    if (findings.some((finding) => finding.siteSystem === site.system && finding.siteCode === site.code)) return true
  }
  const [diagnosis] = await tx
    .select({ id: encounterDiagnosis.id })
    .from(encounterDiagnosis)
    .where(
      and(
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.encounterId, encounterId),
        isNull(encounterDiagnosis.voidedAt),
        eq(encounterDiagnosis.siteSystem, site.system),
        eq(encounterDiagnosis.siteCode, site.code),
      ),
    )
    .limit(1)
  if (diagnosis) return true
  const [procedure] = await tx
    .select({ id: encounterProcedure.id })
    .from(encounterProcedure)
    .where(
      and(
        eq(encounterProcedure.organizationId, orgId),
        eq(encounterProcedure.encounterId, encounterId),
        isNull(encounterProcedure.voidedAt),
        eq(encounterProcedure.siteSystem, site.system),
        eq(encounterProcedure.siteCode, site.code),
      ),
    )
    .limit(1)
  if (procedure) return true
  const [indicated] = await tx
    .select({ id: treatmentPlanItem.id })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.sourceEncounterId, encounterId),
        ne(treatmentPlanItem.status, "cancelado"),
        eq(treatmentPlanItem.siteSystem, site.system),
        eq(treatmentPlanItem.siteCode, site.code),
      ),
    )
    .limit(1)
  if (indicated) return true
  const [brought] = await tx
    .select({ id: treatmentPlanItem.id })
    .from(encounterPlanItem)
    .innerJoin(
      treatmentPlanItem,
      and(
        eq(treatmentPlanItem.organizationId, encounterPlanItem.organizationId),
        eq(treatmentPlanItem.id, encounterPlanItem.planItemId),
      ),
    )
    .where(
      and(
        eq(encounterPlanItem.organizationId, orgId),
        eq(encounterPlanItem.encounterId, encounterId),
        eq(treatmentPlanItem.siteSystem, site.system),
        eq(treatmentPlanItem.siteCode, site.code),
      ),
    )
    .limit(1)
  return Boolean(brought)
}
