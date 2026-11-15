import { expect, it } from "vitest"
import { addPatientAllergy } from "./allergies.js"
import { issuePersonalLink } from "./booking-links.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { allergiesSaidNoByPatient, allergiesSaidUnknownByPatient, getPatientHealth } from "./clinical.js"
import { createPatient, getPatient, patientPersonId } from "./patients.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { submitPersonalLinkData } from "./su-enlace.js"
import { setupTestDb } from "./test-setup.js"

/**
 * QA de formularios del 15 nov (K16; clínica A1 de la 6): su «No sé» a las alergias quedaba como
 * «no se le preguntó». Se guarda como lo dijo y se lee como lo que es: se le preguntó y no sabe.
 */
setupTestDb()

const ORG = "org_a"
const KEY = secretsKeyFromEnv("cd".repeat(32))

it("su «No sé» a las alergias, desde su enlace, se lee «no sabe», con quién lo dijo y cuándo", async () => {
  const f = await clinicalFixture()
  const created = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, { displayName: "Nora Salas", givenNames: "Nora", familyName: "Salas", phone: "+51987111333" }),
  )
  const personId = await f.run((tx) => patientPersonId(tx, ORG, created.id))
  const link = await f.run((tx) =>
    issuePersonalLink(tx, ORG, { contactId: personId!, patientId: created.id }, { secretsKey: KEY }),
  )
  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, link.token, {
      data: { birthDate: "1950-03-01" },
      health: { allergies: { state: "unknown", items: [] } },
    }),
  )

  const health = await f.run((tx) => getPatientHealth(tx, ORG, created.id))
  // Lo que dijo se guarda tal cual: «No sé», no «Sin responder».
  expect(health.declarations[0]?.health.allergies).toEqual({ state: "unknown", items: [] })
  // La ficha sigue sin saber si tiene: eso no cambia.
  expect(health.reviewStatus.allergies).toBe("unknown")
  // A quien ve las alergias (también recepción): dijo que no sabe, no «no se le preguntó» ni «dijo que no».
  const saidUnknown = () => f.run(async (tx) => allergiesSaidUnknownByPatient(tx, ORG, await getPatient(tx, ORG, created.id)))
  const said = await saidUnknown()
  // Solo quién y cuándo: lo que viaja a recepción no trae nada más de lo que dijo.
  expect(Object.keys(said ?? {}).sort()).toEqual(["at", "by"])
  expect(said).toMatchObject({ by: { kind: "patient" } })
  expect(said?.at.getTime()).toBe(health.declarations[0]!.at.getTime())
  expect(await f.run((tx) => allergiesSaidNoByPatient(tx, ORG, created.id))).toBeNull()

  // Cuando el equipo anota una alergia, ya se sabe más: deja de decirse.
  await f.run((tx) => addPatientAllergy(tx, ORG, f.actor, created.id, { substance: "Látex" }))
  expect(await saidUnknown()).toBeNull()
})
