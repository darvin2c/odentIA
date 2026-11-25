/**
 * Revisión final de formularios (15 nov, Y2 de la voz clínica; §D de la entrega 6): indicar una
 * exodoncia a quien toma warfarina o un bisfosfonato no avisaba nada. Ahora la fila de la exodoncia
 * dice lo que toma y qué pedir, con quién lo dijo, sin frenar nada.
 */
import { randomUUID } from "node:crypto"
import { patientMedication, serviceCatalog, treatmentTemplate } from "@odentia/db/schema/clinical"
import { serviceFinding } from "@odentia/db/schema/dental"
import { expect, it } from "vitest"
import { SUGGESTED_CONSENT_TEMPLATES } from "@odentia/clinical"
import { addDeclaredHealth, getPatientHealth, recordHealthDeclaration, savePatientHealth } from "../clinical.js"
import { createConsentDocument, createConsentTemplate, publishConsentTemplate } from "../clinical-forms.js"
import { clinicalFixture } from "../clinical-test-fixture.js"
import { placeBudgetPath } from "../budget-paths.js"
import { addPlanItem, listPlanItems } from "../plan.js"
import { ownerDb, setupTestDb } from "../test-setup.js"

setupTestDb()

it("la exodoncia por hacer dice lo que toma y la cambia; lo demás del plan y la coordinación, no", async () => {
  const f = await clinicalFixture()
  // El servicio del plan es una exodoncia: deja la pieza ausente.
  await ownerDb.insert(serviceFinding).values({ serviceId: f.service.id, organizationId: "org_a", condition: "missing_tooth" })
  const declared = {
    anticoagulants: { state: "recorded" as const, detail: "warfarina 5 mg" },
    boneMedicines: { state: "recorded" as const, detail: "alendronato 70 mg" },
  }
  await f.run(async (tx) => {
    await addDeclaredHealth(tx, "org_a", null, f.patient.id, declared, { entity: "registration_hold", entityId: f.patient.id, at: new Date() })
    await recordHealthDeclaration(tx, "org_a", f.patient.id, { via: "enlace", by: { kind: "patient", name: null, relation: null }, health: declared })
  })
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId: f.service.id, sourceEncounterId: f.encounter.id }))
  const [listed] = (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { extractionRisks: true }))).filter(
    (row) => row.id === item.id,
  )
  expect(listed?.extractionRisks).toEqual([
    expect.stringMatching(/^Toma warfarina 5 mg \(lo dijo el? ?[^)]*\): pide su INR del día\.$/),
    expect.stringMatching(/^Toma alendronato 70 mg \(lo dijo[^)]*\): riesgo de osteonecrosis de los maxilares\.$/),
  ])
  // Sin pedirlo (la coordinación, el dictado), no viaja.
  const plain = (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id))).find((row) => row.id === item.id)
  expect(plain).not.toHaveProperty("extractionRisks")
})

it("un apixabán dice el riesgo de sangrado, y el bisfosfonato que ya dejó sigue contando", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(serviceFinding).values({ serviceId: f.service.id, organizationId: "org_a", condition: "missing_tooth" })
  // Lo anotó el equipo: sin «lo dijo ella».
  const health = await f.run((tx) => getPatientHealth(tx, "org_a", f.patient.id))
  await f.run((tx) =>
    savePatientHealth(tx, "org_a", f.actor, f.patient.id, {
      expectedRevision: health.revision,
      reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "recorded" },
      conditions: [],
      medications: [
        { name: "Apixabán 5 mg", genericName: "apixabán" },
        { name: "Ácido zoledrónico", genericName: "ácido zoledrónico", endDate: "2024-01-01" },
        { name: "Clopidogrel 75 mg", genericName: "clopidogrel", endDate: "2024-01-01" },
      ],
    }),
  )
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId: f.service.id, sourceEncounterId: f.encounter.id }))
  const listed = (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { extractionRisks: true }))).find(
    (row) => row.id === item.id,
  )
  expect(listed?.extractionRisks).toEqual([
    // En minúscula en medio de la frase, como en la franja (verificación del 18 nov); la marca, no.
    "Toma apixabán 5 mg: riesgo de sangrado.",
    "Tomó ácido zoledrónico: riesgo de osteonecrosis de los maxilares.",
  ])
})

it("sin anticoagulante ni medicina para los huesos, la exodoncia no dice nada", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(serviceFinding).values({ serviceId: f.service.id, organizationId: "org_a", condition: "missing_tooth" })
  await ownerDb.insert(patientMedication).values({ organizationId: "org_a", patientId: f.patient.id, name: "Losartán 50 mg", atcCode: "C09CA01" })
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId: f.service.id, sourceEncounterId: f.encounter.id }))
  const listed = (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { extractionRisks: true }))).find(
    (row) => row.id === item.id,
  )
  expect(listed).not.toHaveProperty("extractionRisks")
})

/** Un tratamiento de la biblioteca de ese tipo y el servicio de la clínica que lo usa. */
async function libraryService(kind: string, name: string, keyPrefix = "prueba-cirugia-") {
  const [template] = await ownerDb
    .insert(treatmentTemplate)
    .values({ key: `${keyPrefix}${randomUUID()}`, name: `${name} ${randomUUID()}`, kind, scope: "general" })
    .returning()
  const [service] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: "org_a",
      templateId: template!.id,
      source: "template",
      name,
      scope: "general",
      priceCents: 150_000,
      currency: "PEN",
    })
    .returning()
  return service!
}

// Reglas clínicas del 18 nov (caso C1, Teresa): «alendronato 70 mg semanal» escrito a mano en
// Antecedentes, sin elegirlo de la lista. Antes quedaba sin código: la franja decía «no se le
// preguntó» y la exodoncia no avisaba nada.
it("la medicina escrita con su nombre estándar y la dosis cuenta: la exodoncia avisa la osteonecrosis", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(serviceFinding).values({ serviceId: f.service.id, organizationId: "org_a", condition: "missing_tooth" })
  const health = await f.run((tx) => getPatientHealth(tx, "org_a", f.patient.id))
  await f.run((tx) =>
    savePatientHealth(tx, "org_a", f.actor, f.patient.id, {
      expectedRevision: health.revision,
      reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "recorded" },
      conditions: [],
      medications: [{ name: "alendronato 70 mg semanal" }, { name: "Eliquis 5 mg" }],
    }),
  )
  const saved = await f.run((tx) => getPatientHealth(tx, "org_a", f.patient.id))
  // Lo escrito queda tal cual, con el código de su DCI.
  expect(saved.medications.map((row) => [row.name, row.atcCode])).toEqual([
    ["alendronato 70 mg semanal", "M05BA04"],
    ["Eliquis 5 mg", "B01AF02"],
  ])
  expect(saved.medicineClasses.boneMedicines.answer).toBe("yes")
  expect(saved.medicineClasses.anticoagulants.answer).toBe("yes")
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId: f.service.id, sourceEncounterId: f.encounter.id }))
  const listed = (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { extractionRisks: true }))).find(
    (row) => row.id === item.id,
  )
  expect(listed?.extractionRisks).toEqual([
    "Toma alendronato 70 mg semanal: riesgo de osteonecrosis de los maxilares.",
    "Toma Eliquis 5 mg: riesgo de sangrado.",
  ])
})

// AAOMS 2022: el riesgo de osteonecrosis es de toda cirugía que expone hueso, no solo de la exodoncia.
it("el implante y la cirugía oral avisan lo mismo que la exodoncia; la endodoncia, no", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(patientMedication).values({ organizationId: "org_a", patientId: f.patient.id, name: "Prolia", atcCode: "M05BX04" })
  const implant = await libraryService("implantologia", "Implante dental")
  const surgery = await libraryService("cirugia", "Frenectomía")
  const rootCanal = await libraryService("endodoncia", "Endodoncia")
  const items = await f.run(async (tx) => ({
    implant: await addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId: implant.id, sourceEncounterId: f.encounter.id }),
    surgery: await addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId: surgery.id, sourceEncounterId: f.encounter.id }),
    rootCanal: await addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId: rootCanal.id, sourceEncounterId: f.encounter.id }),
  }))
  const listed = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { extractionRisks: true }))
  const risks = (id: string) => listed.find((row) => row.id === id)?.extractionRisks
  const osteonecrosis = [expect.stringMatching(/^Toma Prolia( \([^)]*\))?: riesgo de osteonecrosis de los maxilares\.$/)]
  expect(risks(items.implant.id)).toEqual(osteonecrosis)
  expect(risks(items.surgery.id)).toEqual(osteonecrosis)
  expect(risks(items.rootCanal.id)).toBeUndefined()
})

// Revisión de las reglas clínicas del 18 nov: el servicio del tratamiento solo dice el procedimiento
// de una plantilla propia. La sugerida «Anestesia local» de una exodoncia consiente la anestesia, no
// la extracción: no lleva el riesgo del hueso, que va en el consentimiento de la exodoncia.
it("la anestesia sugerida de una exodoncia no lleva el riesgo del hueso; una plantilla propia, sí", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(serviceFinding).values({ serviceId: f.service.id, organizationId: "org_a", condition: "missing_tooth" })
  await ownerDb
    .insert(patientMedication)
    .values({ organizationId: "org_a", patientId: f.patient.id, name: "alendronato 70 mg semanal", atcCode: "M05BA04" })
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId: f.service.id, sourceEncounterId: f.encounter.id }))
  const published = async (key: string) => {
    const suggested = SUGGESTED_CONSENT_TEMPLATES.find((row) => row.key === "anestesia-local")!
    const draft = await f.run((tx) =>
      createConsentTemplate(tx, "org_a", f.actor, { key, title: `${suggested.title} ${key}`, sections: suggested.sections }),
    )
    return f.run((tx) => publishConsentTemplate(tx, "org_a", f.actor, draft.id))
  }
  const prepare = async (templateId: string) => {
    const doc = await f.run((tx) =>
      createConsentDocument(tx, "org_a", f.actor, { patientId: f.patient.id, templateId, planItemId: item.id }),
    )
    return (doc.sectionsSnapshot as { personalRisks?: string[] } | null)?.personalRisks ?? null
  }
  expect(await prepare((await published("anestesia-local")).id)).toBeNull()
  expect(await prepare((await published(`propia-${randomUUID().slice(0, 8)}`)).id)).toEqual([
    expect.stringContaining("osteonecrosis"),
  ])
})

// QA clínica del 18 nov (H1, alta): la apicectomía y la cirugía periodontal no avisaban, porque la
// biblioteca las pone en endodoncia y periodoncia. AAOMS 2022 y SDCEP 2022: avisan como la exodoncia,
// en la fila y en los riesgos propios de su consentimiento. El raspado y la endodoncia, no.
it("la apicectomía, el colgajo, el injerto, la gingivectomía y el alargamiento de corona avisan; el raspado, no", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(patientMedication).values([
    { organizationId: "org_a", patientId: f.patient.id, name: "Prolia", atcCode: "M05BX04" },
    { organizationId: "org_a", patientId: f.patient.id, name: "Sintrom 4 mg", atcCode: "B01AA07" },
  ])
  const surgical = await Promise.all([
    libraryService("endodoncia", "Apicectomía o cirugía periapical, anterior", "apicectomia-o-cirugia-periapical-anterior-"),
    libraryService("periodoncia", "Colgajo de reposición apical", "colgajo-de-reposicion-apical-"),
    libraryService("periodoncia", "Injerto gingival libre", "injerto-gingival-libre-"),
    libraryService("periodoncia", "Gingivectomía", "gingivectomia-o-gingivoplastia-1-a-3-dientes-"),
    libraryService("periodoncia", "Alargamiento de corona clínica", "alargamiento-de-corona-clinica-"),
  ])
  const scaling = await libraryService("periodoncia", "Raspado y alisado radicular", "raspado-y-alisado-radicular-")
  const rootCanal = await libraryService("endodoncia", "Endodoncia", "endodoncia-")
  const add = (serviceId: string) =>
    f.run((tx) => addPlanItem(tx, ...f.args, { planId: f.plan.id, serviceId, sourceEncounterId: f.encounter.id }))
  const surgicalItems = []
  for (const service of surgical) surgicalItems.push(await add(service.id))
  const scalingItem = await add(scaling.id)
  const rootCanalItem = await add(rootCanal.id)
  const listed = await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { extractionRisks: true }))
  const risks = (id: string) => listed.find((row) => row.id === id)?.extractionRisks
  for (const item of surgicalItems) {
    expect(risks(item.id)).toHaveLength(2)
    expect(risks(item.id)).toEqual(
      expect.arrayContaining([expect.stringMatching(/osteonecrosis/), expect.stringMatching(/^Toma Sintrom 4 mg.*INR/)]),
    )
  }
  expect(risks(scalingItem.id)).toBeUndefined()
  expect(risks(rootCanalItem.id)).toBeUndefined()

  // La misma regla en su consentimiento: el periodontal sugerido de un colgajo lleva el hueso.
  const periodontal = SUGGESTED_CONSENT_TEMPLATES.find((row) => row.key === "periodoncia")!
  const draft = await f.run((tx) =>
    createConsentTemplate(tx, "org_a", f.actor, { key: "periodoncia", title: periodontal.title, sections: periodontal.sections }),
  )
  const template = await f.run((tx) => publishConsentTemplate(tx, "org_a", f.actor, draft.id))
  const prepare = async (planItemId: string) => {
    const doc = await f.run((tx) =>
      createConsentDocument(tx, "org_a", f.actor, { patientId: f.patient.id, templateId: template.id, planItemId }),
    )
    return (doc.sectionsSnapshot as { personalRisks?: string[] } | null)?.personalRisks ?? []
  }
  expect(await prepare(surgicalItems[1]!.id)).toEqual(
    expect.arrayContaining([expect.stringContaining("osteonecrosis"), expect.stringContaining("sangrar")]),
  )
  // El raspado sigue con lo de siempre del periodontal: la herida, sin el hueso.
  expect((await prepare(scalingItem.id)).some((risk) => risk.includes("osteonecrosis"))).toBe(false)
})

it("la exodoncia por decidir entre dos caminos también avisa el anticoagulante confirmado", async () => {
  const f = await clinicalFixture()
  const tooth = (name: string, priceCents: number) =>
    ownerDb
      .insert(serviceCatalog)
      .values({ organizationId: "org_a", name, scope: "tooth", source: "custom", priceCents, currency: "PEN" })
      .returning()
      .then((rows) => rows[0]!)
  const exo = await tooth("Exodoncia simple", 15000)
  const endo = await tooth("Endodoncia", 65000)
  await ownerDb.insert(serviceFinding).values({ serviceId: exo.id, organizationId: "org_a", condition: "missing_tooth" })
  const health = await f.run((tx) => getPatientHealth(tx, "org_a", f.patient.id))
  await f.run((tx) =>
    savePatientHealth(tx, "org_a", f.actor, f.patient.id, {
      expectedRevision: health.revision,
      reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "recorded" },
      conditions: [],
      medications: [{ name: "Apixabán 5 mg", genericName: "apixabán" }],
    }),
  )
  // Conservar la 46 (endodoncia) o extraerla: la exodoncia queda «por decidir» en la otra opción.
  await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: endo.id, sourceEncounterId: f.encounter.id, toothNumber: 46 }))
  const exodoncia = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: exo.id, sourceEncounterId: f.encounter.id, toothNumber: 46 }),
  )
  await f.run((tx) => placeBudgetPath(tx, ...f.args, f.encounter.id, { planItemId: exodoncia.id, path: "nuevo" }))
  const listed = (await f.run((tx) => listPlanItems(tx, "org_a", f.patient.id, undefined, { extractionRisks: true }))).find(
    (row) => row.id === exodoncia.id,
  )
  expect(listed?.decisionStatus).toBe("pendiente")
  expect(listed?.extractionRisks).toEqual(["Toma apixabán 5 mg: riesgo de sangrado."])
})
