import { clinicalProfileFor } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { procedureCode, procedureCodeSystem, treatmentTemplate } from "@odentia/db/schema/clinical"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget, getBudgetDetail } from "./budgets.js"
import { addEncounterProcedure, createEncounter } from "./encounters.js"
import { addPlanItem, createTreatmentPlan, listPlanItems, updatePlanItem } from "./plan.js"
import { assertExecutableCodings, resolveServiceCodings } from "./procedure-codings.js"
import { createPatient } from "./patients.js"
import { createService, listTemplates } from "./service-catalog.js"
import { librarySpecialtyIds } from "./specialties.js"
import { isUniqueViolation } from "./errors.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ACTOR = "u-coding-tests"
const VERSION = "RM-550-2023-MINSA"
// Las clínicas de prueba son del Perú: la CPMS es obligatoria (ADR 0067).
const LIST = clinicalProfileFor("PE").services

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
        key: "aplicacion-topica-de-fluor-test",
        name: "Aplicación tópica de flúor (test)",
        kind: "prevencion",
        scope: "general",
      },
      {
        key: "resina-una-superficie-test",
        name: "Resina de una superficie (test)",
        kind: "restauradora",
        scope: "surfaces",
        surfaceCountMin: 1,
        surfaceCountMax: 1,
      },
    ])
    .onConflictDoNothing()
  const templates = await ownerDb.execute<{ id: string; key: string }>(
    sql`select "id", "key" from "treatment_template"
        where "key" in ('aplicacion-topica-de-fluor-test', 'resina-una-superficie-test')`,
  )
  const byKey = new Map(
    (templates as unknown as { id: string; key: string }[]).map((t) => [t.key, t.id]),
  )
  const fluorId = byKey.get("aplicacion-topica-de-fluor-test")!
  const resinaId = byKey.get("resina-una-superficie-test")!
  expect(fluorId).toBeTruthy()
  expect(resinaId).toBeTruthy()
  // Un código por tratamiento en cada edición de una lista.
  await ownerDb.execute(
    sql`insert into "treatment_template_code" ("template_id", "system_key", "code", "version")
        values (${fluorId}, 'CPMS', 'D1208', ${VERSION}),
               (${resinaId}, 'CPMS', 'D2330', ${VERSION})
        on conflict ("template_id", "system_key", "version") do nothing`,
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

it("biblioteca del país: paginada, con el código de su lista y filtrada por tipo", async () => {
  await seedGlobals()
  const first = await withOrgContext(appDb, "org_a", (tx) => listTemplates(tx, "org_a", { limit: 1 }))
  expect(first.total).toBe(2)
  expect(first.data).toHaveLength(1)
  expect(first.nextCursor).toBeTruthy()
  expect(first.codeList).toEqual({ system: "CPMS", required: true })
  expect(first.data[0]?.codings).toHaveLength(1)
  const second = await withOrgContext(appDb, "org_a", (tx) =>
    listTemplates(tx, "org_a", { limit: 1, cursor: first.nextCursor! }),
  )
  expect(second.data).toHaveLength(1)
  expect(second.data[0]?.id).not.toBe(first.data[0]?.id)
  // Búsqueda por código oficial.
  const byCode = await withOrgContext(appDb, "org_a", (tx) => listTemplates(tx, "org_a", { q: "D1208" }))
  expect(byCode.total).toBe(1)
  expect(byCode.data.map((t) => t.codings[0]?.code)).toEqual(["D1208"])
  // Filtro por tipo de tratamiento.
  const byKind = await withOrgContext(appDb, "org_a", (tx) =>
    listTemplates(tx, "org_a", { kind: "prevencion" }),
  )
  expect(byKind.total).toBe(1)
  expect(byKind.data.map((t) => t.codings[0]?.code)).toEqual(["D1208"])
  await expect(
    withOrgContext(appDb, "org_a", (tx) => listTemplates(tx, "org_a", { kind: "inventado" })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
})

it("el ítem del plan congela el snapshot exacto y no sigue al catálogo", async () => {
  const { resinaService, patient, draft, plan } = await setupCase("Snapshot Congelado")
  const snapshot = await withOrgContext(appDb, "org_a", (tx) =>
    resolveServiceCodings(tx, LIST, resinaService),
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

it("un servicio propio lleva el código que elige la clínica y lo congela", async () => {
  const { fluorId } = await seedGlobals()
  const specialtyId = await withOrgContext(appDb, "org_a", async (tx) =>
    (await librarySpecialtyIds(tx, "org_a", ["prevencion"])).get("prevencion")!,
  )
  const own = { name: "Limpieza especial propia", specialtyId, scope: "general", priceCents: 12000 }
  // En el Perú la lista es obligatoria: sin código o con uno que no está, no se crea.
  await expect(
    withOrgContext(appDb, "org_a", (tx) => createService(tx, "org_a", ACTOR, own)),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createService(tx, "org_a", ACTOR, { ...own, officialCode: "D9999" }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  const service = await withOrgContext(appDb, "org_a", (tx) =>
    createService(tx, "org_a", ACTOR, { ...own, officialCode: "d1206" }),
  )
  expect(service).toMatchObject({
    procedureSystem: "CPMS",
    procedureCode: "D1206",
    procedureVersion: VERSION,
  })
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
  expect(item.codings).toEqual([
    { system: "CPMS", code: "D1206", version: VERSION, display: "Aplicación de flúor barniz" },
  ])
  // Uno de la biblioteca toma el código de su tratamiento: no admite otro.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createService(tx, "org_a", ACTOR, { templateId: fluorId, officialCode: "D1206", priceCents: 1 }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
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
    deliverBudget(tx, "org_a", ACTOR, patient.id, budget.id),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    decideBudget(tx, "org_a", ACTOR, patient.id, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
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
    deliverBudget(tx, "org_a", ACTOR, patient.id, budget.id),
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

it("un segundo código de la misma lista viola el constraint único", async () => {
  const { resinaId } = await seedGlobals()
  const error = await ownerDb
    .execute(
      sql`insert into "treatment_template_code" ("template_id", "system_key", "code", "version")
          values (${resinaId}, 'CPMS', 'D2391', ${VERSION})`,
    )
    .then(
      () => null,
      (e: unknown) => e,
    )
  expect(error).toBeTruthy()
  expect(isUniqueViolation(error)).toBe(true)
})

it("la biblioteca no agrega un tratamiento retirado ni uno sin código en la lista", async () => {
  const { resinaId } = await seedGlobals()
  await ownerDb.execute(
    sql`update "treatment_template" set "is_active" = false where "id" = ${resinaId}`,
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createService(tx, "org_a", ACTOR, { templateId: resinaId, priceCents: 5000 }),
    ),
  ).rejects.toMatchObject({ code: "TEMPLATE_INACTIVE" })
  await ownerDb.execute(
    sql`update "treatment_template" set "is_active" = true where "id" = ${resinaId}`,
  )
  // Activo pero sin código CPMS: en el Perú no se ofrece ni se agrega.
  await ownerDb.execute(
    sql`insert into "treatment_template" ("key", "name", "specialty", "scope")
        values ('huerfana-test', 'Huérfana de prueba', 'prevencion', 'general')
        on conflict ("key") do nothing`,
  )
  const orphans = await ownerDb.execute<{ id: string }>(
    sql`select "id" from "treatment_template" where "key" = 'huerfana-test'`,
  )
  const orphanId = (orphans as unknown as Array<{ id: string }>)[0]?.id
  expect(orphanId).toBeTruthy()
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      createService(tx, "org_a", ACTOR, { templateId: orphanId, priceCents: 5000 }),
    ),
  ).rejects.toMatchObject({ code: "TEMPLATE_UNCODED" })
  const listed = await withOrgContext(appDb, "org_a", (tx) => listTemplates(tx, "org_a", {}))
  expect(listed.data.map((t) => t.key)).not.toContain("huerfana-test")
  await ownerDb.execute(sql`delete from "treatment_template" where "key" = 'huerfana-test'`)
})

it("edición retirada: biblioteca vacía y la indicación sigue, sin código", async () => {
  const { resinaService, patient, draft, plan } = await setupCase("Release Retirada")
  await ownerDb.execute(
    sql`update "procedure_catalog_release" set "is_current" = false
        where "system_key" = 'CPMS' and "version" = ${VERSION}`,
  )
  const empty = await withOrgContext(appDb, "org_a", (tx) => listTemplates(tx, "org_a", {}))
  expect(empty).toMatchObject({
    data: [],
    nextCursor: null,
    total: 0,
    codeList: { system: "CPMS", required: true },
  })
  // La consulta no se detiene: se indica sin código y Servicios lo avisa.
  const item = await withOrgContext(appDb, "org_a", (tx) =>
    addPlanItem(tx, "org_a", ACTOR, patient.id, {
      serviceId: resinaService.id,
      planId: plan.id,
      sourceEncounterId: draft.id,
      toothNumber: 36,
      surfaces: ["occlusal"],
    }),
  )
  expect(item.codings).toEqual([])
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
    deliverBudget(tx, "org_a", ACTOR, patient.id, budget.id),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    decideBudget(tx, "org_a", ACTOR, patient.id, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
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
