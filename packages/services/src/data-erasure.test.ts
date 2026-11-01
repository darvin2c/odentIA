/**
 * Borrar los datos de una persona a su pedido (ADR 0080, fase 2): se borra lo
 * no clínico, la historia, los cobros y el pedido quedan, la historia se
 * bloquea y sale de listas, agenda y del agente, y solo vuelve a abrirse con
 * motivo.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { agentPersonFact } from "@odentia/db/schema/agent"
import { appointment } from "@odentia/db/schema/agenda"
import { automationConsent } from "@odentia/db/schema/automation"
import { encounter, patient, patientCharge } from "@odentia/db/schema/clinical"
import { channelConnection, contact, contactIdentity, conversation, crmTask as task, message } from "@odentia/db/schema/crm"
import { crmNote } from "@odentia/db/schema/crm-workspace"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createRoom, listAppointments } from "./appointments.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  eraseForDataRequest,
  erasurePreview,
  getLockedRecord,
  listLockedRecords,
  openLockedRecord,
  recordLockState,
} from "./data-erasure.js"
import { createDataRequest, respondDataRequest, verifyDataRequest } from "./data-requests.js"
import { sendPatientRecordCopy } from "./patient-record.js"
import { listPatients } from "./patients.js"
import { listPeople } from "./people.js"
import type { Storage } from "./storage.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { setTestPatientIdentity } from "./test-patient.js"

setupTestDb()

const can = () => true

/** Una paciente con una conversación (y un adjunto), una tarea, una nota, lo que el agente recuerda, una cita por venir y una deuda. */
async function patientWithHistory() {
  const f = await clinicalFixture()
  const run = f.run as <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
  const patientId = f.patient.id
  const personId = f.patient.personId
  await setTestPatientIdentity(ownerDb, patientId, {
    email: `elena-${randomUUID()}@example.com`,
    birthDate: "1988-03-02",
  })
  await ownerDb.update(contact).set({ tags: ["vip"] }).where(eq(contact.id, personId))
  const [conn] = await ownerDb
    .insert(channelConnection)
    .values({
      organizationId: "org_a",
      channel: "email",
      provider: "gmail",
      displayName: "Correo de la clínica",
      externalId: `clinica-${randomUUID()}@example.com`,
      configEncrypted: "prueba",
      webhookSecret: "prueba",
      status: "active",
    })
    .returning()
  const storage = {
    putAttachment: async ({ orgId, conversationId }: { orgId: string; conversationId: string }) => ({
      objectKey: `${orgId}/${conversationId}/copia.pdf`,
      mimeType: "application/pdf",
      filename: "copia.pdf",
      size: 10,
    }),
    attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
  } as unknown as Storage
  // Una copia enviada por correo: deja una conversación con un mensaje y su adjunto.
  const copy = await run((tx) =>
    createDataRequest(tx, "org_a", f.actor, patientId, { kind: "copia", requesterContactId: personId, channel: "correo" }),
  )
  await run((tx) => verifyDataRequest(tx, "org_a", f.actor, patientId, copy.id, { how: "documento" }))
  const sent = await run((tx) =>
    sendPatientRecordCopy(tx, "org_a", f.actor, patientId, copy.id, { connectionId: conn!.id }, { storage }),
  )
  await ownerDb.insert(task).values({ organizationId: "org_a", title: "Llamar a Elena", contactId: personId, createdBy: f.actor })
  await ownerDb.insert(crmNote).values({ organizationId: "org_a", contactId: personId, body: "Prefiere la tarde" })
  await ownerDb
    .insert(agentPersonFact)
    .values({ organizationId: "org_a", contactId: personId, text: "Le gusta que le escriban temprano", source: "equipo" })
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede ${randomUUID()}`, timezone: "America/Lima" })
    .returning({ id: branch.id })
  const room = await run((tx) => createRoom(tx, "org_a", { branchId: site!.id, name: `Unidad ${randomUUID()}` }))
  const startsAt = new Date(Date.now() + 5 * 86_400_000)
  const [visit] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: "org_a",
      branchId: site!.id,
      patientId,
      professionalUserId: f.actor,
      roomId: room.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      durationMin: 30,
      status: "programada",
    })
    .returning()
  await ownerDb
    .insert(patientCharge)
    .values({ organizationId: "org_a", patientId, description: "Limpieza", amountCents: 12000, currency: "PEN" })
  return { f, run, patientId, personId, conversationId: sent.conversationId, visitId: visit!.id, branchId: site!.id }
}

it("borra lo no clínico, guarda la historia y los cobros, cancela su cita sin avisarle y bloquea la historia", async () => {
  const { f, run, patientId, personId, conversationId, visitId, branchId } = await patientWithHistory()
  const request = await run((tx) =>
    createDataRequest(tx, "org_a", f.actor, patientId, { kind: "borrar", requesterContactId: personId, channel: "clinica" }),
  )
  // Lo que se ve antes de confirmar.
  const preview = await run((tx) => erasurePreview(tx, "org_a", patientId))
  expect(preview).toMatchObject({ conversations: 1, messages: 1, tasks: 1, notes: 1 })
  expect(preview.futureAppointments.map((a) => a.id)).toEqual([visitId])
  expect(preview.balances).toEqual([{ currency: "PEN", cents: 12000 }])

  // Un pedido de borrar no se responde a mano, ni se borra sin comprobar que es ella.
  await expect(
    run((tx) => eraseForDataRequest(tx, "org_a", f.actor, patientId, request.id)),
  ).rejects.toMatchObject({ code: "DATA_REQUEST_NOT_VERIFIED" })
  await run((tx) => verifyDataRequest(tx, "org_a", f.actor, patientId, request.id, { how: "documento" }))
  await expect(
    run((tx) => respondDataRequest(tx, "org_a", f.actor, patientId, request.id, { resolution: "Listo" })),
  ).rejects.toMatchObject({ code: "DATA_REQUEST_ERASE" })

  const erased = await run((tx) => eraseForDataRequest(tx, "org_a", f.actor, patientId, request.id))
  expect(erased.attachmentKeys).toEqual([`org_a/${conversationId}/copia.pdf`])
  expect(erased.request).toMatchObject({ status: "respondida" })
  expect(erased.request.resolution).toMatch(/1 conversación \(1 mensaje\)/)
  expect(erased.request.resolution).toMatch(/Se cancelaron 1 cita/)

  // Lo no clínico ya no está.
  expect(await ownerDb.select().from(conversation).where(eq(conversation.id, conversationId))).toEqual([])
  expect(await ownerDb.select().from(message).where(eq(message.conversationId, conversationId))).toEqual([])
  expect(await ownerDb.select().from(contactIdentity).where(eq(contactIdentity.contactId, personId))).toEqual([])
  expect(await ownerDb.select().from(task).where(eq(task.contactId, personId))).toEqual([])
  expect(await ownerDb.select().from(crmNote).where(eq(crmNote.contactId, personId))).toEqual([])
  expect(await ownerDb.select().from(agentPersonFact).where(eq(agentPersonFact.contactId, personId))).toEqual([])
  const [person] = await ownerDb.select().from(contact).where(eq(contact.id, personId))
  expect(person).toMatchObject({ email: null, tags: [], isActive: false, recordLockedBy: f.actor })
  // Nombre, documento y teléfono quedan, dentro de la historia.
  expect(person!.displayName).toBeTruthy()
  // Todos sus mensajes apagados.
  const consents = await ownerDb
    .select({ purpose: automationConsent.purpose, status: automationConsent.status })
    .from(automationConsent)
    .where(and(eq(automationConsent.organizationId, "org_a"), eq(automationConsent.contactId, personId)))
  expect(consents.length).toBe(4)
  expect(consents.every((c) => c.status === "revoked")).toBe(true)

  // Lo clínico y los cobros siguen.
  expect(await ownerDb.select().from(patient).where(eq(patient.id, patientId))).toHaveLength(1)
  expect((await ownerDb.select().from(encounter).where(eq(encounter.patientId, patientId))).length).toBeGreaterThan(0)
  expect(await ownerDb.select().from(patientCharge).where(eq(patientCharge.patientId, patientId))).toHaveLength(1)
  // La cita se canceló sin avisarle.
  const [visit] = await ownerDb.select().from(appointment).where(eq(appointment.id, visitId))
  expect(visit!.status).toBe("cancelada")

  // No sale en listas ni en la agenda; sí en «Historias bloqueadas».
  const people = await run((tx) => listPeople(tx, "org_a", { view: "todos", limit: 100 }, can))
  expect(people.items.map((p) => p.id)).not.toContain(personId)
  const archived = await run((tx) => listPeople(tx, "org_a", { view: "archivados", limit: 100 }, can))
  expect(archived.items.map((p) => p.id)).not.toContain(personId)
  const patients = await run((tx) => listPatients(tx, "org_a", { limit: 100 }))
  expect(patients.items.map((p) => p.id)).not.toContain(patientId)
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString()
  const agenda = await run((tx) => listAppointments(tx, "org_a", { from: day(-1), to: day(10), branchId }))
  expect(agenda.map((a) => a.id)).not.toContain(visitId)
  const locked = await run((tx) => listLockedRecords(tx, "org_a"))
  expect(locked.map((r) => r.patientId)).toContain(patientId)
  const view = await run((tx) => getLockedRecord(tx, "org_a", f.actor, patientId))
  expect(view.request?.resolution).toMatch(/bloqueados/)

  // Bloqueada, ya no se le registra otro pedido: su ficha no existe para el equipo.
  await expect(
    run((tx) =>
      createDataRequest(tx, "org_a", f.actor, patientId, { kind: "borrar", requesterContactId: personId, channel: "clinica" }),
    ),
  ).rejects.toMatchObject({ status: 403 })
})

it("abrirla con motivo es solo leer por una hora; «vuelve a atenderse» la desbloquea entera", async () => {
  const { f, run, patientId, personId } = await patientWithHistory()
  const request = await run((tx) =>
    createDataRequest(tx, "org_a", f.actor, patientId, { kind: "borrar", requesterContactId: personId, channel: "clinica" }),
  )
  await run((tx) => verifyDataRequest(tx, "org_a", f.actor, patientId, request.id, { how: "documento" }))
  await run((tx) => eraseForDataRequest(tx, "org_a", f.actor, patientId, request.id))
  expect(await run((tx) => recordLockState(tx, "org_a", f.actor, patientId))).toEqual({ locked: true, openUntil: null })

  // «Otro» pide escribir el motivo.
  await expect(
    run((tx) => openLockedRecord(tx, "org_a", f.actor, patientId, { reason: "otro" })),
  ).rejects.toMatchObject({ status: 400 })
  const opened = await run((tx) => openLockedRecord(tx, "org_a", f.actor, patientId, { reason: "autoridad" }))
  expect(opened.locked).toBe(true)
  const minutes = (Date.parse(opened.openUntil!) - Date.now()) / 60_000
  expect(minutes).toBeGreaterThan(55)
  expect(minutes).toBeLessThanOrEqual(61)
  // Abierta para quien la abrió, no para otro.
  expect((await run((tx) => recordLockState(tx, "org_a", f.actor, patientId))).openUntil).toBe(opened.openUntil)
  expect((await run((tx) => recordLockState(tx, "org_a", randomUUID(), patientId))).openUntil).toBeNull()

  const back = await run((tx) => openLockedRecord(tx, "org_a", f.actor, patientId, { reason: "vuelve" }))
  expect(back).toEqual({ locked: false, openUntil: null })
  const [person] = await ownerDb.select().from(contact).where(eq(contact.id, personId))
  expect(person).toMatchObject({ isActive: true, recordLockedAt: null })
  const patients = await run((tx) => listPatients(tx, "org_a", { limit: 100 }))
  expect(patients.items.map((p) => p.id)).toContain(patientId)
})
