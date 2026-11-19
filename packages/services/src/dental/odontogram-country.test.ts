import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { withOrgContext } from "@odentia/db"
import { seedOdentiaCatalog } from "@odentia/db/dental"
import { user } from "@odentia/db/schema/auth"
import { encounter, encounterDiagnosis, serviceCatalog, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { odontogramEntry, serviceFinding } from "@odentia/db/schema/dental"
import { validateLeavesFinding } from "@odentia/dental"
import { and, eq, isNull, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "../budgets.js"
import { makeSigner, readyToClose, seedDiagnosisCodes } from "../clinical-test-fixture.js"
import {
  addEncounterProcedure,
  finalizeEncounter,
  getEncounterClosing,
  voidEncounterProcedure,
} from "../encounters.js"
import { nextPatientNumber } from "../patients.js"
import { addPlanItem, setPlanItemStatus } from "../plan.js"
import { createService } from "../service-catalog.js"
import { librarySpecialtyIds } from "../specialties.js"
import { insertTestPatients } from "../test-patient.js"
import { appDb, ownerDb, setupTestDb } from "../test-setup.js"
import {
  addOdontogramEntries,
  closingOdontogramOf,
  createOdontogramAssessment,
  getOdontogram,
  listOdontogramAssessments,
} from "./odontogram.js"
import { withPlanItemDental } from "./plan-finding.js"
import { registerToothFinding } from "./tooth-panel.js"
import { drawTreatedFinding } from "./treated-findings.js"

setupTestDb()

/** Clínica de otro país, armada en la prueba: la semilla sigue siendo peruana. */
async function colombianClinic(): Promise<string> {
  const id = `org_co_${randomUUID().slice(0, 8)}`
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at")
        values (${id}, 'Clínica Bogotá', ${id}, now())`,
  )
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
        values (${id}, 'Clínica Bogotá', 'CO', 'COP', 'America/Bogota', 'es-CO')`,
  )
  return id
}

/** Quien atiende, una persona y una atención en borrador en la clínica dada. */
async function attending(orgId: string) {
  const actor = randomUUID()
  await ownerDb.insert(user).values({ id: actor, name: "Ana Torres", email: `${actor}@example.test` })
  await makeSigner(orgId, actor)
  await seedDiagnosisCodes([
      { code: "K02", title: "Caries dental" },
      { code: "K02.1", title: "Caries de la dentina" },
    ])
  const [person] = await insertTestPatients(ownerDb, {
      organizationId: orgId,
      displayName: "Lucía Fernández",
      patientNumber: await nextPatientNumber(ownerDb, orgId),
    })
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const open = async () => {
    const [row] = await ownerDb
      .insert(encounter)
      .values({ organizationId: orgId, patientId: person!.id, professionalUserId: actor, reason: "Control" })
      .returning()
    return row!.id
  }
  return { orgId, actor, patientId: person!.id, run, open, args: [orgId, actor, person!.id] as const }
}

const caries16 = { toothNumber: 16, condition: "caries", surfaces: ["occlusal"] }

it("los hallazgos solo se registran dentro de una atención de quien la lleva", async () => {
  const f = await attending("org_a")
  await expect(
    f.run((tx) =>
      addOdontogramEntries(tx, ...f.args, {
        ...caries16,
        details: { variant: "dentin" },
      } as unknown as Parameters<typeof addOdontogramEntries>[4]),
    ),
  ).rejects.toMatchObject({ code: "ENCOUNTER_REQUIRED", status: 400 })
  // En la atención de otro profesional se toma el relevo antes.
  const colleague = await attending("org_a")
  const theirs = await colleague.open()
  await expect(
    f.run((tx) =>
      addOdontogramEntries(tx, "org_a", f.actor, colleague.patientId, {
        ...caries16,
        details: { variant: "dentin" },
        encounterId: theirs,
      }),
    ),
  ).rejects.toMatchObject({ code: "NOT_ATTENDING" })
  const mine = await f.open()
  const rows = await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, { ...caries16, details: { variant: "dentin" }, encounterId: mine }),
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ encounterId: mine, leftByPlanItemId: null })
})

// Nunca se decide por el profesional (17 nov, ADR 0200): la variante es opcional en Perú y fuera.
it("la variante es opcional en Perú y en otro país", async () => {
  const peru = await attending("org_a")
  const peruDraft = await peru.open()
  const [peruRow] = await peru.run((tx) => addOdontogramEntries(tx, ...peru.args, { ...caries16, encounterId: peruDraft }))
  expect(peruRow).toMatchObject({ condition: "caries", surface: "occlusal" })
  expect(peruRow?.details).toEqual({})
  const bogota = await attending(await colombianClinic())
  const draft = await bogota.open()
  const [row] = await bogota.run((tx) =>
    addOdontogramEntries(tx, ...bogota.args, { ...caries16, encounterId: draft }),
  )
  expect(row).toMatchObject({ condition: "caries", surface: "occlusal" })
  expect(row?.details).toEqual({})
})

it("al cerrar en Perú una atención que cambió el gráfico sale el odontograma firmado con su momento", async () => {
  const f = await attending("org_a")
  const first = await f.open()
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, { ...caries16, details: { variant: "dentin" }, encounterId: first }),
  )
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 26,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "enamel" },
      encounterId: first,
    }),
  )
  // El cierre lo dice antes de firmar, con lo que cambió.
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, first))
  expect(closing.odontogram).toEqual({
    purpose: "initial",
    standard: "NTS 188-MINSA/DGIESP-2022",
    shortName: "NTS 188",
    findings: [{ condition: "caries", teeth: [16, 26] }],
  })
  await readyToClose(f.orgId, f.actor, f.patientId, first)
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, first))
  expect(closed.odontogram).toMatchObject({ purpose: "initial" })
  const [signed] = await f.run((tx) => listOdontogramAssessments(tx, f.orgId, f.patientId))
  expect(signed).toMatchObject({
    purpose: "initial",
    encounterId: first,
    standard: "NTS 188-MINSA/DGIESP-2022",
    examinerName: "Ana Torres",
    examinerTitle: "Cirujano dentista",
    registrationNumber: "COP 12345",
  })
  expect(signed?.entries as unknown[]).toHaveLength(2)

  // Una atención que no cambió el gráfico no firma otro.
  const quiet = await f.open()
  await readyToClose(f.orgId, f.actor, f.patientId, quiet)
  expect((await f.run((tx) => finalizeEncounter(tx, ...f.args, quiet))).odontogram).toBeNull()

  // Lo siguiente que cambia el gráfico son nuevos hallazgos.
  const next = await f.open()
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 36,
      condition: "root_remnant",
      encounterId: next,
    }),
  )
  await readyToClose(f.orgId, f.actor, f.patientId, next)
  expect((await f.run((tx) => finalizeEncounter(tx, ...f.args, next))).odontogram).toMatchObject({
    purpose: "new_findings",
  })
  expect(await f.run((tx) => listOdontogramAssessments(tx, f.orgId, f.patientId))).toHaveLength(2)
})

it("fuera de Perú no hay odontograma firmado: el cierre no firma y el botón no existe", async () => {
  const f = await attending(await colombianClinic())
  const draft = await f.open()
  await f.run((tx) => addOdontogramEntries(tx, ...f.args, { ...caries16, encounterId: draft }))
  expect(await f.run((tx) => closingOdontogramOf(tx, f.orgId, f.patientId, draft))).toBeNull()
  await readyToClose(f.orgId, f.actor, f.patientId, draft)
  expect((await f.run((tx) => finalizeEncounter(tx, ...f.args, draft))).odontogram).toBeNull()
  expect(await f.run((tx) => listOdontogramAssessments(tx, f.orgId, f.patientId))).toEqual([])
  await expect(
    f.run((tx) => createOdontogramAssessment(tx, ...f.args, { purpose: "personal" })),
  ).rejects.toMatchObject({ code: "SIGNED_ODONTOGRAM_UNAVAILABLE" })
})

it("«Firmar odontograma» firma con el perfil, solo para pedidos y reingreso, y no toma datos del cuerpo", async () => {
  const f = await attending("org_a")
  await expect(
    f.run((tx) => createOdontogramAssessment(tx, ...f.args, { purpose: "initial" })),
  ).rejects.toMatchObject({ status: 400 })
  const signed = await f.run((tx) =>
    createOdontogramAssessment(tx, ...f.args, {
      purpose: "legal",
      observations: "Pedido del juzgado",
      // Lo que se escriba como firmante o trazo no cuenta: firma el perfil.
      examinerName: "Otra persona",
      registrationNumber: "COP 999",
      signature: [[[1, 1], [2, 2]]],
    } as Parameters<typeof createOdontogramAssessment>[4]),
  )
  expect(signed).toMatchObject({
    purpose: "legal",
    encounterId: null,
    examinerName: "Ana Torres",
    examinerTitle: "Cirujano dentista",
    registrationNumber: "COP 12345",
    observations: "Pedido del juzgado",
  })
  expect(Object.keys(signed)).not.toContain("signature")
})

it("completar un tratamiento cuyo servicio deja algo lo dibuja una sola vez", async () => {
  const f = await attending("org_a")
  const draft = await f.open()
  // En el Perú cada servicio propio lleva su código CPMS (ADR 0069).
  await seedOdentiaCatalog(ownerDb)
  const resin = await f.run(async (tx) =>
    createService(tx, f.orgId, f.actor, {
      name: "Resina compuesta",
      officialCode: "D2391",
      specialtyId: (await librarySpecialtyIds(tx, f.orgId, ["restauradora"])).get("restauradora")!,
      scope: "surfaces",
      priceCents: 18000,
      leavesFinding: { condition: "definitive_restoration", variant: "resin" },
    }),
  )
  // Lo que deja se configura también sin su variante, en Perú como fuera (ADR 0200).
  const crownService = await f.run(async (tx) =>
    createService(tx, f.orgId, f.actor, {
      name: "Corona",
      officialCode: "D2740",
      specialtyId: (await librarySpecialtyIds(tx, f.orgId, ["protesis"])).get("protesis")!,
      scope: "tooth",
      priceCents: 50000,
      leavesFinding: { condition: "crown" },
    }),
  )
  expect(crownService.leavesFinding).toEqual({ condition: "crown" })
  const [caries] = await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, { ...caries16, details: { variant: "dentin" }, encounterId: draft }),
  )
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: resin.id,
      sourceEncounterId: draft,
      toothNumber: 16,
      surfaces: ["occlusal"],
      odontogramEntryId: caries!.id,
    }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: item.planId, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }),
  )
  const procedure = await f.run((tx) => addEncounterProcedure(tx, ...f.args, draft, { planItemId: item.id }))
  await f.run((tx) => setPlanItemStatus(tx, ...f.args, item.id, { status: "realizado", encounterId: draft }))
  const left = () =>
    ownerDb
      .select()
      .from(odontogramEntry)
      .where(and(eq(odontogramEntry.leftByPlanItemId, item.id), isNull(odontogramEntry.voidedAt)))
  const [restoration] = await left()
  expect(restoration).toMatchObject({
    toothNumber: 16,
    surface: "occlusal",
    condition: "definitive_restoration",
    encounterId: draft,
    details: { variant: "resin", quality: "good" },
  })
  // Otra vez no lo duplica.
  const [row] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, item.id))
  const treated = await withPlanItemDental(ownerDb, f.orgId, row!)
  expect(await f.run((tx) => drawTreatedFinding(tx, ...f.args, draft, treated))).toBeNull()
  expect(await left()).toHaveLength(1)
  // Si se anula su procedimiento deja de estar realizado y lo dibujado se anula.
  await f.run((tx) => voidEncounterProcedure(tx, ...f.args, draft, procedure.id, { reason: "Pieza equivocada" }))
  expect(await left()).toHaveLength(0)
  // Al cerrar, la caries ya no está pero la restauración sí (con otro procedimiento y otro «Completar»).
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, draft, { planItemId: item.id }))
  await f.run((tx) => setPlanItemStatus(tx, ...f.args, item.id, { status: "realizado", encounterId: draft }))
  await readyToClose(f.orgId, f.actor, f.patientId, draft)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, draft))
  const chart = await f.run((tx) => getOdontogram(tx, f.orgId, f.patientId))
  const active = chart.teeth["16"]!.entries.map((id) => chart.history.find((entry) => entry.id === id)?.condition)
  expect(active).toEqual(["definitive_restoration"])
})

// Revisión del 16 nov (R4): la caries O de la 16 y la resina O indicada y hecha hoy son la caries y
// su tratamiento, no caries bajo una restauración. La caries se resuelve al firmar, pero la resina ya
// dibujó su restauración: el cierre no avisa «caries y restauración en la misma cara». Una caries en
// la cara de una restauración que no es de lo tratado hoy, sí.
it("la caries tratada hoy no avisa caries y restauración en la misma cara; una caries sobre otra restauración, sí", async () => {
  const f = await attending("org_a")
  const draft = await f.open()
  await seedOdentiaCatalog(ownerDb)
  const resin = await f.run(async (tx) =>
    createService(tx, f.orgId, f.actor, {
      name: "Resina compuesta",
      officialCode: "D2391",
      specialtyId: (await librarySpecialtyIds(tx, f.orgId, ["restauradora"])).get("restauradora")!,
      scope: "surfaces",
      priceCents: 18000,
      leavesFinding: { condition: "definitive_restoration", variant: "resin" },
    }),
  )
  const [caries] = await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, { ...caries16, details: { variant: "dentin" }, encounterId: draft }),
  )
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: resin.id,
      sourceEncounterId: draft,
      toothNumber: 16,
      surfaces: ["occlusal"],
      odontogramEntryId: caries!.id,
    }),
  )
  // Indicada y hecha hoy: se acepta al hacerla y, de una sesión, ya dibuja su restauración.
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, draft, { planItemId: item.id, acceptWhenDone: true }))
  const drawn = await ownerDb
    .select()
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.leftByPlanItemId, item.id), isNull(odontogramEntry.voidedAt)))
  expect(drawn.map((entry) => [entry.toothNumber, entry.surface])).toEqual([[16, "occlusal"]])
  const sameFace = async () =>
    ((await f.run((tx) => getEncounterClosing(tx, ...f.args, draft))) as { sameFace?: unknown }).sameFace
  expect(await sameFace()).toEqual([])
  // La 26 tiene una restauración y hoy se ve caries en esa misma cara: eso sí se avisa.
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 26,
      condition: "definitive_restoration",
      surfaces: ["occlusal"],
      details: { variant: "resin", quality: "good" },
      encounterId: draft,
    }),
  )
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 26,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "dentin" },
      encounterId: draft,
    }),
  )
  expect(await sameFace()).toEqual([{ toothNumber: 26, surface: "occlusal" }])
})

it("firmar sin responder «¿Terminaste?» termina la resina de una sesión y el odontograma firmado la trae", async () => {
  const f = await attending("org_a")
  await seedOdentiaCatalog(ownerDb)
  const resin = await f.run(async (tx) =>
    createService(tx, f.orgId, f.actor, {
      name: "Resina compuesta",
      officialCode: "D2391",
      specialtyId: (await librarySpecialtyIds(tx, f.orgId, ["restauradora"])).get("restauradora")!,
      scope: "surfaces",
      priceCents: 18000,
      leavesFinding: { condition: "definitive_restoration", variant: "resin" },
    }),
  )
  // La caries se registró en una atención anterior, ya firmada.
  const before = await f.open()
  const [caries] = await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, { ...caries16, details: { variant: "dentin" }, encounterId: before }),
  )
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: resin.id,
      sourceEncounterId: before,
      toothNumber: 16,
      surfaces: ["occlusal"],
      odontogramEntryId: caries!.id,
    }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: item.planId, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  await readyToClose(f.orgId, f.actor, f.patientId, before)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, before))
  // Hoy se hace la resina y se firma sin tocar nada.
  const draft = await f.open()
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, draft, { planItemId: item.id }))
  await readyToClose(f.orgId, f.actor, f.patientId, draft)
  // El cierre ya avisa el odontograma que se firma: con la resina hecha, el plan culmina.
  const preview = (await f.run((tx) => getEncounterClosing(tx, ...f.args, draft))) as { odontogram?: unknown }
  expect(preview.odontogram).toMatchObject({ purpose: "completion" })
  // Con «Falta otra sesión» elegido, no lo anuncia: hoy no cambió el gráfico.
  const kept = (await f.run((tx) => getEncounterClosing(tx, ...f.args, draft, [item.id]))) as { odontogram?: unknown }
  expect(kept.odontogram).toBeNull()
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, draft))
  expect(closed.odontogram).toMatchObject({ purpose: "completion" })
  const [row] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, item.id))
  expect(row).toMatchObject({ status: "realizado" })
  const [restoration] = await ownerDb
    .select()
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.leftByPlanItemId, item.id), isNull(odontogramEntry.voidedAt)))
  expect(restoration).toMatchObject({ toothNumber: 16, condition: "definitive_restoration", encounterId: draft })
  // El odontograma que se firma con esta atención ya la trae.

  const signed = (await f.run((tx) => listOdontogramAssessments(tx, f.orgId, f.patientId))).find(
    (assessment) => assessment.encounterId === draft,
  )
  expect(JSON.stringify(signed?.entries)).toContain("definitive_restoration")
})

// Reglas clínicas del 18 nov (punto 3, caso C3): «Nuevos hallazgos» solo con hallazgos observados.
// Lo que dibuja un tratamiento al hacerse (el TC de la endodoncia) no es un hallazgo nuevo, y la
// sesión que solo trata, sin hallazgos ni culminación, no firma copia (NTS 188, 5.8 y 5.10).
it("la sesión que solo trata no firma copia; la que trae una caries nueva firma «Nuevos hallazgos» solo con ella", async () => {
  const f = await attending("org_a")
  await seedOdentiaCatalog(ownerDb)
  const endodontics = await f.run(async (tx) =>
    createService(tx, f.orgId, f.actor, {
      name: "Endodoncia multirradicular",
      officialCode: "D3330",
      specialtyId: (await librarySpecialtyIds(tx, f.orgId, ["endodoncia"])).get("endodoncia")!,
      scope: "tooth",
      priceCents: 60000,
      leavesFinding: { condition: "root_canal_treatment", variant: "root_canal" },
    }),
  )
  const crown = await f.run(async (tx) =>
    createService(tx, f.orgId, f.actor, {
      name: "Corona",
      officialCode: "D2740",
      specialtyId: (await librarySpecialtyIds(tx, f.orgId, ["protesis"])).get("protesis")!,
      scope: "tooth",
      priceCents: 50000,
      leavesFinding: { condition: "crown" },
    }),
  )
  // Sesión 1: la caries profunda de la 36, la endodoncia y la corona; firma el inicio del plan.
  const first = await f.open()
  const [caries36] = await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, { toothNumber: 36, condition: "caries", surfaces: ["occlusal"], encounterId: first }),
  )
  const endo = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: endodontics.id, sourceEncounterId: first, toothNumber: 36, odontogramEntryId: caries36!.id }),
  )
  const cap = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: crown.id, sourceEncounterId: first, toothNumber: 36 }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: endo.planId, itemIds: [endo.id, cap.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [
        { planItemId: endo.id, decision: "aceptado" },
        { planItemId: cap.id, decision: "aceptado" },
      ],
    }),
  )
  await readyToClose(f.orgId, f.actor, f.patientId, first)
  // La primera atención todavía no tiene odontograma firmado: el cierre lo recuerda si no se llena.
  expect(await f.run((tx) => getEncounterClosing(tx, ...f.args, first))).toMatchObject({ odontogramSignedBefore: false })
  expect((await f.run((tx) => finalizeEncounter(tx, ...f.args, first))).odontogram).toMatchObject({ purpose: "initial" })

  // Sesión 2: se hace la endodoncia, que dibuja su tratamiento de conducto; la corona sigue pendiente.
  const second = await f.open()
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, second, { planItemId: endo.id }))
  await f.run((tx) => setPlanItemStatus(tx, ...f.args, endo.id, { status: "realizado", encounterId: second }))
  const [drawn] = await ownerDb
    .select()
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.leftByPlanItemId, endo.id), isNull(odontogramEntry.voidedAt)))
  expect(drawn).toMatchObject({ toothNumber: 36, condition: "root_canal_treatment", encounterId: second })
  await readyToClose(f.orgId, f.actor, f.patientId, second)
  // Ni el cierre lo anuncia ni la firma lo firma: no hay hallazgos ni culmina el plan.
  const closing = (await f.run((tx) => getEncounterClosing(tx, ...f.args, second))) as {
    odontogram?: unknown
    odontogramSignedBefore?: boolean
  }
  expect(closing.odontogram).toBeNull()
  // Ya tiene el inicio firmado: lo que hoy solo trata no pide registrar el odontograma.
  expect(closing.odontogramSignedBefore).toBe(true)
  expect((await f.run((tx) => finalizeEncounter(tx, ...f.args, second))).odontogram).toBeNull()
  expect(await f.run((tx) => listOdontogramAssessments(tx, f.orgId, f.patientId))).toHaveLength(1)
  // Lo tratado sigue en el gráfico.
  const chart = await f.run((tx) => getOdontogram(tx, f.orgId, f.patientId))
  expect(chart.teeth["36"]!.entries.map((id) => chart.history.find((entry) => entry.id === id)?.condition)).toContain(
    "root_canal_treatment",
  )

  // Sesión 3: una caries nueva en la 26 firma «Nuevos hallazgos», con ella y nada más.
  const third = await f.open()
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, { toothNumber: 26, condition: "caries", surfaces: ["occlusal"], encounterId: third }),
  )
  await readyToClose(f.orgId, f.actor, f.patientId, third)
  const preview = (await f.run((tx) => getEncounterClosing(tx, ...f.args, third))) as { odontogram?: unknown }
  expect(preview.odontogram).toMatchObject({
    purpose: "new_findings",
    findings: [{ condition: "caries", teeth: [26] }],
  })
  expect((await f.run((tx) => finalizeEncounter(tx, ...f.args, third))).odontogram).toMatchObject({
    purpose: "new_findings",
  })
  expect(await f.run((tx) => listOdontogramAssessments(tx, f.orgId, f.patientId))).toHaveLength(2)
})

it("la exodoncia de un servicio directo deja la pieza ausente con su causa en Perú", async () => {
  const f = await attending("org_a")
  const draft = await f.open()
  const [service] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: f.orgId,
      name: "Exodoncia simple",
      scope: "tooth",
      source: "custom",
      priceCents: 9000,
      currency: "PEN",
    })
    .returning()
  await ownerDb.insert(serviceFinding).values({ serviceId: service!.id, organizationId: f.orgId, condition: "missing_tooth" })
  const [remnant] = await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, { toothNumber: 46, condition: "root_remnant", encounterId: draft }),
  )
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, draft, {
      serviceId: service!.id,
      toothNumber: 46,
      odontogramEntryId: remnant!.id,
    }),
  )
  const [absent] = await ownerDb
    .select()
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.encounterId, draft), eq(odontogramEntry.condition, "missing_tooth")))
  expect(absent?.details).toMatchObject({ variant: "caries_extraction" })
  expect(absent?.leftByPlanItemId).not.toBeNull()
})

it("el panel de la pieza deja hallazgo, diagnóstico y tratamiento juntos, o nada", async () => {
  const f = await attending("org_a")
  const draft = await f.open()
  const [resin] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: f.orgId,
      name: "Resina compuesta",
      scope: "surfaces",
      source: "custom",
      priceCents: 18000,
      currency: "PEN",
    })
    .returning()
  const result = await f.run((tx) =>
    registerToothFinding(tx, ...f.args, {
      encounterId: draft,
      toothNumbers: [16],
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "dentin" },
      diagnosis: { diagnosisCode: "K02.1", diagnosisType: "provisional" },
      treatment: { serviceId: resin!.id },
    }),
  )
  expect(result.entries).toHaveLength(1)
  const [diagnosis] = await ownerDb
    .select()
    .from(encounterDiagnosis)
    .where(eq(encounterDiagnosis.encounterId, draft))
  expect(diagnosis).toMatchObject({ diagnosisCode: "K02.1", diagnosisType: "provisional", siteSystem: "ISO-3950", siteCode: "16", siteQualifiers: ["occlusal"] })
  expect(result.planItems[0]).toMatchObject({
    toothNumber: 16,
    surfaces: ["occlusal"],
    odontogramEntryId: result.entries[0]!.id,
    diagnosisCode: "K02.1",
    sourceEncounterId: draft,
  })
  // Cuenta como diagnóstico de la atención: el cierre ya no lo pide.
  expect((await f.run((tx) => getEncounterClosing(tx, ...f.args, draft))).missing).not.toContain("diagnosis")

  // Si algo falla (aquí, una categoría CIE-10 sin su subcódigo), no queda nada.
  const before = await ownerDb.select().from(odontogramEntry).where(eq(odontogramEntry.encounterId, draft))
  await expect(
    f.run((tx) =>
      registerToothFinding(tx, ...f.args, {
        encounterId: draft,
        toothNumbers: [26],
        condition: "caries",
        surfaces: ["occlusal"],
        details: { variant: "enamel" },
        diagnosis: { diagnosisCode: "K02", diagnosisType: "provisional" },
        treatment: { serviceId: resin!.id },
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  expect(await ownerDb.select().from(odontogramEntry).where(eq(odontogramEntry.encounterId, draft))).toHaveLength(
    before.length,
  )
  expect(await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.encounterId, draft))).toHaveLength(1)
})

it("la caries guarda su código aunque junto se elija la pulpitis (segundo repaso del 9 nov, N8)", async () => {
  const f = await attending("org_a")
  await seedDiagnosisCodes([
    { code: "K02.5", title: "Caries con exposición pulpar" },
    { code: "K04.0", title: "Pulpitis" },
  ])
  const draft = await f.open()
  // 46: caries CDP en oclusal y distal, y «Pulpitis» elegida en el mismo panel.
  const deep = await f.run((tx) =>
    registerToothFinding(tx, ...f.args, {
      encounterId: draft,
      toothNumbers: [46],
      condition: "caries",
      surfaces: ["occlusal", "distal"],
      details: { variant: "pulpal_involvement" },
      diagnosis: { diagnosisCode: "K04.0", diagnosisType: "confirmed" },
    }),
  )
  expect(deep.entries.length).toBeGreaterThan(0)
  for (const entry of deep.entries)
    expect(entry).toMatchObject({ diagnosisSystem: "ICD-10-PE", diagnosisCode: "K02.5" })
  // La pulpitis queda como diagnóstico de la atención, en su pieza.
  const [pulpitis] = await ownerDb
    .select()
    .from(encounterDiagnosis)
    .where(eq(encounterDiagnosis.encounterId, draft))
  expect(pulpitis).toMatchObject({ diagnosisCode: "K04.0", siteCode: "46" })

  // Otra caries elegida (la de la dentina) es de la misma categoría: vale lo elegido.
  const chosen = await f.run((tx) =>
    registerToothFinding(tx, ...f.args, {
      encounterId: draft,
      toothNumbers: [36],
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "pulpal_involvement" },
      diagnosis: { diagnosisCode: "K02.1", diagnosisType: "provisional" },
    }),
  )
  expect(chosen.entries[0]).toMatchObject({ diagnosisCode: "K02.1" })
})

it("lo que deja cada tratamiento de la biblioteca encaja con su ámbito y es un hallazgo completo", () => {
  const rows = readFileSync(new URL("../../../db/seeds/biblioteca.csv", import.meta.url), "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(",", 9))
  const leaving = rows.filter((cols) => cols[5])
  expect(leaving.length).toBeGreaterThan(0)
  for (const [key, , scope, , , condition, variant] of leaving) {
    const leaves = variant ? { condition: condition!, variant } : { condition: condition! }
    expect(validateLeavesFinding(leaves, { scope, strictVariants: true }), key).toEqual([])
  }
})

it("«Firmar odontograma» a pedido no congela lo de una atención aún abierta", async () => {
  const f = await attending("org_a")
  const draft = await f.open()
  await f.run((tx) => addOdontogramEntries(tx, ...f.args, { ...caries16, details: { variant: "dentin" }, encounterId: draft }))
  const signed = await f.run((tx) => createOdontogramAssessment(tx, ...f.args, { purpose: "personal" }))
  expect(signed.entries).toEqual([])
})
