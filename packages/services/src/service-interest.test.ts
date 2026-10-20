/**
 * Fase 4, paso 1: el interés de quien pregunta por un servicio lo anota el
 * sistema (decisión 15) y «Cómo dice el precio» se elige una vez para todo lo
 * que se agrega o se cambia para varios a la vez (decisión 5).
 */
import { seedProcedureCodes, withOrgContext } from "@odentia/db"
import { auditEvent } from "@odentia/db/schema/org"
import { opportunity } from "@odentia/db/schema/opportunities"
import { patientContact, serviceCatalog } from "@odentia/db/schema/clinical"
import { and, eq, inArray } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { getOpportunity, noteServiceInterest } from "./opportunities.js"
import { addPlanItem } from "./plan.js"
import { quickAddServices, setServicesPriceDisclosure } from "./service-catalog.js"
import { librarySpecialtyIds } from "./specialties.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function ownContact(patientId: string): Promise<string> {
  const [link] = await ownerDb
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.patientId, patientId), eq(patientContact.relationship, "self")))
  return link!.contactId
}

it("preguntar por un servicio crea la oportunidad en «Interesado», de Recepción, y la segunda vez la actualiza sin duplicar", async () => {
  const f = await clinicalFixture()
  const contactId = await ownContact(f.patient.id)
  const first = await f.run((tx) =>
    noteServiceInterest(tx, "org_a", {
      contactId,
      conversationId: null,
      serviceId: f.service.id,
      said: "¿Cuánto cuesta el tratamiento?",
    }),
  )
  expect(first.outcome).toBe("creada")
  const created = await f.run((tx) => getOpportunity(tx, "org_a", first.opportunityId!))
  // Sin responsable es de Recepción; el valor sale de la lista de precios.
  expect(created).toMatchObject({
    moment: "interesado",
    assignedUserId: null,
    serviceId: f.service.id,
    interestText: "¿Cuánto cuesta el tratamiento?",
    amountCents: 120000,
  })
  expect(created.history.at(-1)).toMatchObject({ origin: "agente" })

  const again = await f.run((tx) =>
    noteServiceInterest(tx, "org_a", {
      contactId,
      conversationId: null,
      serviceId: f.service.id,
      said: "¿Y lo hacen los sábados?",
    }),
  )
  expect(again).toEqual({ outcome: "actualizada", opportunityId: first.opportunityId })
  const open = await ownerDb
    .select({ id: opportunity.id, interestText: opportunity.interestText })
    .from(opportunity)
    .where(
      and(
        eq(opportunity.contactId, contactId),
        eq(opportunity.serviceId, f.service.id),
        eq(opportunity.status, "open"),
      ),
    )
  expect(open).toEqual([{ id: first.opportunityId, interestText: "¿Y lo hacen los sábados?" }])
})

it("con un presupuesto aceptado que incluye el servicio no anota nada", async () => {
  const f = await clinicalFixture()
  const contactId = await ownContact(f.patient.id)
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
    }),
  )
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  const before = await ownerDb
    .select({ id: opportunity.id })
    .from(opportunity)
    .where(and(eq(opportunity.contactId, contactId), eq(opportunity.status, "open")))
  const noted = await f.run((tx) =>
    noteServiceInterest(tx, "org_a", {
      contactId,
      conversationId: null,
      serviceId: f.service.id,
      said: "¿Cuánto costaba?",
    }),
  )
  expect(noted).toEqual({ outcome: "ya_aceptado", opportunityId: null })
  const after = await ownerDb
    .select({ id: opportunity.id })
    .from(opportunity)
    .where(and(eq(opportunity.contactId, contactId), eq(opportunity.status, "open")))
  expect(after).toEqual(before)
})

it("«Cómo dice el precio» se cambia para varios servicios a la vez, solo de la propia clínica", async () => {
  const f = await clinicalFixture()
  const rows = await ownerDb
    .insert(serviceCatalog)
    .values(
      ["Uno", "Dos", "Tres"].map((name) => ({
        organizationId: "org_a",
        name: `Bloque ${name} ${f.actor.slice(0, 6)}`,
        scope: "general",
        source: "custom",
        priceCents: 10000,
        currency: "PEN",
        priceDisclosure: "evaluacion",
      })),
    )
    .returning({ id: serviceCatalog.id })
  const ids = rows.map((row) => row.id)
  const run = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, "org_a", fn)
  expect(
    await run((tx) =>
      setServicesPriceDisclosure(tx, "org_a", f.actor, {
        serviceIds: ids,
        priceDisclosure: "desde",
      }),
    ),
  ).toEqual({ updated: 3 })
  const after = await ownerDb
    .select({ disclosure: serviceCatalog.priceDisclosure })
    .from(serviceCatalog)
    .where(inArray(serviceCatalog.id, ids))
  expect(after.map((row) => row.disclosure)).toEqual(["desde", "desde", "desde"])
  const audited = await ownerDb
    .select({ id: auditEvent.id })
    .from(auditEvent)
    .where(and(eq(auditEvent.action, "catalog.service_updated"), inArray(auditEvent.entityId, ids)))
  expect(audited).toHaveLength(3)
  // Un servicio ajeno (o inexistente) en la lista: no se cambia ninguno.
  await expect(
    run((tx) =>
      setServicesPriceDisclosure(tx, "org_a", f.actor, {
        serviceIds: [...ids, "00000000-0000-4000-8000-000000000001"],
        priceDisclosure: "exacto",
      }),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" })
  expect(
    (
      await ownerDb
        .select({ disclosure: serviceCatalog.priceDisclosure })
        .from(serviceCatalog)
        .where(inArray(serviceCatalog.id, ids))
    ).map((row) => row.disclosure),
  ).toEqual(["desde", "desde", "desde"])
  await expect(
    run((tx) =>
      setServicesPriceDisclosure(tx, "org_a", f.actor, {
        serviceIds: ids,
        priceDisclosure: "gratis",
      }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
})

it("lo que se agrega de una vez dice el precio como se eligió al agregarlo", async () => {
  const f = await clinicalFixture()
  const run = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, "org_a", fn)
  // En el Perú cada servicio propio lleva su código CPMS (ADR 0067).
  await seedProcedureCodes(ownerDb)
  const added = await run(async (tx) =>
    quickAddServices(
      tx,
      "org_a",
      f.actor,
      [
        {
          kind: "custom",
          name: `Agregado ${f.actor.slice(0, 6)}`,
          specialtyId: (await librarySpecialtyIds(tx, "org_a", ["general"])).get("general")!,
          scope: "general",
          priceCents: 9000,
          officialCode: "D0150",
        },
      ],
      { priceDisclosure: "exacto" },
    ),
  )
  expect(added.created.map((row) => row.priceDisclosure)).toEqual(["exacto"])
  // Sin elegir, como cualquier servicio nuevo, nace «Solo con evaluación».
  const plain = await run(async (tx) =>
    quickAddServices(tx, "org_a", f.actor, [
      {
        kind: "custom",
        name: `Sin elegir ${f.actor.slice(0, 6)}`,
        specialtyId: (await librarySpecialtyIds(tx, "org_a", ["general"])).get("general")!,
        scope: "general",
        priceCents: 9000,
        officialCode: "D0150",
      },
    ]),
  )
  expect(plain.created.map((row) => row.priceDisclosure)).toEqual(["evaluacion"])
})
