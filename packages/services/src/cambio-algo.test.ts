/**
 * «¿Cambió algo?», corregir lo enviado y lo que ve recepción (mesa de formularios del 13 nov,
 * entrega 10; casos C6, C8 y C10). La regla del mes se prueba con fechas fijas en
 * `@odentia/clinical` (`health-check.test.ts`); aquí, con la base de verdad.
 */
import { randomUUID } from "node:crypto"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { patient, patientHealthDeclaration } from "@odentia/db/schema/clinical"
import { channelConnection, contact, contactIdentity, conversation, message } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { and, desc, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createRoom } from "./appointments.js"
import { beforeVisitStatus, healthToReviewOf, receptionHealthStatus } from "./before-visit.js"
import { issuePersonalLink } from "./booking-links.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  changedHealthOf,
  getPatientHealth,
  type HealthDeclaration,
  initializeDeclaredPatientHealth,
  recordHealthDeclaration,
  savePatientHealth,
} from "./clinical.js"
import { healthCheckOf } from "./health-check.js"
import { patientTodo, remoteTodoCount } from "./patient-todo.js"
import { createPatient, patientPersonId } from "./patients.js"
import { personalLinkRef } from "./personal-link-token.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { getPersonalLinkDataForm, getPersonalLinkView, submitPersonalLinkData } from "./su-enlace.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ORG = "org_a"
const KEY = secretsKeyFromEnv("cd".repeat(32))
const DAY = 86_400_000
type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Lo que Marta dijo de su salud hace dos meses: penicilina, warfarina y nada más. */
const SAID_BEFORE = {
  allergies: { state: "recorded" as const, items: [{ substance: "Penicilina", severity: "desconocida" as const }] },
  conditions: { state: "none" as const, items: [] },
  anticoagulants: { state: "recorded" as const, detail: "Warfarina 5 mg" },
  boneMedicines: { state: "none" as const },
  medications: { state: "none" as const, items: [] },
}

/** Una cita por venir de la paciente, en una sede nueva. */
async function upcoming(f: Fixture, patientId: string, inDays = 3) {
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: ORG, name: `Sede ${randomUUID().slice(0, 6)}`, timezone: "America/Lima" })
    .returning({ id: branch.id })
  const room = await f.run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental 1" }))
  const startsAt = new Date(Date.now() + inDays * DAY)
  const [booked] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: ORG,
      branchId: site!.id,
      patientId,
      professionalUserId: f.actor,
      roomId: room.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      durationMin: 30,
    })
    .returning({ id: appointment.id })
  return booked!.id
}

/**
 * Marta, que hace `ago` días dijo su salud desde su enlace, con una cita por venir y el enlace de
 * esa cita. Sus datos ya los envió una vez: lo que queda es lo de antes de cada cita.
 */
async function martaBack(f: Fixture, ago = 60) {
  const created = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, { displayName: "Marta Ríos", givenNames: "Marta", familyName: "Ríos", phone: "+51987111222" }),
  )
  const patientId = created.id
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, patientId)))!
  await ownerDb.update(contact).set({ birthDate: "1960-03-04", sex: "F" }).where(eq(contact.id, personId))
  await f.run(async (tx) => {
    await recordHealthDeclaration(tx, ORG, patientId, {
      via: "enlace",
      by: { kind: "patient", name: null, relation: null },
      health: SAID_BEFORE,
      saidAt: new Date(Date.now() - ago * DAY),
    })
    await initializeDeclaredPatientHealth(tx, ORG, patientId, SAID_BEFORE, null)
  })
  // Lo dijo antes de la visita de entonces, que ya pasó.
  await upcoming(f, patientId, -(ago - 1))
  const visit = await upcoming(f, patientId)
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId, appointmentId: visit }, { secretsKey: KEY }))
  await ownerDb.update(appointmentBookingLink).set({ dataSubmittedAt: new Date(Date.now() - ago * DAY) }).where(eq(appointmentBookingLink.patientId, patientId))
  return { patientId, personId, visit, link }
}

async function declarationsOf(patientId: string) {
  return ownerDb
    .select()
    .from(patientHealthDeclaration)
    .where(eq(patientHealthDeclaration.patientId, patientId))
    .orderBy(desc(patientHealthDeclaration.createdAt), desc(patientHealthDeclaration.saidAt))
}

it("C6: si pasó más de un mes se le pregunta «¿Cambió algo?», sin listar lo de antes, y con «No» queda anotado con su fecha", async () => {
  const f = await clinicalFixture()
  const marta = await martaBack(f)
  const view = await f.run((tx) => getPersonalLinkView(tx, ORG, marta.link.token))
  expect(view.healthCheck).not.toBeNull()
  expect(new Date(view.healthCheck!.since).getTime()).toBeLessThan(Date.now() - 59 * DAY)
  // El enlace se abre sin código (decisión 9): nada de lo que dijo antes viaja a la página.
  for (const secret of ["Penicilina", "Warfarina", "warfarina"]) expect(JSON.stringify(view)).not.toContain(secret)
  const form = await f.run((tx) => getPersonalLinkDataForm(tx, ORG, marta.link.token))
  expect(form.healthCheck?.questions).toEqual(expect.arrayContaining(["allergies", "anticoagulants", "medications"]))
  expect(form.missing).toEqual([])
  expect(JSON.stringify(form)).not.toContain("Warfarina")
  // No es algo por hacer (decidido el 14 nov): el recordatorio de siempre lleva una línea suave.
  const todo = await f.run((tx) => patientTodo(tx, ORG, { patientId: marta.patientId, contactId: marta.personId, appointmentId: marta.visit }))
  expect(todo.healthCheck).not.toBeNull()
  expect(remoteTodoCount(todo)).toMatchObject({ total: 0, healthCheck: true })

  // «No, sigue igual»: un toque.
  await f.run((tx) => submitPersonalLinkData(tx, ORG, marta.link.token, { data: {}, healthCheck: "sin_cambios" }))
  const [said] = await declarationsOf(marta.patientId)
  expect(said).toMatchObject({ reason: "sin_cambios", health: {}, via: "enlace", respondent: "patient" })
  expect(said!.saidAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
  const health = await f.run((tx) => getPatientHealth(tx, ORG, marta.patientId))
  expect(health.unchanged).toMatchObject({ by: { kind: "patient" } })
  expect(health.changed).toBeNull()
  // Lo de antes sigue como estaba: la warfarina no se toca.
  expect(health.medications.map((row) => row.name)).toEqual(["Warfarina 5 mg"])

  // Ya respondió: no se le vuelve a preguntar para esta cita, ni dentro del mes para la siguiente.
  const after = await f.run((tx) => getPersonalLinkView(tx, ORG, marta.link.token))
  expect(after.healthCheck).toBeNull()
  expect(after.told?.items.map((item) => item.what)).toContain("sin_cambios")
  const next = await upcoming(f, marta.patientId, 60)
  expect(await f.run((tx) => healthCheckOf(tx, ORG, { patientId: marta.patientId, appointmentId: next }))).toBeNull()
  // Pasado otro mes, sí.
  expect(await f.run((tx) => healthCheckOf(tx, ORG, { patientId: marta.patientId, appointmentId: next }, new Date(Date.now() + 35 * DAY)))).not.toBeNull()
})

it("dentro del mes no se le pregunta, y sin ninguna declaración tampoco: eso es preguntar lo que falta", async () => {
  const f = await clinicalFixture()
  const recent = await martaBack(f, 10)
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, recent.link.token))).healthCheck).toBeNull()
  expect(await f.run((tx) => healthCheckOf(tx, ORG, { patientId: recent.patientId, appointmentId: recent.visit }))).toBeNull()
  const fresh = await f.run((tx) => createPatient(tx, ORG, f.actor, { displayName: "Ana Paz", givenNames: "Ana", familyName: "Paz", phone: "+51987000444" }))
  const visit = await upcoming(f, fresh.id, 4)
  expect(await f.run((tx) => healthCheckOf(tx, ORG, { patientId: fresh.id, appointmentId: visit }))).toBeNull()
})

it("C6: le cambiaron el anticoagulante; con «Sí» vuelve a responder, lo nuevo llega por revisar y la warfarina queda «dijo que cambió»", async () => {
  const f = await clinicalFixture()
  const marta = await martaBack(f)
  const before = await f.run((tx) => getPatientHealth(tx, ORG, marta.patientId))
  const warfarin = before.medications.find((row) => row.name === "Warfarina 5 mg")!
  const penicillin = before.allergies.find((row) => row.substance === "Penicilina")!

  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, marta.link.token, {
      data: {},
      healthCheck: "cambio",
      health: { ...SAID_BEFORE, anticoagulants: { state: "recorded", detail: "Apixabán 5 mg" } },
    }),
  )
  const [said] = await declarationsOf(marta.patientId)
  expect(said).toMatchObject({ reason: "cambio", via: "enlace" })
  const health = await f.run((tx) => getPatientHealth(tx, ORG, marta.patientId))
  // Lo de antes no se borra.
  const names = health.medications.map((row) => row.name)
  expect(names).toEqual(expect.arrayContaining(["Warfarina 5 mg", "Apixabán 5 mg"]))
  const apixaban = health.medications.find((row) => row.name === "Apixabán 5 mg")!
  expect(apixaban.atcCode?.startsWith("B01A")).toBe(true)
  // El nuevo, arriba por revisar, con su declaración; el anterior, «dijo que cambió».
  expect(health.declared.some((group) => group.medications.includes(apixaban.id))).toBe(true)
  expect(health.changed).toMatchObject({ by: { kind: "patient" }, medications: [warfarin.id] })
  // La penicilina la volvió a decir: sigue igual, sin marca.
  expect(health.changed?.allergies).not.toContain(penicillin.id)
  expect(health.unchanged).toBeNull()
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, marta.link.token))).healthCheck).toBeNull()

  // Cuando el equipo revisa su salud, la marca se va: lo decidió quien la atiende.
  await f.run((tx) =>
    savePatientHealth(tx, ORG, f.actor, marta.patientId, {
      expectedRevision: health.revision,
      bloodGroup: null,
      reviewStatus: { allergies: "recorded", conditions: "none", medications: "recorded" },
      conditions: [],
      medications: health.medications.map((row) => ({ id: row.id, name: row.name })),
    }),
  )
  expect((await f.run((tx) => getPatientHealth(tx, ORG, marta.patientId))).changed).toBeNull()
})

it("«dijo que cambió» compara cada clase con lo que dijo de ella, y solo lo que ya estaba antes", () => {
  const at = new Date("2027-05-14T15:00:00Z")
  const declaration = (health: HealthDeclaration["health"], reason: HealthDeclaration["reason"] = "cambio"): HealthDeclaration => ({
    at,
    enteredAt: at,
    via: "enlace",
    by: { kind: "patient", name: null, relation: null },
    health,
    reason,
  })
  const old = new Date("2026-11-13T15:00:00Z")
  const rows = {
    allergies: [],
    conditions: [{ id: "c1", name: "Diabetes", status: "activa", createdAt: old }],
    medications: [
      { id: "m1", name: "Warfarina 5 mg", atcCode: "B01AA03", createdAt: old },
      { id: "m2", name: "Metformina", atcCode: "A10BA02", createdAt: old },
    ],
    staffSavedAt: null,
    allergiesReviewedAt: null,
  }
  // Solo respondió de anticoagulantes: la metformina y la diabetes no las tocó.
  expect(changedHealthOf({ ...rows, declarations: [declaration({ anticoagulants: { state: "recorded", detail: "Apixabán" } })] })).toMatchObject({
    medications: ["m1"],
    conditions: [],
  })
  // Lo primero que dijo (sin «cambio» ni «corrección») no marca nada.
  expect(changedHealthOf({ ...rows, declarations: [declaration({ anticoagulants: { state: "none" } }, null)] })).toBeNull()
  // Revisado por el equipo después, tampoco.
  expect(
    changedHealthOf({ ...rows, staffSavedAt: new Date("2027-05-15T10:00:00Z"), declarations: [declaration({ anticoagulants: { state: "none" } })] }),
  ).toBeNull()
})

it("C8: al día siguiente sabe qué envió y cuándo, y corrige su salud sin verla; llega como declaración nueva", async () => {
  const f = await clinicalFixture()
  const marta = await martaBack(f)
  await f.run((tx) => submitPersonalLinkData(tx, ORG, marta.link.token, { data: {}, healthCheck: "cambio", health: SAID_BEFORE }))
  const view = await f.run((tx) => getPersonalLinkView(tx, ORG, marta.link.token))
  expect(view.told?.items.map((item) => item.what)).toContain("salud")
  expect(view.correctHealth).toBe(true)
  for (const secret of ["Penicilina", "Warfarina"]) expect(JSON.stringify(view)).not.toContain(secret)
  const form = await f.run((tx) => getPersonalLinkDataForm(tx, ORG, marta.link.token, "corregir"))
  expect(form).toMatchObject({ correcting: true, missing: [], visit: null, healthCheck: null, asksHealth: true })
  expect(form.healthQuestions).toEqual(expect.arrayContaining(["anticoagulants", "allergies"]))
  expect(JSON.stringify(form)).not.toContain("Warfarina")

  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, marta.link.token, {
      data: {},
      correctHealth: true,
      health: { ...SAID_BEFORE, anticoagulants: { state: "recorded", detail: "Warfarina 2,5 mg" } },
    }),
  )
  const rows = await declarationsOf(marta.patientId)
  expect(rows[0]).toMatchObject({ reason: "correccion" })
  // Lo de antes no se borra: las tres declaraciones siguen.
  expect(rows).toHaveLength(3)
  const health = await f.run((tx) => getPatientHealth(tx, ORG, marta.patientId))
  expect(health.medications.map((row) => row.name)).toEqual(expect.arrayContaining(["Warfarina 5 mg", "Warfarina 2,5 mg"]))
  expect(health.changed?.medications).toEqual([health.medications.find((row) => row.name === "Warfarina 5 mg")!.id])
  // Los valores se ven en su portal, con su código: `portal-access.test.ts`.
})

it("sin haber contado su salud desde su enlace, no se le ofrece corregirla", async () => {
  const f = await clinicalFixture()
  const marta = await martaBack(f, 10)
  const view = await f.run((tx) => getPersonalLinkView(tx, ORG, marta.link.token))
  expect(view.correctHealth).toBe(false)
  await expect(f.run((tx) => getPersonalLinkDataForm(tx, ORG, marta.link.token, "corregir"))).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
  await expect(
    f.run((tx) => submitPersonalLinkData(tx, ORG, marta.link.token, { data: {}, correctHealth: true, health: SAID_BEFORE })),
  ).rejects.toMatchObject({ code: "CORRECTION_NOT_OPEN" })
})

it("C10: recepción ve si respondió y cuándo salió su enlace, sin nada de lo que respondió", async () => {
  const f = await clinicalFixture()
  const marta = await martaBack(f)
  const pending = await f.run((tx) => beforeVisitStatus(tx, ORG, marta.patientId))
  expect(pending).toMatchObject({ appointmentId: marta.visit, state: "por_responder", answeredAt: null, linkSent: null })

  // Su enlace salió por WhatsApp (aceptado por el canal); uno solo encolado no cuenta.
  const [connection] = await ownerDb
    .insert(channelConnection)
    .values({
      organizationId: ORG, channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA",
      externalId: `wa-${randomUUID().slice(0, 8)}`, configEncrypted: "prueba", webhookSecret: "prueba", status: "active",
    })
    .returning({ id: channelConnection.id })
  const [identity] = await ownerDb
    .insert(contactIdentity)
    .values({ organizationId: ORG, contactId: marta.personId, channel: "whatsapp", externalUserId: "51987111222", isPrimary: true })
    .returning({ id: contactIdentity.id })
  const [thread] = await ownerDb
    .insert(conversation)
    .values({ organizationId: ORG, contactId: marta.personId, contactIdentityId: identity!.id, channelConnectionId: connection!.id, externalThreadId: "51987111222" })
    .returning({ id: conversation.id })
  const sentAt = new Date(Date.now() - 2 * DAY)
  const body = `Hola Marta. Antes de tu cita: https://clinica.test/pendientes?token=${personalLinkRef(marta.link.linkId)}`
  await ownerDb.insert(message).values([
    { organizationId: ORG, conversationId: thread!.id, direction: "out", senderKind: "system", body, status: "sent", sentAt },
    { organizationId: ORG, conversationId: thread!.id, direction: "out", senderKind: "system", body, status: "queued" },
  ])
  const sent = await f.run((tx) => beforeVisitStatus(tx, ORG, marta.patientId))
  expect(sent?.linkSent).toEqual({ at: sentAt, channel: "whatsapp" })

  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, marta.link.token, {
      data: {},
      healthCheck: "sin_cambios",
      visit: { reason: "Me duele la muela de abajo", pain: "si", painLevel: 8 },
    }),
  )
  const answered = await f.run((tx) => beforeVisitStatus(tx, ORG, marta.patientId))
  expect(answered).toMatchObject({ state: "respondio" })
  expect(answered!.answeredAt!.getTime()).toBeGreaterThan(Date.now() - 60_000)
  // Es estado, no contenido: nada de lo que contó viaja a recepción.
  expect(Object.keys(answered!).sort()).toEqual(["answeredAt", "appointmentId", "linkSent", "startsAt", "state"])
  for (const secret of ["muela", "Warfarina", "Penicilina"]) expect(JSON.stringify(answered)).not.toContain(secret)
  // Sin cita por venir no hay nada que decir.
  await ownerDb.update(appointment).set({ status: "cancelada" }).where(and(eq(appointment.patientId, marta.patientId)))
  expect(await f.run((tx) => beforeVisitStatus(tx, ORG, marta.patientId))).toBeNull()
})

// Decisión del dueño sobre la entrega 10: recepción ve una línea neutra si declaró algo sin revisar.
it("recepción sabe que declaró algo de su salud sin revisar y cuándo, sin nada de lo que dijo, aunque no tenga cita", async () => {
  const f = await clinicalFixture()
  const marta = await martaBack(f)
  await ownerDb.update(appointment).set({ status: "cancelada" }).where(eq(appointment.patientId, marta.patientId))
  const status = await f.run((tx) => receptionHealthStatus(tx, ORG, marta.patientId))
  expect(status.visit).toBeNull()
  expect(status.healthToReview).not.toBeNull()
  // Lo que dijo hace dos meses (su declaración guarda ese día).
  expect(status.healthToReview!.at.getTime()).toBeLessThan(Date.now() - 59 * DAY)
  expect(Object.keys(status.healthToReview!)).toEqual(["at"])
  for (const secret of ["Warfarina", "Penicilina"]) expect(JSON.stringify(status)).not.toContain(secret)

  // Revisado por el equipo, ya no hay nada que decir.
  const health = await f.run((tx) => getPatientHealth(tx, ORG, marta.patientId))
  await f.run((tx) =>
    savePatientHealth(tx, ORG, f.actor, marta.patientId, {
      expectedRevision: health.revision,
      reviewStatus: { allergies: "recorded", conditions: "none", medications: "recorded" },
      conditions: [],
      medications: health.medications.map((row) => ({ id: row.id, name: row.name })),
    }),
  )
  await ownerDb.update(patient).set({ allergiesReviewedAt: new Date() }).where(eq(patient.id, marta.patientId))
  expect(await f.run((tx) => healthToReviewOf(tx, ORG, marta.patientId))).toBeNull()
})

it("lo que anotó el equipo no sale como «Declaró datos de su salud»", async () => {
  const f = await clinicalFixture()
  const ana = await f.run((tx) => createPatient(tx, ORG, f.actor, { displayName: "Ana Paz", givenNames: "Ana", familyName: "Paz", phone: "+51987000555" }))
  await f.run(async (tx) => {
    await recordHealthDeclaration(tx, ORG, ana.id, { via: "registro", by: { kind: "staff", name: null, relation: null }, health: SAID_BEFORE })
    await initializeDeclaredPatientHealth(tx, ORG, ana.id, SAID_BEFORE, f.actor)
  })
  expect(await f.run((tx) => healthToReviewOf(tx, ORG, ana.id))).toBeNull()
})