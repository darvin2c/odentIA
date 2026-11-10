/**
 * La hoja del odontograma lleva la línea del membrete y el cuadro de iniciales
 * en el mismo tono legible que los demás papeles (ADR 0162); sin color elegido,
 * en gris. Va aquí y no en `clinic-identity.test.ts`: lo común no importa lo
 * dental (ADR 0079).
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { expect, it } from "vitest"
import { setClinicBrandColor } from "../clinic-identity.js"
import { loadDocumentClinic } from "../document-clinic.js"
import { nextPatientNumber } from "../patients.js"
import { insertTestPatients } from "../test-patient.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "../test-setup.js"
import { getOdontogramPrint } from "./odontogram.js"

setupTestDb()

it("la hoja del odontograma lleva la línea en el mismo tono que los demás papeles; sin color, gris", async () => {
  const orgId = `org_${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const [patient] = await insertTestPatients(ownerDb, {
    organizationId: orgId,
    displayName: "Rosa Díaz",
    patientNumber: await nextPatientNumber(ownerDb, orgId),
  })
  const sheet = () => run((tx) => getOdontogramPrint(tx, orgId, patient!.id))
  expect((await sheet()).establishment?.brandInk).toBeNull()
  await run((tx) => setClinicBrandColor(tx, orgId, "user_1", "#ea580c"))
  expect((await sheet()).establishment?.brandInk).toBe((await run((tx) => loadDocumentClinic(tx, orgId))).brandInk)
  // El color elegido no viaja crudo en la hoja: solo el tono legible del papel.
  expect((await sheet()).establishment).not.toHaveProperty("brandColor")
})
