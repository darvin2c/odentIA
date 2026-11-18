/**
 * El consentimiento creado desde Documentos («Nuevo › Consentimiento») va con el tratamiento del
 * plan que lo pide, como el de «Preparar» (mesa del 17 nov, hallazgo 1 del novato): el firmado así
 * quedaba suelto y el Plan, la sesión siguiente y el cierre lo volvían a pedir. Con varios
 * tratamientos que lo piden se elige cuál; no se adivina.
 */
import { randomUUID } from "node:crypto"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { consentDocument, consentTemplateService } from "@odentia/db/schema/clinical-forms"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  consentTreatmentChoices,
  createConsentDocument,
  createConsentTemplate,
  getEncounterConsentNeeds,
  publishConsentTemplate,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { treatmentConsentStates } from "./consent-state.js"
import { addEncounterProcedure } from "./encounters.js"
import { addPlanItem } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Una plantilla publicada que pide el servicio del fixture, ya en piezas. */
async function endodonticsAsksConsent(f: Fixture) {
  await ownerDb
    .update(serviceCatalog)
    .set({ scope: "tooth" })
    .where(eq(serviceCatalog.id, f.service.id))
  const draft = await f.run((tx) =>
    createConsentTemplate(tx, "org_a", f.actor, {
      key: `t-${randomUUID().slice(0, 8)}`,
      title: "Tratamiento de conductos (endodoncia)",
      sections: {
        procedure: "Tratamiento de conductos.",
        benefits: ["Conservar la pieza"],
        risks: ["Dolor"],
        alternatives: ["Exodoncia"],
        consequences: "Puede avanzar.",
      },
    }),
  )
  const template = await f.run((tx) => publishConsentTemplate(tx, "org_a", f.actor, draft.id))
  await ownerDb
    .insert(consentTemplateService)
    .values({ organizationId: "org_a", templateKey: template.key, serviceId: f.service.id })
  return template
}

const indicate = (f: Fixture, tooth: number) =>
  f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
      toothNumber: tooth,
    }),
  )

const stateOf = async (f: Fixture, id: string) =>
  (await f.run((tx) => treatmentConsentStates(tx, "org_a", [id]))).get(id)?.state

it("el de Documentos va con el único tratamiento que lo pide: el Plan y la sesión siguiente lo cuentan", async () => {
  const f = await clinicalFixture()
  const template = await endodonticsAsksConsent(f)
  const item = await indicate(f, 46)
  expect(await stateOf(f, item.id)).toBe("falta")
  // Documentos ofrece ese tratamiento para la plantilla, ya con lo que se consiente.
  const choices = await f.run((tx) =>
    consentTreatmentChoices(tx, "org_a", f.patient.id, template.id),
  )
  expect(choices).toHaveLength(1)
  expect(choices[0]).toMatchObject({ planItemId: item.id })
  expect(choices[0]?.label).toContain("46")

  // Como lo enviaba «Nuevo › Consentimiento» de la ficha: sin tratamiento ni atención, con el texto a mano.
  const doc = await f.run((tx) =>
    createConsentDocument(tx, "org_a", f.actor, {
      templateId: template.id,
      patientId: f.patient.id,
      procedureRef: "Endodoncia pieza 46",
    }),
  )
  expect(doc.planItemId).toBe(item.id)
  expect(doc.procedureRef).toBe("Endodoncia pieza 46")
  expect(await stateOf(f, item.id)).toBe("sin_firmar")
  // Ya tiene el suyo: no se ofrece otra vez.
  expect(
    await f.run((tx) => consentTreatmentChoices(tx, "org_a", f.patient.id, template.id)),
  ).toEqual([])

  await ownerDb
    .update(consentDocument)
    .set({
      status: "firmado",
      signedAt: new Date(),
      signatureMethod: "clinica",
      signatureLevel: "simple",
    })
    .where(eq(consentDocument.id, doc.id))
  expect(await stateOf(f, item.id)).toBe("firmado")
  // En la atención donde se hace (lo que trae «Hacerla hoy»), ya está firmado: el cierre no lo pide.
  const needs = await f.run((tx) =>
    getEncounterConsentNeeds(tx, "org_a", f.patient.id, f.encounter.id, [item.id]),
  )
  expect(needs.find((need) => need.templateKey === template.key)).toMatchObject({
    status: "firmado",
    documentId: doc.id,
  })
})

it("sin texto, lo que se consiente sale del tratamiento, como con «Preparar»", async () => {
  const f = await clinicalFixture()
  const template = await endodonticsAsksConsent(f)
  const item = await indicate(f, 36)
  const doc = await f.run((tx) =>
    createConsentDocument(tx, "org_a", f.actor, {
      templateId: template.id,
      patientId: f.patient.id,
      encounterId: f.encounter.id,
    }),
  )
  expect(doc.planItemId).toBe(item.id)
  expect(doc.procedureRef).toContain("36")
})

it("con dos tratamientos que lo piden se elige cuál, y «fuera del plan» no se une a ninguno", async () => {
  const f = await clinicalFixture()
  const template = await endodonticsAsksConsent(f)
  const first = await indicate(f, 46)
  const second = await indicate(f, 36)
  const choices = await f.run((tx) =>
    consentTreatmentChoices(tx, "org_a", f.patient.id, template.id),
  )
  expect(choices.map((choice) => choice.planItemId)).toEqual([first.id, second.id])

  // Sin decir cuál, no se adivina: el rechazo cae en el campo del tratamiento.
  await expect(
    f.run((tx) =>
      createConsentDocument(tx, "org_a", f.actor, {
        templateId: template.id,
        patientId: f.patient.id,
        procedureRef: "Endodoncia",
      }),
    ),
  ).rejects.toMatchObject({ fields: { planItemId: "Elige el tratamiento al que aplica" } })

  const chosen = await f.run((tx) =>
    createConsentDocument(tx, "org_a", f.actor, {
      templateId: template.id,
      patientId: f.patient.id,
      planItemId: second.id,
    }),
  )
  expect(chosen.planItemId).toBe(second.id)
  expect(await stateOf(f, second.id)).toBe("sin_firmar")
  expect(await stateOf(f, first.id)).toBe("falta")

  // Ahora queda uno solo, pero «Otro procedimiento, fuera del plan» lo deja suelto, como se pidió.
  const outside = await f.run((tx) =>
    createConsentDocument(tx, "org_a", f.actor, {
      templateId: template.id,
      patientId: f.patient.id,
      procedureRef: "Endodoncia de la 11, fuera del plan",
      outsidePlan: true,
    }),
  )
  expect(outside.planItemId).toBeNull()
  expect(await stateOf(f, first.id)).toBe("falta")
})

it("desde una atención que ya registró lo suyo, no se une solo a otro tratamiento del plan", async () => {
  const f = await clinicalFixture()
  const template = await endodonticsAsksConsent(f)
  // El plan tiene lo de la 48 sin su consentimiento; hoy se hizo otra cosa, en la 38.
  const other = await indicate(f, 48)
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, {
      description: "Exodoncia simple",
      toothNumber: 38,
    }),
  )
  const doc = await f.run((tx) =>
    createConsentDocument(tx, "org_a", f.actor, {
      templateId: template.id,
      patientId: f.patient.id,
      encounterId: f.encounter.id,
      procedureRef: "Exodoncia simple · pieza 38",
    }),
  )
  expect(doc.planItemId).toBeNull()
  expect(doc.procedureRef).toBe("Exodoncia simple · pieza 38")
  // Lo de la 48 lo sigue pidiendo: no se firmó para él.
  expect(await stateOf(f, other.id)).toBe("falta")
})
