import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import {
  cie10Code,
  encounter,
  patient,
  serviceCatalog,
  treatmentPlan,
} from "@odentia/db/schema/clinical"
import { professionalProfile } from "@odentia/db/schema/clinical-forms"
import { and, eq } from "drizzle-orm"
import { addEncounterDiagnosis } from "./encounter-diagnoses.js"
import { updateEncounterDraft } from "./encounters.js"
import { appDb, ownerDb } from "./test-setup.js"
import { nextPatientNumber } from "./patients.js"

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
        role: "dentist",
        createdAt: new Date(),
      })
  }
  await ownerDb
    .insert(professionalProfile)
    .values({ organizationId: orgId, userId, registrationNumber: "12345" })
    .onConflictDoNothing()
}

/**
 * Deja una atención en borrador lista para cerrarse con el mínimo clínico
 * (ADR 0003): un diagnóstico CIE-10 con tipo y la evolución.
 */
export async function readyToClose(
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
): Promise<void> {
  await ownerDb
    .insert(cie10Code)
    .values({ code: "K02.1", description: "Caries de la dentina" })
    .onConflictDoNothing()
  await withOrgContext(appDb, orgId, async (tx) => {
    await addEncounterDiagnosis(tx, orgId, actorUserId, patientId, encounterId, {
      cie10Code: "K02.1",
      diagnosisType: "definitivo",
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
  const [person] = await ownerDb
    .insert(patient)
    .values({
      organizationId: "org_a",
      displayName: "Paciente de prueba",
      patientNumber: await nextPatientNumber(ownerDb, "org_a"),
    })
    .returning()
  const [session] = await ownerDb
    .insert(encounter)
    .values({
      organizationId: "org_a",
      patientId: person.id,
      dentistUserId: actor,
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
      specialty: "general",
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
