import { withOrgContext } from "@odentia/db"
import { treatmentBudget, treatmentPlan, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { consentDocument, consentTemplate } from "@odentia/db/schema/clinical-forms"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  addClinicalNote,
  correctDocumentContext,
  getCurrentDocumentContexts,
  getPatientDocument,
  getPatientDocumentWithHistory,
  listDocumentContextHistory,
  listEncounterDocuments,
  listPatientDocuments,
  registerPatientDocument,
} from "./clinical.js"
import { makeSigner, readyToClose } from "./clinical-test-fixture.js"
import { addEncounterProcedure, createEncounter, finalizeEncounter } from "./encounters.js"
import { createPatient } from "./patients.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ACTOR = "u-tests"

async function seedUser(): Promise<void> {
  await ownerDb.execute(
    sql`insert into "user" ("id", "name", "email") values (${ACTOR}, 'Tests', 'tests@example.com')
        on conflict ("id") do nothing`,
  )
  await makeSigner("org_a", ACTOR)
  await makeSigner("org_b", ACTOR)
}

async function seedPatient(org: string, name: string) {
  return withOrgContext(appDb, org, (tx) => createPatient(tx, org, ACTOR, { displayName: name }))
}

function docInput(label: string) {
  return {
    category: "radiografia",
    label,
    storageKey: `key-${label}`,
    contentType: "image/png",
    sizeBytes: 128,
  }
}

/** Presupuesto mínimo para validar vínculos documentales con tratamientos. */
async function seedPlanItem(org: string, patientId: string, title: string): Promise<string> {
  return withOrgContext(appDb, org, async (tx) => {
    const [plan] = await tx
      .insert(treatmentPlan)
      .values({ organizationId: org, patientId, title: "Plan", createdBy: ACTOR })
      .returning()
    const [budget] = await tx
      .insert(treatmentBudget)
      .values({
        organizationId: org,
        patientId,
        planId: plan!.id,
        budgetNumber: 1,
        title: "Presupuesto",
        currency: "PEN",
        status: "borrador",
        createdBy: ACTOR,
      })
      .returning()
    const [item] = await tx
      .insert(treatmentPlanItem)
      .values({
        organizationId: org,
        patientId,
        planId: plan!.id,
        budgetId: budget!.id,
        title,
        currency: "PEN",
        status: "pendiente",
        createdBy: ACTOR,
      })
      .returning()
    return item!.id
  })
}

async function seedClosedEncounter(
  org: string,
  patientId: string,
  reason: string,
): Promise<string> {
  const draft = await withOrgContext(appDb, org, (tx) =>
    createEncounter(tx, org, ACTOR, patientId, { reason, teeth: [36] }),
  )
  await withOrgContext(appDb, org, (tx) =>
    addClinicalNote(tx, org, ACTOR, patientId, {
      note: "Evolución de cierre",
      encounterId: draft.id,
    }),
  )
  await readyToClose(org, ACTOR, patientId, draft.id)
  const closed = await withOrgContext(appDb, org, (tx) =>
    finalizeEncounter(tx, org, ACTOR, patientId, draft.id),
  )
  expect(closed.encounter.status).toBe("finalizada")
  return closed.encounter.id
}

it("registra documento general y vinculado con contexto v1 fusionado", async () => {
  await seedUser()
  const p = await seedPatient("org_a", "Doc General")
  const general = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatientDocument(tx, "org_a", ACTOR, p.id, docInput("general")),
  )
  expect(general.contextVersion).toBe(1)
  expect(general.encounterId).toBeNull()
  expect(general.planItemId).toBeNull()
  expect(general.toothNumbers).toEqual([])
  expect(general.tags).toEqual([])

  const draft = await withOrgContext(appDb, "org_a", (tx) =>
    createEncounter(tx, "org_a", ACTOR, p.id, { reason: "control", teeth: [36] }),
  )
  const planItemId = await seedPlanItem("org_a", p.id, "Endodoncia 36")
  const linked = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatientDocument(tx, "org_a", ACTOR, p.id, {
      ...docInput("rx-36"),
      encounterId: draft.id,
      planItemId,
      toothNumbers: [36, 36, 11],
      tags: ["TAG", " tag ", "tag_1"],
    }),
  )
  expect(linked.contextVersion).toBe(1)
  expect(linked.encounterId).toBe(draft.id)
  expect(linked.planItemId).toBe(planItemId)
  expect(linked.toothNumbers).toEqual([11, 36])
  // Etiquetas canónicas con el helper compartido: dedup + guionización.
  expect(linked.tags).toEqual(["tag", "tag-1"])

  const listed = await withOrgContext(appDb, "org_a", (tx) =>
    listPatientDocuments(tx, "org_a", p.id),
  )
  expect(listed).toHaveLength(2)
  const found = listed.find((doc) => doc.id === linked.id)!
  expect(found).toMatchObject({ encounterId: draft.id, planItemId, contextVersion: 1 })
  expect(found.toothNumbers).toEqual([11, 36])
})

it("corrige el contexto y el historial conserva el original inmutable", async () => {
  await seedUser()
  const p = await seedPatient("org_a", "Doc Historial")
  const created = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatientDocument(tx, "org_a", ACTOR, p.id, {
      ...docInput("rx-h"),
      toothNumbers: [36],
      tags: ["inicial"],
    }),
  )
  const corrected = await withOrgContext(appDb, "org_a", (tx) =>
    correctDocumentContext(tx, "org_a", ACTOR, p.id, created.id, {
      expectedVersion: 1,
      toothNumbers: [36, 46],
      tags: ["corregida"],
    }),
  )
  expect(corrected.contextVersion).toBe(2)
  expect(corrected.toothNumbers).toEqual([36, 46])
  // El blob y la clasificación original no se tocan.
  expect(corrected).toMatchObject({
    storageKey: created.storageKey,
    label: created.label,
    category: created.category,
  })

  const history = await withOrgContext(appDb, "org_a", (tx) =>
    listDocumentContextHistory(tx, "org_a", p.id, created.id),
  )
  expect(history.map((ctx) => ctx.version)).toEqual([1, 2])
  expect(history[0]!.toothNumbers).toEqual([36])
  expect(history[0]!.tags).toEqual(["inicial"])

  const detail = await withOrgContext(appDb, "org_a", (tx) =>
    getPatientDocumentWithHistory(tx, "org_a", p.id, created.id),
  )
  expect(detail.document.contextVersion).toBe(2)
  expect(detail.history).toHaveLength(2)
})

it("revisiones simultáneas conservan una sola versión y rechazan la perdedora con 409", async () => {
  await seedUser()
  const p = await seedPatient("org_a", "Doc Stale")
  const created = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatientDocument(tx, "org_a", ACTOR, p.id, { ...docInput("rx-s"), tags: ["v1"] }),
  )
  const attempts = await Promise.allSettled(
    ["v2-a", "v2-b"].map((tag) =>
      withOrgContext(appDb, "org_a", (tx) =>
        correctDocumentContext(tx, "org_a", ACTOR, p.id, created.id, {
          expectedVersion: 1,
          tags: [tag],
        }),
      ),
    ),
  )
  const winners = attempts.filter((result) => result.status === "fulfilled")
  const losers = attempts.filter((result) => result.status === "rejected")
  expect(winners).toHaveLength(1)
  expect(losers).toHaveLength(1)
  expect(losers[0]!.reason).toMatchObject({ code: "STALE_VERSION", status: 409 })

  const current = await withOrgContext(appDb, "org_a", (tx) =>
    getPatientDocument(tx, "org_a", p.id, created.id),
  )
  expect(current.contextVersion).toBe(2)
  expect(current.tags).toEqual(winners[0]!.value.tags)
  const history = await withOrgContext(appDb, "org_a", (tx) =>
    listDocumentContextHistory(tx, "org_a", p.id, created.id),
  )
  expect(history).toHaveLength(2)
})

it("rechaza vínculos de otro paciente u organización", async () => {
  await seedUser()
  const p = await seedPatient("org_a", "Doc Propio")
  const other = await seedPatient("org_a", "Doc Ajeno")
  const foreignDraft = await withOrgContext(appDb, "org_a", (tx) =>
    createEncounter(tx, "org_a", ACTOR, other.id, { reason: "ajeno" }),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatientDocument(tx, "org_a", ACTOR, p.id, {
        ...docInput("rx-x"),
        encounterId: foreignDraft.id,
      }),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatientDocument(tx, "org_a", ACTOR, p.id, {
        ...docInput("rx-y"),
        planItemId: "00000000-0000-4000-8000-000000000000",
      }),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })

  const created = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatientDocument(tx, "org_a", ACTOR, p.id, docInput("rx-z")),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      correctDocumentContext(tx, "org_a", ACTOR, p.id, created.id, {
        expectedVersion: 1,
        encounterId: foreignDraft.id,
      }),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 })
  await expect(
    withOrgContext(appDb, "org_b", (tx) => getPatientDocument(tx, "org_b", p.id, created.id)),
  ).rejects.toMatchObject({ status: 404 })
})

it("vincula atención cerrada como corrección auditada sin mutar la clínica", async () => {
  await seedUser()
  const p = await seedPatient("org_a", "Doc Cerrada")
  const closedId = await seedClosedEncounter("org_a", p.id, "urgencia")
  const created = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatientDocument(tx, "org_a", ACTOR, p.id, docInput("rx-c")),
  )
  // Registrar contra una cerrada sigue bloqueado: solo la corrección puede vincularla.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      registerPatientDocument(tx, "org_a", ACTOR, p.id, {
        ...docInput("rx-c2"),
        encounterId: closedId,
      }),
    ),
  ).rejects.toMatchObject({ code: "FINALIZED", status: 409 })

  const corrected = await withOrgContext(appDb, "org_a", (tx) =>
    correctDocumentContext(tx, "org_a", ACTOR, p.id, created.id, {
      expectedVersion: 1,
      encounterId: closedId,
    }),
  )
  expect(corrected.encounterId).toBe(closedId)
  expect(corrected.contextVersion).toBe(2)

  const docs = await withOrgContext(appDb, "org_a", (tx) =>
    listEncounterDocuments(tx, "org_a", p.id, closedId),
  )
  expect(docs.map((doc) => doc.id)).toContain(created.id)
})

it("listEncounterDocuments e hidratación por lote siguen el contexto vigente", async () => {
  await seedUser()
  const p = await seedPatient("org_a", "Doc Vigente")
  const encounterA = await withOrgContext(appDb, "org_a", (tx) =>
    createEncounter(tx, "org_a", ACTOR, p.id, { reason: "A" }),
  )
  const created = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatientDocument(tx, "org_a", ACTOR, p.id, {
      ...docInput("rx-v"),
      encounterId: encounterA.id,
    }),
  )
  await withOrgContext(appDb, "org_a", async (tx) => {
    await addClinicalNote(tx, "org_a", ACTOR, p.id, {
      note: "Cierre de A",
      encounterId: encounterA.id,
    })
    await addEncounterProcedure(tx, "org_a", ACTOR, p.id, encounterA.id, {
      description: "Revisión clínica",
    })
  })
  await readyToClose("org_a", ACTOR, p.id, encounterA.id)
  await withOrgContext(appDb, "org_a", (tx) =>
    finalizeEncounter(tx, "org_a", ACTOR, p.id, encounterA.id),
  )
  const encounterB = await withOrgContext(appDb, "org_a", (tx) =>
    createEncounter(tx, "org_a", ACTOR, p.id, { reason: "B" }),
  )
  await withOrgContext(appDb, "org_a", (tx) =>
    correctDocumentContext(tx, "org_a", ACTOR, p.id, created.id, {
      expectedVersion: 1,
      encounterId: encounterB.id,
    }),
  )
  const inA = await withOrgContext(appDb, "org_a", (tx) =>
    listEncounterDocuments(tx, "org_a", p.id, encounterA.id),
  )
  expect(inA).toHaveLength(0)
  const inB = await withOrgContext(appDb, "org_a", (tx) =>
    listEncounterDocuments(tx, "org_a", p.id, encounterB.id),
  )
  expect(inB.map((doc) => doc.id)).toEqual([created.id])

  const batch = await withOrgContext(appDb, "org_a", (tx) =>
    getCurrentDocumentContexts(tx, "org_a", p.id, [
      created.id,
      "00000000-0000-4000-8000-000000000000",
    ]),
  )
  expect(batch.get(created.id)?.version).toBe(2)
  expect(batch.get(created.id)?.encounterId).toBe(encounterB.id)
  expect(batch.has("00000000-0000-4000-8000-000000000000")).toBe(false)
  // Regresión: desvincular (encounterId null) también lo saca de la atención anterior.
  const unlinked = await withOrgContext(appDb, "org_a", (tx) =>
    correctDocumentContext(tx, "org_a", ACTOR, p.id, created.id, {
      expectedVersion: 2,
      encounterId: null,
    }),
  )
  expect(unlinked.encounterId).toBeNull()
  expect(unlinked.contextVersion).toBe(3)
  const inBAfter = await withOrgContext(appDb, "org_a", (tx) =>
    listEncounterDocuments(tx, "org_a", p.id, encounterB.id),
  )
  expect(inBAfter).toHaveLength(0)
})

it("corrige la fecha del documento con su motivo: la versión la guarda, el archivo la copia y nada la cambia por fuera", async () => {
  await seedUser()
  const p = await seedPatient("org_a", "Doc Fecha")
  const created = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatientDocument(tx, "org_a", ACTOR, p.id, {
      ...docInput("historia-anterior"),
      category: "informe",
      contentType: "application/pdf",
      capturedAt: "2019-03-03T17:00:00Z",
    }),
  )
  const correct = (input: Parameters<typeof correctDocumentContext>[5]) =>
    withOrgContext(appDb, "org_a", (tx) => correctDocumentContext(tx, "org_a", ACTOR, p.id, created.id, input))
  // Cambiarla pide su motivo, y nunca a una fecha futura.
  await expect(correct({ expectedVersion: 1, capturedAt: "2023-03-03T17:00:00Z" })).rejects.toMatchObject({
    fields: { dateReason: "Escribe por qué cambias la fecha." },
  })
  await expect(
    correct({ expectedVersion: 1, capturedAt: new Date(Date.now() + 86_400_000).toISOString(), dateReason: "Mañana" }),
  ).rejects.toMatchObject({ fields: { capturedAt: "La fecha del documento no puede ser futura" } })
  // Un año mal escrito (1019 por 2019) no entra.
  await expect(correct({ expectedVersion: 1, capturedAt: "1019-03-03T17:00:00Z", dateReason: "Año" })).rejects.toMatchObject({
    fields: { capturedAt: "La fecha del documento no puede ser anterior a 1900" },
  })

  const fixed = await correct({ expectedVersion: 1, capturedAt: "2023-03-03T17:00:00Z", dateReason: "Puse el año equivocado" })
  expect(fixed.contextVersion).toBe(2)
  expect(fixed.capturedAt?.toISOString()).toBe("2023-03-03T17:00:00.000Z")
  const read = await withOrgContext(appDb, "org_a", (tx) => getPatientDocument(tx, "org_a", p.id, created.id))
  expect(read.capturedAt?.toISOString()).toBe("2023-03-03T17:00:00.000Z")

  // Corregir solo los vínculos lleva la fecha vigente, sin motivo de fecha.
  await correct({ expectedVersion: 2, tags: ["historia"] })
  // Vacía, vuelve a la de subida.
  const cleared = await correct({ expectedVersion: 3, capturedAt: null, dateReason: "No tiene fecha" })
  expect(cleared.capturedAt).toBeNull()

  const history = await withOrgContext(appDb, "org_a", (tx) => listDocumentContextHistory(tx, "org_a", p.id, created.id))
  expect(history.map((v) => [v.version, v.capturedAt?.toISOString() ?? null, v.dateReason])).toEqual([
    [1, "2019-03-03T17:00:00.000Z", null],
    [2, "2023-03-03T17:00:00.000Z", "Puse el año equivocado"],
    [3, "2023-03-03T17:00:00.000Z", null],
    [4, null, "No tiene fecha"],
  ])

  // La base no deja cambiar la fecha del archivo sin su versión.
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`update patient_document set captured_at = '2020-01-01T12:00:00Z' where id = ${created.id}::uuid`),
    ),
  ).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining("versión nueva de su contexto") }) })
})

it("la fecha del PDF que generó la firma de un consentimiento no se corrige, y la base pide el motivo de toda fecha cambiada", async () => {
  await seedUser()
  const p = await seedPatient("org_a", "Doc Firma")
  const pdf = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatientDocument(tx, "org_a", ACTOR, p.id, {
      ...docInput("consentimiento-firmado"),
      category: "consentimiento",
      contentType: "application/pdf",
    }),
  )
  const [template] = await ownerDb
    .insert(consentTemplate)
    .values({ organizationId: "org_a", key: `exo-${pdf.id}`, title: "Exodoncia", body: "Texto", status: "publicado" })
    .returning()
  await ownerDb.insert(consentDocument).values({
    organizationId: "org_a",
    templateId: template!.id,
    templateVersion: 1,
    bodySnapshot: "Texto",
    titleSnapshot: "Exodoncia",
    patientId: p.id,
    signerName: "Doc Firma",
    status: "firmado",
    signedAt: new Date(),
    pdfDocumentId: pdf.id,
  })
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      correctDocumentContext(tx, "org_a", ACTOR, p.id, pdf.id, {
        expectedVersion: 1,
        capturedAt: "2026-01-05T17:00:00Z",
        dateReason: "Otra fecha",
      }),
    ),
  ).rejects.toMatchObject({ code: "DOCUMENT_DATE_FIXED" })
  // Sin el servicio: una versión con otra fecha y sin motivo no entra.
  const other = await withOrgContext(appDb, "org_a", (tx) =>
    registerPatientDocument(tx, "org_a", ACTOR, p.id, { ...docInput("rx-sin-motivo") }),
  )
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      tx.execute(sql`insert into patient_document_context (organization_id, patient_id, document_id, version, captured_at)
        values ('org_a', ${p.id}::uuid, ${other.id}::uuid, 2, '2020-01-01T12:00:00Z')`),
    ),
  ).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining("pide su motivo") }) })
})
