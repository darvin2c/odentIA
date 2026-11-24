import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { encounter } from "@odentia/db/schema/clinical"
import { expect, it } from "vitest"
import { makeSigner } from "../clinical-test-fixture.js"
import { nextPatientNumber } from "../patients.js"
import { insertTestPatients } from "../test-patient.js"
import { appDb, ownerDb, setupTestDb } from "../test-setup.js"
import { listWorkspaceAudit } from "../workspace.js"
import { addOdontogramEntries } from "./odontogram.js"
import { getToothHistory } from "./tooth-history.js"

setupTestDb()

/** Quien atiende, una persona y una atención en borrador. */
async function attending(orgId: string) {
  const actor = randomUUID()
  await ownerDb
    .insert(user)
    .values({ id: actor, name: "Ana Torres", email: `${actor}@example.test` })
  await makeSigner(orgId, actor)
  const [person] = await insertTestPatients(ownerDb, {
    organizationId: orgId,
    displayName: "Mario Castillo",
    patientNumber: await nextPatientNumber(ownerDb, orgId),
  })
  const [draft] = await ownerDb
    .insert(encounter)
    .values({
      organizationId: orgId,
      patientId: person!.id,
      professionalUserId: actor,
      reason: "Control",
    })
    .returning()
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  return { actor, patientId: person!.id, encounterId: draft!.id, run }
}

// QA del 23 nov: el puente de la 44 a la 46 se guarda en la 44 y nombra las demás.
it("el puente sale en la historia de cada una de sus piezas, no solo en la primera", async () => {
  const f = await attending("org_a")
  await f.run((tx) =>
    addOdontogramEntries(tx, "org_a", f.actor, f.patientId, {
      toothNumber: 44,
      condition: "fixed_partial_denture",
      surfaces: [],
      details: { relatedTeeth: [44, 45, 46], abutmentTeeth: [44, 46], quality: "good" },
      encounterId: f.encounterId,
    }),
  )
  for (const tooth of [44, 45, 46]) {
    const events = await f.run((tx) => getToothHistory(tx, "org_a", f.patientId, tooth))
    expect(
      events.some((event) => event.kind === "hallazgo" && event.code === "fixed_partial_denture"),
      `pieza ${tooth}`,
    ).toBe(true)
  }
  // La 47 no es del puente.
  const outside = await f.run((tx) => getToothHistory(tx, "org_a", f.patientId, 47))
  expect(outside.some((event) => event.code === "fixed_partial_denture")).toBe(false)
})

it("en la Actividad, «Anotó un hallazgo en el odontograma» dice de qué paciente es", async () => {
  const f = await attending("org_a")
  await f.run((tx) =>
    addOdontogramEntries(tx, "org_a", f.actor, f.patientId, {
      toothNumber: 16,
      condition: "caries",
      surfaces: ["occlusal"],
      encounterId: f.encounterId,
    }),
  )
  const activity = await f.run((tx) =>
    listWorkspaceAudit(tx, "org_a", { action: "odontogram.entry_added" }),
  )
  const mine = activity.items.find((item) => item.subject?.patientId === f.patientId)
  expect(mine?.subject).toMatchObject({ patientId: f.patientId, personName: "Mario Castillo" })
})
