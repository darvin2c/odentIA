import { withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { procedureCode, procedureCodeSystem, treatmentTemplate } from "@odentia/db/schema/clinical"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, getBudgetDetail, presentBudget } from "./budgets.js"
import { addEncounterProcedure, createEncounter } from "./encounters.js"
import { addPlanItem, createTreatmentPlan, listPlanItems, updatePlanItem } from "./plan.js"
import {
  assertExecutableCodings,
  listTemplateCodings,
  resolveServiceCodings,
  templatesForCode,
} from "./procedure-codings.js"
import { createPatient } from "./patients.js"
import { createService, listTemplates } from "./service-catalog.js"
import { isUniqueViolation } from "./errors.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ACTOR = "u-coding-tests"
const VERSION = "RM-550-2023-MINSA"

async function seedGlobals(): Promise<{ fluorId: string; resinaId: string }> {
  await ownerDb
    .insert(user)
    .values({ id: ACTOR, name: "Coding Tests", email: "coding@example.com" })
    .onConflictDoNothing()
  await ownerDb
    .insert(procedureCodeSystem)
    .values([
      {
        key: "CPMS",
        title: "Catálogo de Procedimientos Médicos y Sanitarios",
        publisher: "MINSA Perú",
        country: "PE",
        license: "publico-MINSA",
        sourceUrl: "https://www.gob.pe/institucion/minsa/normas-legales/4294232-550-2023-minsa",
      },
      {
        key: "CDT",
        title: "Current Dental Terminology",
        publisher: "American Dental Association",
        country: "US",
        license: "ADA-requerida",
        sourceUrl: "https://www.ada.org/publications/cdt",
      },
    ])
    .onConflictDoNothing()
  await ownerDb
    .insert(procedureCode)
    .values([
      {
        systemKey: "CPMS",
        code: "D1208",
        version: VERSION,
        display: "Aplicación tópica de flúor gel",
      },
      { systemKey: "CPMS", code: "D1206", version: VERSION, display: "Aplicación de flúor barniz" },
      {
        systemKey: "CPMS",
        code: "D2330",
        version: VERSION,
        display: "Resina una superficie anterior",
      },
      {
        systemKey: "CPMS",
        code: "D2391",
        version: VERSION,
        display: "Resina una superficie posterior",
      },
      {
        systemKey: "CPMS",
        code: "D1352",
        version: VERSION,
        display: "Inactivación de caries dental",
      },
    ])
    .onConflictDoNothing()
  await ownerDb
    .insert(treatmentTemplate)
    .values([
      {
        key: "prevencion:aplicacion-topica-de-fluor-test",
        name: "Aplicación tópica de flúor (test)",
        specialty: "prevencion",
        scope: "general",
      },
      {
        key: "restauradora:resina-una-superficie-test",
        name: "Resina de una superficie (test)",
        specialty: "restauradora",
        scope: "surfaces",
        surfaceCountMin: 1,
        surfaceCountMax: 1,
      },
    ])
    .onConflictDoNothing()
  const templates = await ownerDb.execute<{ id: string; key: string }>(
    sql`select "id", "key" from "treatment_template"
        where "key" in ('prevencion:aplicacion-topica-de-fluor-test', 'restauradora:resina-una-superficie-test')`,
  )
  const byKey = new Map(
    (templates as unknown as { id: string; key: string }[]).map((t) => [t.key, t.id]),
  )
  const fluorId = byKey.get("prevencion:aplicacion-topica-de-fluor-test")!
  const resinaId = byKey.get("restauradora:resina-una-superficie-test")!
  expect(fluorId).toBeTruthy()
  expect(resinaId).toBeTruthy()
  // Proyección 1:1: cada plantilla vigente proyecta UN único código oficial.
  await ownerDb.execute(
    sql`insert into "treatment_template_code" ("template_id", "system_key", "code", "version", "is_primary")
        values (${fluorId}, 'CPMS', 'D1208', ${VERSION}, true),
               (${resinaId}, 'CPMS', 'D2330', ${VERSION}, true)
        on conflict ("template_id", "system_key", "code", "version") do nothing`,
  )
  await seedRelease()
  return { fluorId, resinaId }
}

/** Edición oficial vigente para la biblioteca (idempotente por PK). */
async function seedRelease(expectedCount = 2): Promise<void> {
  await ownerDb.execute(
    sql`insert into "procedure_catalog_release"
          ("system_key", "version", "scope", "source_url", "source_sha256", "expected_count", "is_current")
        values ('CPMS', ${VERSION}, 'odontologia',
                'https://cdn.www.gob.pe/uploads/document/file/4660631/Parte%201%20050623%20Anexo%20Nro.%201%20Listado%20de%20Procedimientos%20M%C3%A9dicos%20y%20Sanitarios%20ok15.xlsx?v=1686924375',
                '0000000000000000000000000000000000000000000000000000000000000000',
                ${expectedCount}, true)
        on conflict ("system_key", "version") do update set
          "scope" = excluded."scope",
          "source_url" = excluded."source_url",
          "expected_count" = excluded."expected_count",
          "is_current" = true`,
  )
}

async function setupCase(displayName: string) {
  const { fluorId, resinaId } = await seedGlobals()
  const fluorService = await withOrgContext(appDb, "org_a", (tx) =>
    createService(tx, "org_a", ACTOR, { templateId: fluorId, priceCents: 12000 }),
  )
  const resinaService = await withOrgContext(appDb, "org_a", (tx) =>
    createService(tx, "org_a", ACTOR, { templateId: resinaId, priceCents: 17500 }),
  )
  const patient = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName }),
  )
  const draft = await withOrgContext(appDb, "org_a", (tx) =>
    createEncounter(tx, "org_a", ACTOR, patient.id, { reason: "Chequeo" }),
  )
  const plan = await withOrgContext(appDb, "org_a", (tx) =>
    createTreatmentPlan(tx, "org_a", ACTOR, patient.id, {
      title: "Plan",
      originEncounterId: draft.id,
    }),
  )
  return { fluorId, resinaId, fluorService, resinaService, patient, draft, plan }
}

it("proyección 1:1: la plantilla vigente ofrece un único snapshot exacto", async () => {
  const { fluorId } = await seedGlobals()
  const codings = await withOrgContext(appDb, "org_a", (tx) => listTemplateCodings(tx, fluorId))
  expect(codings).toHaveLength(1)
  expect(codings[0]).toMatchObject({ system: "CPMS", code: "D1208", version: VERSION })
})

it("búsqueda inversa por código CPMS", async () => {
  await seedGlobals()
  const found = await withOrgContext(appDb, "org_a", (tx) => templatesForCode(tx, "CPMS", "D2330"))
  expect(found.map((f) => f.templateKey)).toContain("restauradora:resina-una-superficie-test")
  const empty = await withOrgContext(appDb, "org_a", (tx) => templatesForCode(tx, "CPMS", "D1352"))
  expect(empty).toEqual([])
})

it("biblioteca vigente: paginada y por código con total y availableCount global", async () => {
  await seedGlobals()
  const first = await withOrgContext(appDb, "org_a", (tx) => listTemplates(tx, { limit: 1 }))
  expect(first.total).toBe(2)
  expect(first.data).toHaveLength(1)
  expect(first.nextCursor).toBeTruthy()
  expect(first.catalog).toMatchObject({ system: "CPMS", version: VERSION, availableCount: 2 })
  expect(first.data[0]?.codings).toHaveLength(1)
  const second = await withOrgContext(appDb, "org_a", (tx) =>
    listTemplates(tx, { limit: 1, cursor: first.nextCursor! }),
  )
  expect(second.data).toHaveLength(1)
  expect(second.data[0]?.id).not.toBe(first.data[0]?.id)
  expect(second.catalog?.availableCount).toBe(2)
  // Búsqueda por código oficial: filtra el total pero no el disponible global.
  const byCode = await withOrgContext(appDb, "org_a", (tx) => listTemplates(tx, { q: "D1208" }))
  expect(byCode.total).toBe(1)
  expect(byCode.data.map((t) => t.codings[0]?.code)).toEqual(["D1208"])
  expect(byCode.catalog?.availableCount).toBe(2)
  // Filtro por especialidad: el total respeta el filtro, el disponible es global.
  const bySpecialty = await withOrgContext(appDb, "org_a", (tx) =>
    listTemplates(tx, { specialty: "prevencion" }),
  )
  expect(bySpecialty.total).toBe(1)
  expect(bySpecialty.data.map((t) => t.codings[0]?.code)).toEqual(["D1208"])
  expect(bySpecialty.catalog?.availableCount).toBe(2)
})

it("el ítem del plan congela el snapshot exacto y no sigue al catálogo", async () => {
  const { resinaService, patient, draft, plan } = await setupCase("Snapshot Congelado")
  const snapshot = await withOrgContext(appDb, "org_a", (tx) =>
    resolveServiceCodings(tx, resinaService),
  )
  expect(snapshot.map((c) => c.code)).toEqual(["D2330"])
  const item = await withOrgContext(appDb, "org_a", (tx) =>
    addPlanItem(tx, "org_a", ACTOR, patient.id, {
      serviceId: resinaService.id,
      planId: plan.id,
      sourceEncounterId: draft.id,
      toothNumber: 36,
      surfaces: ["occlusal"],
    }),
  )
  expect(item.codings.map((c) => c.code)).toEqual(["D2330"])
  expect(item.codings[0]?.version).toBe(VERSION)
  // Cambio posterior del display oficial: el ítem no debe moverse.
  await ownerDb.execute(
    sql`update "procedure_code" set "display" = 'Resina anterior (rev.)'
        where "system_key" = 'CPMS' and "code" = 'D2330' and "version" = ${VERSION}`,
  )
  const items = await withOrgContext(appDb, "org_a", (tx) =>
    listPlanItems(tx, "org_a", patient.id, plan.id),
  )
  expect(items.find((i) => i.id === item.id)?.codings.map((c) => c.code)).toEqual(["D2330"])
  expect(items.find((i) => i.id === item.id)?.codings[0]?.display).toBe(
    "Resina una superficie anterior",
  )
  await ownerDb.execute(
    sql`update "procedure_code" set "display" = 'Resina una superficie anterior'
        where "system_key" = 'CPMS' and "code" = 'D2330' and "version" = ${VERSION}`,
  )
})

it("la oferta propia sin plantilla congela lista vacía", async () => {
  await seedGlobals()
  const service = await withOrgContext(appDb, "org_a", (tx) =>
    createService(tx, "org_a", ACTOR, {
      name: "Limpieza especial propia",
      specialty: "prevencion",
      scope: "general",
      priceCents: 12000,
    }),
  )
  const patient = await withOrgContext(appDb, "org_a", (tx) =>
    createPatient(tx, "org_a", ACTOR, { displayName: "Oferta Propia" }),
  )
  const draft = await withOrgContext(appDb, "org_a", (tx) =>
    createEncounter(tx, "org_a", ACTOR, patient.id, { reason: "Chequeo" }),
  )
  const plan = await withOrgContext(appDb, "org_a", (tx) =>
    createTreatmentPlan(tx, "org_a", ACTOR, patient.id, {
      title: "Plan propio",
      originEncounterId: draft.id,
    }),
  )
  const item = await withOrgContext(appDb, "org_a", (tx) =>
    addPlanItem(tx, "org_a", ACTOR, patient.id, {
      serviceId: service.id,
      planId: plan.id,
      sourceEncounterId: draft.id,
    }),
  )
  expect(item.codings).toEqual([])
})

it("presupuesto y atención heredan el snapshot exacto del ítem", async () => {
  const { resinaService, patient, draft, plan } = await setupCase("Herencia Snapshot")
  const item = await withOrgContext(appDb, "org_a", (tx) =>
    addPlanItem(tx, "org_a", ACTOR, patient.id, {
      serviceId: resinaService.id,
      planId: plan.id,
      sourceEncounterId: draft.id,
      toothNumber: 36,
      surfaces: ["occlusal"],
    }),
  )
  const budget = await withOrgContext(appDb, "org_a", (tx) =>
    createBudget(tx, "org_a", ACTOR, patient.id, { planId: plan.id, itemIds: [item.id] }),
  )
  expect(budget.items.map((l) => l.codings)).toEqual([item.codings])
  await withOrgContext(appDb, "org_a", (tx) =>
    presentBudget(tx, "org_a", ACTOR, patient.id, budget.id),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    decideBudget(tx, "org_a", ACTOR, patient.id, budget.id, {
      acceptedItemIds: [item.id],
      acceptedByName: "Paciente Test",
    }),
  )
  const procedure = await withOrgContext(appDb, "org_a", (tx) =>
    addEncounterProcedure(tx, "org_a", ACTOR, patient.id, draft.id, { planItemId: item.id }),
  )
  expect(procedure.codings).toEqual(item.codings)
  expect(procedure.codings.map((c) => c.code)).toEqual(["D2330"])
})

it("acto directo valida minmax de la plantilla y congela snapshot único", async () => {
  const { resinaService, patient, draft } = await setupCase("Acto Directo MinMax")
  // D2330 es de una superficie (minmax 1): dos superficies se rechazan.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addEncounterProcedure(tx, "org_a", ACTOR, patient.id, draft.id, {
        serviceId: resinaService.id,
        toothNumber: 36,
        surfaces: ["occlusal", "mesial"],
      }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION", status: 400 })
  const procedure = await withOrgContext(appDb, "org_a", (tx) =>
    addEncounterProcedure(tx, "org_a", ACTOR, patient.id, draft.id, {
      serviceId: resinaService.id,
      toothNumber: 36,
      surfaces: ["occlusal"],
    }),
  )
  expect(procedure.codings).toHaveLength(1)
  expect(procedure.codings[0]).toMatchObject({ system: "CPMS", code: "D2330", version: VERSION })
})

it("cambio de servicio recodifica la nueva indicación; el presentado es inmutable", async () => {
  const { fluorService, resinaService, patient, draft, plan } = await setupCase("Recodifica")
  const item = await withOrgContext(appDb, "org_a", (tx) =>
    addPlanItem(tx, "org_a", ACTOR, patient.id, {
      serviceId: fluorService.id,
      planId: plan.id,
      sourceEncounterId: draft.id,
    }),
  )
  expect(item.codings.map((c) => c.code)).toEqual(["D1208"])
  const budget = await withOrgContext(appDb, "org_a", (tx) =>
    createBudget(tx, "org_a", ACTOR, patient.id, { planId: plan.id, itemIds: [item.id] }),
  )
  const updated = await withOrgContext(appDb, "org_a", (tx) =>
    updatePlanItem(tx, "org_a", ACTOR, patient.id, item.id, {
      encounterId: draft.id,
      serviceId: resinaService.id,
      toothNumber: 36,
      surfaces: ["occlusal"],
    }),
  )
  expect(updated.codings.map((c) => c.code)).toEqual(["D2330"])
  const detail = await withOrgContext(appDb, "org_a", (tx) =>
    getBudgetDetail(tx, "org_a", patient.id, budget.id),
  )
  expect(detail.items.find((l) => l.planItemId === item.id)?.codings.map((c) => c.code)).toEqual([
    "D2330",
  ])
  await withOrgContext(appDb, "org_a", (tx) =>
    presentBudget(tx, "org_a", ACTOR, patient.id, budget.id),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      updatePlanItem(tx, "org_a", ACTOR, patient.id, item.id, {
        encounterId: draft.id,
        serviceId: fluorService.id,
      }),
    ),
  ).rejects.toMatchObject({ code: "ITEM_CLOSED" })
})

it("segunda equivalencia viola el constraint único (una plantilla, un código)", async () => {
  const { resinaId } = await seedGlobals()
  const error = await ownerDb
    .execute(
      sql`insert into "treatment_template_code" ("template_id", "system_key", "code", "version", "is_primary")
          values (${resinaId}, 'CPMS', 'D2391', ${VERSION}, false)`,
    )
    .then(
      () => null,
      (e: unknown) => e,
    )
  expect(error).toBeTruthy()
  expect(isUniqueViolation(error)).toBe(true)
})

it("nueva indicación rechaza plantilla retirada o sin mapping", async () => {
  const { resinaId, resinaService, patient, draft, plan } = await setupCase("Rechazo")
  // Biblioteca retirada: plantilla inactiva.
  await ownerDb.execute(
    sql`update "treatment_template" set "is_active" = false where "id" = ${resinaId}`,
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addPlanItem(tx, "org_a", ACTOR, patient.id, {
        serviceId: resinaService.id,
        planId: plan.id,
        sourceEncounterId: draft.id,
        toothNumber: 36,
        surfaces: ["occlusal"],
      }),
    ),
  ).rejects.toMatchObject({ code: "TEMPLATE_INACTIVE" })
  await ownerDb.execute(
    sql`update "treatment_template" set "is_active" = true where "id" = ${resinaId}`,
  )
  // Plantilla activa sin mapping: no es proyección oficial, se rechaza.
  await ownerDb.execute(
    sql`insert into "treatment_template" ("key", "name", "specialty", "scope")
        values ('prevencion:huerfana-test', 'Huerfana de prueba', 'prevencion', 'general')
        on conflict ("key") do nothing`,
  )
  const orphans = await ownerDb.execute<{ id: string }>(
    sql`select "id" from "treatment_template" where "key" = 'prevencion:huerfana-test'`,
  )
  const orphanId = (orphans as unknown as Array<{ id: string }>)[0]?.id
  expect(orphanId).toBeTruthy()
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createService(tx, "org_a", ACTOR, { templateId: orphanId, priceCents: 5000 }),
    ),
  ).rejects.toMatchObject({ code: "TEMPLATE_INACTIVE" })
  await ownerDb.execute(
    sql`delete from "treatment_template" where "key" = 'prevencion:huerfana-test'`,
  )
})

it("release retirada: biblioteca vacía y nueva indicación rechazada", async () => {
  const { resinaService, patient, draft, plan } = await setupCase("Release Retirada")
  await ownerDb.execute(
    sql`update "procedure_catalog_release" set "is_current" = false
        where "system_key" = 'CPMS' and "version" = ${VERSION}`,
  )
  const empty = await withOrgContext(appDb, "org_a", (tx) => listTemplates(tx, {}))
  expect(empty).toMatchObject({ data: [], nextCursor: null, total: 0, catalog: null })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addPlanItem(tx, "org_a", ACTOR, patient.id, {
        serviceId: resinaService.id,
        planId: plan.id,
        sourceEncounterId: draft.id,
        toothNumber: 36,
        surfaces: ["occlusal"],
      }),
    ),
  ).rejects.toMatchObject({ code: "TEMPLATE_INACTIVE" })
  await ownerDb.execute(
    sql`update "procedure_catalog_release" set "is_current" = true
        where "system_key" = 'CPMS' and "version" = ${VERSION}`,
  )
})

it("ejecutar un plan antiguo con snapshot ambiguo falla sin elegir principal", async () => {
  const { resinaService, patient, draft, plan } = await setupCase("Ejecución Ambigua")
  const item = await withOrgContext(appDb, "org_a", (tx) =>
    addPlanItem(tx, "org_a", ACTOR, patient.id, {
      serviceId: resinaService.id,
      planId: plan.id,
      sourceEncounterId: draft.id,
      toothNumber: 36,
      surfaces: ["occlusal"],
    }),
  )
  const budget = await withOrgContext(appDb, "org_a", (tx) =>
    createBudget(tx, "org_a", ACTOR, patient.id, { planId: plan.id, itemIds: [item.id] }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    presentBudget(tx, "org_a", ACTOR, patient.id, budget.id),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    decideBudget(tx, "org_a", ACTOR, patient.id, budget.id, {
      acceptedItemIds: [item.id],
      acceptedByName: "Paciente Test",
    }),
  )
  // Simula el histórico heredado con varias equivalencias congeladas.
  await ownerDb.execute(
    sql`update "treatment_plan_item"
        set "codings" = ${JSON.stringify([
          { system: "CPMS", code: "D2330", version: VERSION, display: "Resina anterior" },
          { system: "CPMS", code: "D2391", version: VERSION, display: "Resina posterior" },
        ])}::jsonb
        where "id" = ${item.id}`,
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      addEncounterProcedure(tx, "org_a", ACTOR, patient.id, draft.id, { planItemId: item.id }),
    ),
  ).rejects.toMatchObject({ code: "CODING_AMBIGUOUS" })
  // El guardia puro tampoco factura múltiples actos.
  expect(() =>
    assertExecutableCodings([
      { system: "CPMS", code: "D2330", version: VERSION, display: "A" },
      { system: "CPMS", code: "D2391", version: VERSION, display: "B" },
    ]),
  ).toThrow(expect.objectContaining({ code: "CODING_AMBIGUOUS" }))
  expect(() =>
    assertExecutableCodings([{ system: "CPMS", code: "D2330", version: VERSION, display: "A" }]),
  ).not.toThrow()
})

it("el rol app no escribe los catálogos globales", async () => {
  await seedGlobals()
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.insert(procedureCode).values({
        systemKey: "CPMS",
        code: "D9999",
        version: VERSION,
        display: "Intruso",
      }),
    ),
  ).rejects.toThrow()
})
