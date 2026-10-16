/**
 * Quién decide por un paciente (revisión final de la fase 3): la propia
 * persona mayor de edad o su representante legal vigente. Un menor no decide,
 * aunque escriba él; y sin fecha de nacimiento no firma por enlace.
 */
import { randomUUID } from "node:crypto"
import { patient, patientContact, patientResponsibility } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { serviceRecipient } from "./budget-send.js"
import {
  createConsentDocument,
  createConsentTemplate,
  markConsentSentByLink,
  publishConsentTemplate,
  signConsentByLink,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { patientPersonId } from "./patients.js"
import { contactDecides, requireDecisionContact } from "./responsibilities.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ORG = "org_a"
const minorBirth = () => `${new Date().getUTCFullYear() - 12}-06-01`

it("un menor no decide por sí mismo, ni su presupuesto se le envía a él", async () => {
  const f = await clinicalFixture()
  await ownerDb.update(patient).set({ birthDate: minorBirth() }).where(eq(patient.id, f.patient.id))
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  await expect(f.run((tx) => requireDecisionContact(tx, ORG, f.patient.id, personId))).rejects.toMatchObject({
    code: "DECISION_CONTACT_NOT_AUTHORIZED",
  })
  // Sin representante legal no hay a quién enviarle lo del servicio: no cae al menor.
  await expect(f.run((tx) => serviceRecipient(tx, ORG, f.patient.id))).rejects.toMatchObject({ code: "BUDGET_NO_RECIPIENT" })

  const [madre] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Rosa Madre" }).returning({ id: contact.id })
  await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId: f.patient.id, contactId: madre!.id, relationship: "guardian" })
  await ownerDb.insert(patientResponsibility).values({
    organizationId: ORG, patientId: f.patient.id, contactId: madre!.id, kind: "representante_legal", startsAt: "2020-01-01",
  })
  expect(await f.run((tx) => contactDecides(tx, ORG, f.patient.id, madre!.id))).toBe(true)
  expect((await f.run((tx) => serviceRecipient(tx, ORG, f.patient.id))).contactId).toBe(madre!.id)

  // Ya mayor de edad, la representación que tuvo de menor terminó; la que se registra siendo adulta sí vale.
  // Cumplió 18 este 1 de enero: la madre la representaba desde 2020.
  await ownerDb.update(patient).set({ birthDate: `${new Date().getUTCFullYear() - 18}-01-01` }).where(eq(patient.id, f.patient.id))
  expect(await f.run((tx) => contactDecides(tx, ORG, f.patient.id, madre!.id))).toBe(false)
  expect(await f.run((tx) => contactDecides(tx, ORG, f.patient.id, personId))).toBe(true)
  await ownerDb
    .update(patientResponsibility)
    .set({ revokedAt: new Date(), revokeReason: "Cumplió 18" })
    .where(eq(patientResponsibility.patientId, f.patient.id))
  await ownerDb.insert(patientResponsibility).values({
    organizationId: ORG, patientId: f.patient.id, contactId: madre!.id, kind: "representante_legal", startsAt: new Date().toISOString().slice(0, 10),
  })
  expect(await f.run((tx) => contactDecides(tx, ORG, f.patient.id, madre!.id))).toBe(true)
})

it("sin fecha de nacimiento la propia persona no firma por enlace: lo firma en la clínica", async () => {
  const f = await clinicalFixture()
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  const draft = await f.run((tx) =>
    createConsentTemplate(tx, ORG, f.actor, {
      key: `t-${randomUUID().slice(0, 8)}`,
      title: "Exodoncia",
      sections: {
        procedure: "Extracción de la pieza dentaria con anestesia local.",
        benefits: ["Quitar el dolor"],
        risks: ["Sangrado los primeros días"],
        alternatives: ["Tratamiento de conductos"],
        consequences: "La infección puede avanzar.",
      },
    }),
  )
  const template = await f.run((tx) => publishConsentTemplate(tx, ORG, f.actor, draft.id))
  const consent = await f.run((tx) => createConsentDocument(tx, ORG, f.actor, { templateId: template.id, patientId: f.patient.id, procedureRef: "Exodoncia" }))
  await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, consent.id))
  await expect(
    f.run((tx) =>
      signConsentByLink(tx, ORG, personId, consent.id, {
        docNumber: "40000004",
        comprehensionConfirmed: true,
        signatureData: { strokes: [[[10, 10], [200, 120]]] },
      }),
    ),
  ).rejects.toMatchObject({ code: "SIGNER_NOT_AUTHORIZED" })
})
