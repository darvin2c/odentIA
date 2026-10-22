import { randomUUID } from "node:crypto"
import { type DiagnosisSystemKey, diagnosisSearchText } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import {
  diagnosisCatalog,
  diagnosisCodeRelease,
  encounter,
  serviceCatalog,
  treatmentPlan,
} from "@odentia/db/schema/clinical"
import { professionalProfile } from "@odentia/db/schema/clinical-forms"
import { and, eq, sql } from "drizzle-orm"
import { orgDiagnosisSystem } from "./diagnosis-codes.js"
import { addEncounterDiagnosis } from "./encounter-diagnoses.js"
import { updateEncounterDraft } from "./encounters.js"
import { appDb, ownerDb } from "./test-setup.js"
import { nextPatientNumber } from "./patients.js"
import { insertTestPatients } from "./test-patient.js"

/** Miembro con colegiatura registrada: puede firmar el cierre de una atención. */
export async function makeSigner(orgId: string, userId: string): Promise<void> {
  const [existing] = await ownerDb
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  if (!existing) {
    await ownerDb
      .insert(member)
      .values({
        id: randomUUID(),
        organizationId: orgId,
        userId,
        role: "clinician",
        createdAt: new Date(),
      })
  }
  await ownerDb
    .insert(professionalProfile)
    // Título y colegio explícitos: el perfil no tiene valores por defecto de ningún país.
    .values({
      organizationId: orgId,
      userId,
      professionalTitle: "Cirujano dentista",
      registrationBody: "COP",
      registrationNumber: "12345",
    })
    .onConflictDoNothing()
}

/**
 * Deja una atención en borrador lista para cerrarse con el mínimo clínico
 * (ADR 0003): un diagnóstico de la lista con tipo y la evolución.
 */
/**
 * Códigos de una lista para la prueba, en una edición de prueba que no es
 * oficial (como la semilla de desarrollo). Sin `system`, la CIE-10.
 */
export async function seedDiagnosisCodes(
  codes: Array<{ code: string; title: string; isCategory?: boolean }>,
  system: DiagnosisSystemKey = "ICD-10",
): Promise<void> {
  await ownerDb
    .insert(diagnosisCodeRelease)
    .values({ systemKey: system, edition: "prueba", official: false, license: "Solo pruebas", codeCount: codes.length })
    .onConflictDoNothing()
  for (const item of codes) {
    await ownerDb
      .insert(diagnosisCatalog)
      .values({
        systemKey: system,
        code: item.code,
        edition: "prueba",
        title: item.title,
        isCategory: item.isCategory ?? false,
        searchText: diagnosisSearchText(item.code, item.title),
      })
      .onConflictDoNothing()
  }
  // Como el cargador: una categoría es el comienzo de otro código de la misma lista.
  await ownerDb.execute(sql`
    update "diagnosis_code" c set "is_category" = true
    where c."system_key" = ${system} and exists (
      select 1 from "diagnosis_code" sub
      where sub."system_key" = c."system_key" and sub."code" <> c."code" and starts_with(sub."code", c."code")
    )`)
}

export async function readyToClose(
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
): Promise<void> {
  // En la lista de la clínica: la de su país (una de Colombia trabaja con la CIE-11).
  const system = await withOrgContext(appDb, orgId, (tx) => orgDiagnosisSystem(tx, orgId))
  const caries =
    system === "ICD-11" ? { code: "DA08.0", title: "Caries dental" } : { code: "K02.1", title: "Caries de la dentina" }
  await seedDiagnosisCodes([caries], system)
  await withOrgContext(appDb, orgId, async (tx) => {
    await addEncounterDiagnosis(tx, orgId, actorUserId, patientId, encounterId, {
      diagnosisCode: caries.code,
      diagnosisType: "confirmed",
    })
    await updateEncounterDraft(tx, orgId, actorUserId, patientId, encounterId, {
      evolution: "Evolución favorable",
    })
  })
}

export async function clinicalFixture() {
  const actor = randomUUID()
  await ownerDb.insert(user).values({ id: actor, name: "Clínico", email: `${actor}@example.test` })
  await makeSigner("org_a", actor)
  const [person] = await insertTestPatients(ownerDb, {
      organizationId: "org_a",
      displayName: "Paciente de prueba",
      patientNumber: await nextPatientNumber(ownerDb, "org_a"),
    })
  const [session] = await ownerDb
    .insert(encounter)
    .values({
      organizationId: "org_a",
      patientId: person.id,
      professionalUserId: actor,
      reason: "Consulta",
    })
    .returning()
  const [plan] = await ownerDb
    .insert(treatmentPlan)
    .values({
      organizationId: "org_a",
      patientId: person.id,
      title: "Plan clínico",
      originEncounterId: session.id,
    })
    .returning()
  const [service] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: "org_a",
      name: "Tratamiento propio",
      scope: "general",
      source: "custom",
      priceCents: 120000,
      currency: "PEN",
    })
    .returning()
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
  /** Prepara el mínimo clínico de una atención del fixture antes de cerrarla. */
  const ready = (encounterId: string) => readyToClose("org_a", actor, person.id, encounterId)
  return {
    actor,
    patient: person,
    encounter: session,
    plan,
    service,
    run,
    ready,
    args: ["org_a", actor, person.id] as const,
  }
}
