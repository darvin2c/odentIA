/**
 * «Actividad del equipo» (issue #112): una fila por acción, con sobre quién y
 * sobre qué. Un cobro deja su pago, su aplicación, su ticket y su movimiento de
 * caja en la misma transacción: es una sola fila. Lo de varias personas en un
 * mismo instante, una fila por persona.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { branch } from "@odentia/db/schema/org"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { collectCharge, createCharge, voidTicket } from "./payments.js"
import { createPaymentMethod } from "./payment-methods.js"
import { nextPatientNumber } from "./patients.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"
import { listWorkspaceAudit } from "./workspace.js"

setupTestDb()

const audit = (input: Parameters<typeof listWorkspaceAudit>[2] = {}) =>
  withOrgContext(appDb, "org_a", (tx) => listWorkspaceAudit(tx, "org_a", input))

it("un cobro y su anulación son una fila cada uno, con la persona y el ticket", async () => {
  const f = await clinicalFixture()
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}` }).returning()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  await f.run((tx) => createCharge(tx, ...f.args, { description: "Consulta", amountCents: 6000, currency: "PEN" }))
  await f.run((tx) => createCharge(tx, ...f.args, { description: "Radiografía", amountCents: 4000, currency: "PEN" }))
  const collected = await f.run((tx) =>
    collectCharge(tx, ...f.args, { branchId: site!.id, payments: [{ paymentMethodId: cash.id, amountCents: 10000 }], requestId: randomUUID() }),
  )
  const number = `Ticket N.º ${String(collected.ticket.ticketNumber).padStart(6, "0")}`

  const cobros = await audit({ area: "cobros" })
  const rows = cobros.items.filter((item) => item.subject?.label === number)
  // Una sola fila: lo que se hizo, y lo demás como «también».
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    action: "ticket.created",
    what: "Emitió un ticket",
    subject: { personId: f.patient.personId, patientId: f.patient.id, label: number, open: { kind: "ticket", id: collected.ticket.id } },
  })
  expect(rows[0]!.also.map((item) => item.what)).toEqual(expect.arrayContaining(["Registró un pago", "Aplicó un pago a un cargo"]))
  expect(rows[0]!.also.find((item) => item.what === "Aplicó un pago a un cargo")?.count).toBe(2)
  // Lo que no es de un cobro no se junta con él: la creación de cada cargo sigue en su fila.
  expect(cobros.items.filter((item) => item.action === "charge.created" && item.subject?.patientId === f.patient.id)).toHaveLength(2)

  await f.run((tx) => voidTicket(tx, ...f.args, collected.ticket.id, { reason: "Importe mal digitado", allowPostClose: false }))
  const voided = (await audit({ area: "cobros" })).items.filter((item) => item.subject?.label === number)
  expect(voided.map((item) => item.what)).toEqual(["Anuló un ticket", "Emitió un ticket"])
  expect(voided[0]!.also.map((item) => item.what)).toContain("Anuló un pago")

  // De una historia bloqueada no se dice el nombre (ADR 0080).
  await ownerDb.execute(sql`update contact set is_active = false, record_locked_at = now(), record_locked_by = ${f.actor} where id = ${f.patient.personId}`)
  const locked = (await audit({ area: "cobros" })).items.filter((item) => item.id === voided[0]!.id)
  expect(locked[0]?.subject).toBeNull()
})

it("lo de varias personas en un mismo instante va en una fila por persona, y la página no corta un instante", async () => {
  const a = await clinicalFixture()
  const b = await clinicalFixture()
  const at = "2026-09-30 09:00:00.000001+00"
  // Un mismo instante y quien lo hizo: dos personas y algo que no nombra a nadie.
  await ownerDb.execute(sql`insert into audit_event (organization_id, actor_user_id, action, entity, entity_id, created_at) values
    ('org_a', ${a.actor}, 'patient.updated', 'patient', ${a.patient.id}, ${at}::timestamptz),
    ('org_a', ${a.actor}, 'patient.updated', 'patient', ${b.patient.id}, ${at}::timestamptz),
    ('org_a', ${a.actor}, 'settings.region_updated', 'org_profile', null, ${at}::timestamptz)`)
  const moment = (await audit({ before: "2026-09-30T09:00:01.000000Z", beforeId: "ffffffff-ffff-4fff-bfff-ffffffffffff" })).items.filter(
    (item) => item.createdAt.startsWith("2026-09-30T09:00:00.000001"),
  )
  expect(moment.map((item) => item.subject?.patientId ?? null).sort()).toEqual([a.patient.id, b.patient.id, null].sort())

  // 60 instantes: la primera página trae 50 y la siguiente el resto, sin repetir ni saltar.
  await ownerDb.execute(sql`insert into audit_event (organization_id, action, entity, created_at)
    select 'org_a', 'paginas.prueba', 'prueba', '2026-09-01 10:00:00+00'::timestamptz + n * interval '1 second'
    from generate_series(1, 60) n`)
  const first = await audit({ action: "paginas.prueba" })
  expect(first.items).toHaveLength(50)
  const second = await audit({ action: "paginas.prueba", ...first.next! })
  expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(60)
  expect(second.next).toBeNull()
})

/** `n` pacientes de prueba en org_a, para registros que nombran a cada uno. */
async function patients(n: number): Promise<string[]> {
  const ids: string[] = []
  for (let index = 0; index < n; index++) {
    const [row] = await insertTestPatients(ownerDb, { organizationId: "org_a", displayName: `Persona ${index + 1}`, patientNumber: await nextPatientNumber(ownerDb, "org_a") })
    ids.push(row!.id)
  }
  return ids
}

/** Todas las páginas de una acción, siguiendo el cursor. */
async function allPages(action: string) {
  const pages: Awaited<ReturnType<typeof audit>>[] = []
  let next: Awaited<ReturnType<typeof audit>>["next"] = null
  do {
    const page = await audit({ action, ...(next ?? {}) })
    pages.push(page)
    next = page.next
  } while (next && pages.length < 20)
  return pages
}

it("un instante de varias personas justo en el límite de la página va entero a la siguiente", async () => {
  const [p1, p2, p3] = await patients(3)
  // 49 instantes de una acción y, antes, uno de tres personas: no cabe en la primera página.
  await ownerDb.execute(sql`insert into audit_event (organization_id, action, entity, created_at)
    select 'org_a', 'limite.prueba', 'prueba', '2026-08-01 10:00:00+00'::timestamptz + n * interval '1 second'
    from generate_series(1, 49) n`)
  await ownerDb.execute(sql`insert into audit_event (organization_id, actor_user_id, action, entity, entity_id, created_at) values
    ('org_a', null, 'limite.prueba', 'patient', ${p1}, '2026-08-01 09:00:00+00'),
    ('org_a', null, 'limite.prueba', 'patient', ${p2}, '2026-08-01 09:00:00+00'),
    ('org_a', null, 'limite.prueba', 'patient', ${p3}, '2026-08-01 09:00:00+00')`)
  const pages = await allPages("limite.prueba")
  expect(pages.map((page) => page.items.length)).toEqual([49, 3])
  expect(pages[1]!.items.map((item) => item.subject?.patientId).sort()).toEqual([p1, p2, p3].sort())
})

it("un instante de más de 400 registros (una carga de datos) se corta entre personas, nunca dentro de una acción", async () => {
  const people = await patients(150)
  // Un solo instante: tres registros por persona, 450 en total.
  await ownerDb.execute(sql`insert into audit_event (organization_id, actor_user_id, action, entity, entity_id, created_at)
    select 'org_a', null, 'carga.prueba', 'patient', p.id::text, '2026-07-01 08:00:00+00'
    from unnest(${`{${people.join(",")}}`}::uuid[]) as p(id), generate_series(1, 3)`)
  const pages = await allPages("carga.prueba")
  const items = pages.flatMap((page) => page.items)
  // Una acción por persona, con sus tres registros: ninguna partida ni repetida.
  expect(items).toHaveLength(150)
  expect(new Set(items.map((item) => item.subject?.patientId)).size).toBe(150)
  expect(items.every((item) => item.times === 3)).toBe(true)
  expect(pages.length).toBeGreaterThan(1)
})
