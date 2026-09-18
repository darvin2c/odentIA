import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { encounter, patient, serviceCatalog, treatmentPlan } from "@odentia/db/schema/clinical"
import { appDb, ownerDb } from "./test-setup.js"
import { nextPatientNumber } from "./patients.js"

export async function clinicalFixture() {
  const actor = randomUUID()
  await ownerDb.insert(user).values({ id: actor, name: "Clínico", email: `${actor}@example.test` })
  const [person] = await ownerDb.insert(patient).values({ organizationId: "org_a", displayName: "Paciente de prueba", patientNumber: await nextPatientNumber(ownerDb, "org_a") }).returning()
  const [session] = await ownerDb.insert(encounter).values({ organizationId: "org_a", patientId: person.id, dentistUserId: actor }).returning()
  const [plan] = await ownerDb.insert(treatmentPlan).values({ organizationId: "org_a", patientId: person.id, title: "Plan clínico", originEncounterId: session.id }).returning()
  const [service] = await ownerDb.insert(serviceCatalog).values({ organizationId: "org_a", name: "Tratamiento propio", specialty: "general", scope: "general", source: "custom", priceCents: 120000, currency: "PEN" }).returning()
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, "org_a", fn)
  return { actor, patient: person, encounter: session, plan, service, run, args: ["org_a", actor, person.id] as const }
}
