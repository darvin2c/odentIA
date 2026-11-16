/**
 * La anestesia de la atención (QA del 16 nov, E5b y E5c): qué de hoy la usa y, al firmar, la foto
 * que guarda la atención (auditor, 16 nov, H5): con qué ASA, quién la puso, qué peso y qué máximo.
 * Sale de datos clínicos: el servicio («Usa anestesia local», de la biblioteca o de la clínica) y,
 * como antes, los anestésicos de sus materiales. Avisa y no frena (ADR 0195).
 */
import {
  type AnesthesiaAtSigning,
  ageInYears,
  isCardiacCondition,
  isSevereAsa,
  localAnesthesiaWords,
  localAnestheticOf,
  type Vitals,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { patient, patientCondition } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq, sql } from "drizzle-orm"
import { localAnesthesiaSql } from "./service-catalog.js"

/**
 * Lo de hoy que usa anestesia local, por su servicio: lo traído a esta atención («Hacerla hoy»,
 * «Continuar») y lo registrado hoy sin anular. Sin repetir el nombre.
 */
export async function anesthesiaUsesOf(
  tx: Db,
  orgId: string,
  encounterId: string,
): Promise<string[]> {
  const rows = await tx.execute<{ title: string }>(sql`
    select distinct today.title from (
      select tpi.title, tpi.service_id, tpi.created_at as at from encounter_plan_item epi
      join treatment_plan_item tpi on tpi.organization_id = epi.organization_id and tpi.id = epi.plan_item_id
      where epi.organization_id = ${orgId} and epi.encounter_id = ${encounterId}
        and tpi.status not in ('cancelado', 'reemplazado')
      union all
      select ep.description, ep.service_id, ep.created_at from encounter_procedure ep
      where ep.organization_id = ${orgId} and ep.encounter_id = ${encounterId} and ep.voided_at is null
    ) today
    join "service_catalog" on "service_catalog"."organization_id" = ${orgId} and "service_catalog"."id" = today.service_id
    where ${localAnesthesiaSql}`)
  return rows.map((row) => row.title)
}

/**
 * La foto al firmar, o nula si nada de hoy usaba anestesia. `anesthetic`: el que se eligió en la
 * línea para el cálculo (no es un dato clínico nuevo: solo dice con qué se calculó el máximo).
 */
export async function anesthesiaAtSigningOf(
  tx: Db,
  orgId: string,
  input: {
    patientId: string
    encounterId: string
    uses: readonly string[]
    vitals: Vitals | null
    birthDate: string | null
    today: string
    anesthetic: string | null | undefined
    asksAsa: boolean
  },
): Promise<AnesthesiaAtSigning | null> {
  if (input.uses.length === 0) return null
  const [header] = await tx
    .select({ asaClass: patient.asaClass, setAt: patient.asaClassSetAt, setBy: user.name })
    .from(patient)
    .leftJoin(user, eq(user.id, patient.asaClassSetBy))
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, input.patientId)))
    .limit(1)
  const asaClass = input.asksAsa ? (header?.asaClass ?? null) : null
  // La de antes, si se clasificó en esta atención: la primera vez que se tocó aquí.
  const [first] = input.asksAsa
    ? await tx
        .select({ metadata: auditEvent.metadata })
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.organizationId, orgId),
            eq(auditEvent.entity, "patient"),
            eq(auditEvent.entityId, input.patientId),
            eq(auditEvent.action, "patient.asa_classified"),
            sql`${auditEvent.metadata}->>'encounterId' = ${input.encounterId}`,
          ),
        )
        .orderBy(asc(auditEvent.createdAt))
        .limit(1)
    : []
  const conditions = await tx
    .select({ system: patientCondition.diagnosisSystem, code: patientCondition.diagnosisCode })
    .from(patientCondition)
    .where(
      and(
        eq(patientCondition.organizationId, orgId),
        eq(patientCondition.patientId, input.patientId),
        eq(patientCondition.status, "activa"),
      ),
    )
  const cardiac =
    isSevereAsa(header?.asaClass) ||
    conditions.some((row) => isCardiacCondition(row.system, row.code))
  const anesthetic = localAnestheticOf(input.anesthetic)
  const weightKg = input.vitals?.peso ?? null
  const words = anesthetic
    ? localAnesthesiaWords({
        weightKg,
        anesthetic: anesthetic.key,
        ageYears: ageInYears(input.birthDate, input.today),
        cardiac,
      })
    : { dose: null, warnings: [] }
  return {
    uses: [...input.uses],
    asaClass,
    ...(first
      ? { asaBefore: (first.metadata as { before?: string | null } | null)?.before ?? null }
      : {}),
    asaSetBy: asaClass ? (header?.setBy ?? null) : null,
    asaSetAt: asaClass ? (header?.setAt?.toISOString() ?? null) : null,
    weightKg,
    anesthetic: anesthetic?.label ?? null,
    dose: words.dose,
    warnings: words.warnings,
  }
}
