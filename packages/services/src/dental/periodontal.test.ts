import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { encounter, encounterDiagnosis } from "@odentia/db/schema/clinical"
import { odontogramEntry } from "@odentia/db/schema/dental"
import { and, eq, isNull, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { addOdontogramEntries } from "./odontogram.js"
import { makeSigner, readyToClose, seedDiagnosisCodes } from "../clinical-test-fixture.js"
import { finalizeEncounter, getEncounterClosing } from "../encounters.js"
import { getPatientSummary, getTimeline } from "../patient-history.js"
import { nextPatientNumber } from "../patients.js"
import {
  classifyPeriodontalChart,
  comparePeriodontalCharts,
  getPeriodontalChart,
  listPeriodontalCharts,
  savePeriodontalTooth,
  startPeriodontalChart,
} from "./periodontal.js"
import { appDb, ownerDb, setupTestDb } from "../test-setup.js"
import { insertTestPatients } from "../test-patient.js"

setupTestDb()

/** Quien atiende a una persona de 48 años sin terceros molares y con un implante en la 46. */
async function attending(orgId = "org_a") {
  const actor = randomUUID()
  await ownerDb.insert(user).values({ id: actor, name: "Ana Torres", email: `${actor}@example.test` })
  await makeSigner(orgId, actor)
  const [person] = await insertTestPatients(ownerDb, {
    organizationId: orgId,
    displayName: "Carlos Paredes",
    birthDate: "1978-03-21",
    patientNumber: await nextPatientNumber(ownerDb, orgId),
  })
  const patientId = person!.id
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const open = async () => {
    const [row] = await ownerDb
      .insert(encounter)
      .values({ organizationId: orgId, patientId, professionalUserId: actor, reason: "Le sangran las encías" })
      .returning()
    return row!.id
  }
  const first = await open()
  await run(async (tx) => {
    for (const [tooth, variant] of [[18, "other_absence"], [28, "other_absence"], [38, "unerupted"], [48, "unerupted"]] as const) {
      await addOdontogramEntries(tx, orgId, actor, patientId, { toothNumber: tooth, condition: "missing_tooth", details: { variant }, encounterId: first })
    }
    await addOdontogramEntries(tx, orgId, actor, patientId, { toothNumber: 46, condition: "implant", details: { clinicallyObserved: true, quality: "good" }, encounterId: first })
  })
  const close = async (encounterId: string) => {
    await readyToClose(orgId, actor, patientId, encounterId)
    await run((tx) => finalizeEncounter(tx, orgId, actor, patientId, encounterId))
  }
  return { orgId, actor, patientId, run, open, close, first }
}

const tooth36 = {
  toothNumber: 36,
  probingDepth: [5, 3, 6, 5, 3, 6],
  recession: [0, 0, 1, 1, 0, 0],
  bleeding: [true, false, true, true, false, true],
  suppuration: [false, false, true, false, false, false],
  furcation: { buccal: 2 as const, lingual: 1 as const },
}

it("toma del odontograma las piezas y el implante, y es uno por atención", async () => {
  const f = await attending()
  const chart = await f.run((tx) => startPeriodontalChart(tx, f.orgId, f.actor, f.patientId, { encounterId: f.first }))
  expect(chart.expectedTeeth).toHaveLength(28)
  expect(chart.expectedTeeth).not.toContain(18)
  expect(chart.implantTeeth).toEqual([46])
  expect(chart.teeth).toHaveLength(28)
  expect(chart.summary.pendingTeeth).toHaveLength(28)
  const again = await f.run((tx) => startPeriodontalChart(tx, f.orgId, f.actor, f.patientId, { encounterId: f.first }))
  expect(again.id).toBe(chart.id)
})

it("solo quien lleva la atención escribe, solo en borrador y solo las piezas que se sondean", async () => {
  const f = await attending()
  const chart = await f.run((tx) => startPeriodontalChart(tx, f.orgId, f.actor, f.patientId, { encounterId: f.first }))
  const colleague = randomUUID()
  await ownerDb.insert(user).values({ id: colleague, name: "Luis", email: `${colleague}@example.test` })
  await expect(
    f.run((tx) => savePeriodontalTooth(tx, f.orgId, colleague, f.patientId, chart.id, tooth36)),
  ).rejects.toMatchObject({ code: "NOT_ATTENDING" })
  await expect(
    f.run((tx) => savePeriodontalTooth(tx, f.orgId, f.actor, f.patientId, chart.id, { toothNumber: 18, probingDepth: [3, 2, 3, 3, 2, 3] })),
  ).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/ausente/) })
  await expect(
    f.run((tx) => savePeriodontalTooth(tx, f.orgId, f.actor, f.patientId, chart.id, { toothNumber: 46, plaque: [true, false, false, false] })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  const saved = await f.run((tx) => savePeriodontalTooth(tx, f.orgId, f.actor, f.patientId, chart.id, tooth36))
  expect(saved).toMatchObject({ toothNumber: 36, probingDepth: tooth36.probingDepth, furcation: { buccal: 2, lingual: 1 } })
  // Guardar de nuevo reemplaza la pieza entera; un sitio sin medir vuelve como nulo.
  const partial = await f.run((tx) =>
    savePeriodontalTooth(tx, f.orgId, f.actor, f.patientId, chart.id, { toothNumber: 37, probingDepth: [4, 3, null, null, null, null] }),
  )
  expect(partial.probingDepth).toEqual([4, 3, null, null, null, null])

  await f.close(f.first)
  await expect(
    f.run((tx) => savePeriodontalTooth(tx, f.orgId, f.actor, f.patientId, chart.id, tooth36)),
  ).rejects.toMatchObject({ code: "FINALIZED" })
  // La base también lo impide: ni reescribir ni borrar lo firmado.
  await expect(
    f.run((tx) => tx.execute(sql`update periodontal_tooth set probing_depth = '{1,1,1,1,1,1}' where chart_id = ${chart.id}`)),
  ).rejects.toThrow()
  await expect(
    f.run((tx) => tx.execute(sql`delete from periodontal_tooth where chart_id = ${chart.id}`)),
  ).rejects.toThrow()
  const view = await f.run((tx) => getPeriodontalChart(tx, f.orgId, f.patientId, chart.id))
  expect(view.encounterStatus).toBe("finalizada")
  expect(view.teeth.find((t) => t.toothNumber === 36)?.probingDepth).toEqual(tooth36.probingDepth)
})

it("calcula, guarda la clasificación que confirma el odontólogo y compara dos visitas", async () => {
  const f = await attending()
  await seedDiagnosisCodes([{ code: "K05.3", title: "Periodontitis crónica" }])
  const periodontalDiagnoses = (encounterId: string) =>
    ownerDb
      .select({ code: encounterDiagnosis.diagnosisCode, note: encounterDiagnosis.note, type: encounterDiagnosis.diagnosisType })
      .from(encounterDiagnosis)
      .where(and(eq(encounterDiagnosis.encounterId, encounterId), eq(encounterDiagnosis.diagnosisCode, "K05.3"), isNull(encounterDiagnosis.voidedAt)))
  const initial = await f.run((tx) => startPeriodontalChart(tx, f.orgId, f.actor, f.patientId, { encounterId: f.first }))
  await f.run(async (tx) => {
    await savePeriodontalTooth(tx, f.orgId, f.actor, f.patientId, initial.id, tooth36)
    await savePeriodontalTooth(tx, f.orgId, f.actor, f.patientId, initial.id, {
      toothNumber: 16,
      probingDepth: [6, 3, 5, 6, 3, 6],
      recession: [0, 0, 1, 0, 0, 0],
      bleeding: [false, false, true, true, false, true],
    })
    await savePeriodontalTooth(tx, f.orgId, f.actor, f.patientId, initial.id, {
      toothNumber: 46,
      probingDepth: [4, 3, 4, 4, 3, 3],
      recession: [0, 0, 0, 0, 0, 0],
      bleeding: [true, false, true, false, false, false],
    })
  })
  await expect(
    f.run((tx) => classifyPeriodontalChart(tx, f.orgId, f.actor, f.patientId, initial.id, { diagnosis: "periodontitis", stage: 3 })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  const classified = await f.run((tx) =>
    classifyPeriodontalChart(tx, f.orgId, f.actor, f.patientId, initial.id, {
      diagnosis: "periodontitis",
      stage: 3,
      grade: "B",
      extent: "generalized",
      boneLossPercent: 40,
      teethLostToPeriodontitis: 1,
      cigarettesPerDay: 6,
      diabetes: false,
      implants: [{ toothNumber: 46, condition: "mucositis" }],
    }),
  )
  expect(classified.classification).toMatchObject({ diagnosis: "periodontitis", stage: 3, grade: "B", extent: "generalized", boneLossPercent: 40 })
  expect(classified.summary.worstInterdentalLoss).toEqual({ toothNumber: 36, site: "distobuccal", value: 7 })
  expect(classified.summary.implants).toEqual([{ toothNumber: 46, bleedingSites: 2, suppurationSites: 0, maxProbingDepth: 4 }])
  // La propuesta usa la edad del día de la atención: 40 % entre 48 años, grado B.
  expect(classified.proposal).toMatchObject({ diagnosis: "periodontitis", stage: 3, grade: "B" })
  expect(classified.teeth.find((t) => t.toothNumber === 46)?.periImplant).toBe("mucositis")
  // «Confirmar diagnóstico» deja también el de la atención, una sola vez, con la clasificación como nota.
  await f.run((tx) =>
    classifyPeriodontalChart(tx, f.orgId, f.actor, f.patientId, initial.id, { diagnosis: "periodontitis", stage: 3, grade: "B", extent: "generalized" }),
  )
  expect(await periodontalDiagnoses(f.first)).toEqual([
    { code: "K05.3", note: "Periodontitis estadio III, grado B, generalizada (AAP/EFP 2017)", type: "confirmed" },
  ])
  await f.close(f.first)

  const second = await f.open()
  const reevaluation = await f.run((tx) => startPeriodontalChart(tx, f.orgId, f.actor, f.patientId, { encounterId: second }))
  await f.run((tx) =>
    savePeriodontalTooth(tx, f.orgId, f.actor, f.patientId, reevaluation.id, {
      ...tooth36,
      probingDepth: [3, 3, 4, 3, 3, 8],
      bleeding: [false, false, false, false, false, true],
      suppuration: [false, false, false, false, false, false],
    }),
  )
  // La reevaluación parte del diagnóstico anterior y propone cómo está hoy.
  const view = await f.run((tx) => getPeriodontalChart(tx, f.orgId, f.patientId, reevaluation.id))
  expect(view.proposal).toMatchObject({ diagnosis: "periodontitis", stage: 3, grade: "B", extent: "generalized", status: "unstable", missing: [] })
  expect(view.proposal.reasons.at(-1)).toBe("Inestable: la 36, distal por dentro, tiene una bolsa de 8 mm (5 mm o más).")
  await f.run((tx) =>
    classifyPeriodontalChart(tx, f.orgId, f.actor, f.patientId, reevaluation.id, {
      diagnosis: "periodontitis",
      stage: 3,
      grade: "B",
      extent: "generalized",
      status: "unstable",
    }),
  )
  expect((await periodontalDiagnoses(second))[0]?.note).toBe("Periodontitis estadio III, grado B, generalizada, inestable (AAP/EFP 2017)")
  const list = await f.run((tx) => listPeriodontalCharts(tx, f.orgId, f.patientId))
  expect(list.map((item) => item.id)).toEqual([reevaluation.id, initial.id])
  expect(list[1]).toMatchObject({ encounterStatus: "finalizada", sitesFrom6mm: 5, classification: { diagnosis: "periodontitis", stage: 3, grade: "B" } })
  expect(list[0]).toMatchObject({ encounterStatus: "borrador", pendingTeeth: 27, classification: { status: "unstable" } })
  const comparison = await f.run((tx) => comparePeriodontalCharts(tx, f.orgId, f.patientId, initial.id, reevaluation.id))
  expect(comparison.compared).toBe(6)
  expect(comparison.improved.map((c) => c.site)).toEqual(["mesiobuccal", "distobuccal", "mesiolingual"])
  expect(comparison.worsened).toEqual([{ toothNumber: 36, site: "distolingual", before: 6, after: 8, delta: 2 }])
})

it("la movilidad se ve en el odontograma y el cierre, el Resumen e Historia lo nombran", async () => {
  const f = await attending()
  const chart = await f.run((tx) => startPeriodontalChart(tx, f.orgId, f.actor, f.patientId, { encounterId: f.first }))
  const mobility = () =>
    ownerDb
      .select({ grade: sql<number>`(${odontogramEntry.details}->>'grade')::int`, voided: odontogramEntry.voidReason })
      .from(odontogramEntry)
      .where(and(eq(odontogramEntry.patientId, f.patientId), eq(odontogramEntry.condition, "pathological_mobility")))
      .orderBy(odontogramEntry.createdAt)
  const save31 = (value: number | null) =>
    f.run((tx) =>
      savePeriodontalTooth(tx, f.orgId, f.actor, f.patientId, chart.id, { toothNumber: 31, probingDepth: [3, 2, 3, 3, 2, 3], mobility: value }),
    )
  await save31(1)
  // Guardar de nuevo el mismo grado no repite el hallazgo; cambiarlo corrige el de esta atención.
  await save31(1)
  expect(await mobility()).toEqual([{ grade: 1, voided: null }])
  await save31(2)
  expect(await mobility()).toEqual([
    { grade: 1, voided: "Movilidad corregida en el periodontograma" },
    { grade: 2, voided: null },
  ])
  await save31(0)
  expect((await mobility()).every((row) => row.voided !== null)).toBe(true)
  await save31(1)

  // El cierre dice lo que falta: se firma igual, como parcial.
  const closing = await f.run((tx) => getEncounterClosing(tx, f.orgId, f.actor, f.patientId, f.first))
  expect(closing.periodontal).toEqual({
    teeth: 27,
    implants: 1,
    pending:
      "arriba por fuera, de la 17 a la 27; arriba por dentro, de la 27 a la 17; abajo por dentro, de la 47 a la 41 y de la 32 a la 37; abajo por fuera, de la 37 a la 32 y de la 41 a la 47",
  })
  await f.close(f.first)
  const summary = await f.run((tx) => getPatientSummary(tx, f.orgId, f.patientId))
  expect(summary.periodontal).toMatchObject({ chartId: chart.id, classification: null, bleedingPercent: 0, partial: true })
  const timeline = await f.run((tx) => getTimeline(tx, f.orgId, f.patientId, { types: ["encounter"] }))
  expect(timeline.data.find((item) => item.id === f.first)?.periodontal).toMatchObject({ chartId: chart.id, partial: true })
})

it("otra clínica no ve el periodontograma", async () => {
  const f = await attending()
  const chart = await f.run((tx) => startPeriodontalChart(tx, f.orgId, f.actor, f.patientId, { encounterId: f.first }))
  await expect(
    withOrgContext(appDb, "org_b", (tx) => getPeriodontalChart(tx, "org_b", f.patientId, chart.id)),
  ).rejects.toMatchObject({ code: "NOT_FOUND" })
  const leaked = await withOrgContext(appDb, "org_b", (tx) => tx.execute(sql`select id from periodontal_chart where id = ${chart.id}`))
  expect([...leaked]).toHaveLength(0)
})
