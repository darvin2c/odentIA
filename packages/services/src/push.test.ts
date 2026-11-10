import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { member, user } from "@odentia/db/schema/auth"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { pushSubscription } from "@odentia/db/schema/workspace"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  collectOrgPushes,
  deletePushSubscription,
  getPushSubscription,
  PUSH_DEVICES_PER_PERSON,
  PUSH_WAITING_GAP_MS,
  pushSubscribedOrgs,
  savePushSubscription,
} from "./push.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { createWorkspaceNotification, workspaceAccessFor } from "./workspace.js"

setupTestDb()

/** Lunes 16 de noviembre de 2026, 12:00 en Lima: una clínica sin horario cargado está abierta. */
const NOON = new Date("2026-11-16T17:00:00Z")

const keys = (n: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" })

/** Una clínica con su equipo y un canal: cada prueba la suya, para no depender de las otras. */
async function clinic(roles: Record<string, string>) {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `avisos-${orgId.slice(0, 8)}`)
  const people = Object.fromEntries(Object.keys(roles).map((name) => [name, randomUUID()]))
  await ownerDb.insert(user).values(Object.values(people).map((id) => ({ id, name: `Persona ${id.slice(0, 4)}`, email: `${id}@avisos.test`, emailVerified: true })))
  await ownerDb.insert(member).values(Object.entries(roles).map(([name, role]) => ({ id: randomUUID(), organizationId: orgId, userId: people[name]!, role, createdAt: new Date() })))
  const [connection] = await ownerDb.insert(channelConnection).values({
    organizationId: orgId, channel: "whatsapp", provider: "prueba", displayName: "Canal", configEncrypted: "x", webhookSecret: "y",
  }).returning({ id: channelConnection.id })
  /** Alguien escribe y nadie le respondió: espera en Inicio. */
  const writes = async (name: string) => {
    const [person] = await ownerDb.insert(contact).values({ organizationId: orgId, displayName: name }).returning({ id: contact.id })
    const [row] = await ownerDb.insert(conversation).values({
      organizationId: orgId, contactId: person!.id, channelConnectionId: connection!.id, externalThreadId: `t:${randomUUID()}`, status: "open",
    }).returning({ id: conversation.id })
    await ownerDb.insert(message).values({
      organizationId: orgId, conversationId: row!.id, direction: "in", senderKind: "contact", body: "Me duele la muela después de la endodoncia", status: "received",
      externalId: `ext-${randomUUID()}`, createdAt: new Date(Date.now() - 60_000),
    })
    return row!.id
  }
  const tx = <T>(fn: Parameters<typeof withOrgContext<T>>[2]) => withOrgContext(appDb, orgId, fn)
  const subscribe = (who: string, role: string, endpoint: string) =>
    tx((db) => savePushSubscription(db, orgId, people[who]!, workspaceAccessFor(role), keys(endpoint)))
  const collect = (now = NOON) => tx((db) => collectOrgPushes(db, orgId, now))
  return { orgId, people, writes, subscribe, collect, tx }
}

it("avisa «Listo» al activar y después solo cuando aparece alguien nuevo en «Te espera», sin su nombre ni lo que escribió", async () => {
  const { writes, subscribe, collect } = await clinic({ rita: "reception" })
  await writes("Lucía Paredes")
  await subscribe("rita", "reception", "rita-1")

  // Lo que ya esperaba al activar no se avisa otra vez: solo «Listo», una vez.
  const first = await collect()
  expect(first.map((d) => d.message.tag)).toEqual(["listo"])
  expect(await collect()).toEqual([])

  await writes("Jorge Ramos")
  const second = await collect()
  expect(second).toHaveLength(1)
  expect(second[0]!.message).toMatchObject({ tag: "te-espera", body: "Te esperan 2 personas", href: "/home", icon: "/pwa/odentia-192.png" })
  expect(second[0]!.message.title).toMatch(/^Clínica avisos-/)
  // Se ve con el teléfono bloqueado: ni el nombre ni lo que escribió.
  const text = JSON.stringify(second)
  expect(text).not.toMatch(/Jorge|Lucía|endodoncia|muela/)
  expect(second[0]!.ttlSeconds).toBeLessThanOrEqual(30 * 60)
  expect(await collect()).toEqual([])
})

it("entre dos avisos de «Te espera» pasan unos minutos, y lo que llegó en la pausa se avisa después", async () => {
  const { writes, subscribe, collect } = await clinic({ rita: "reception" })
  await subscribe("rita", "reception", "pausa")
  await collect()
  const start = NOON
  await writes("Primera")
  expect((await collect(start)).map((d) => d.message.body)).toEqual(["Te espera 1 persona"])
  await writes("Segunda")
  expect(await collect(new Date(start.getTime() + 60_000))).toEqual([])
  expect((await collect(new Date(start.getTime() + PUSH_WAITING_GAP_MS + 1000))).map((d) => d.message.body)).toEqual(["Te esperan 2 personas"])
})

it("con la clínica cerrada «Te espera» no avisa; al abrir, sí", async () => {
  const { orgId, people, writes, subscribe, collect } = await clinic({ rita: "reception", doctora: "clinician" })
  const [sede] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Sede", timezone: "America/Lima" }).returning({ id: branch.id })
  // De lunes a sábado de 9:00 a 18:00 (hora de Lima).
  await ownerDb.insert(professionalSchedule).values([1, 2, 3, 4, 5, 6].map((weekday) => ({
    organizationId: orgId, branchId: sede!.id, professionalUserId: people.doctora!, weekday, startMin: 9 * 60, endMin: 18 * 60,
  })))
  await subscribe("rita", "reception", "horario")
  await collect()
  await writes("Escribe de noche")
  // Domingo 15 de noviembre de 2026, 22:30 en Lima: cerrado.
  expect(await collect(new Date("2026-11-16T03:30:00Z"))).toEqual([])
  // Lunes 16, 9:30 en Lima: abierto, y lo de la noche llega.
  expect((await collect(new Date("2026-11-16T14:30:00Z"))).map((d) => d.message.tag)).toEqual(["te-espera"])
})

it("el corte de WhatsApp llega a cualquier hora a quien lo ve en la campana, y no a quien no tiene ese permiso", async () => {
  const { orgId, people, subscribe, collect, tx } = await clinic({ dueña: "owner", rita: "reception" })
  await subscribe("dueña", "owner", "dueña")
  await subscribe("rita", "reception", "rita")
  await collect()
  for (const who of ["dueña", "rita"]) {
    await tx((db) => createWorkspaceNotification(db, orgId, {
      userId: people[who]!, dedupeKey: `corte:${who}`, title: "WhatsApp se desconectó: no llegan mensajes", body: "Vuelve a conectarlo en Configuración",
      href: "/settings/channels", permission: "settings.write", subject: "meta-desconecto:conexion-1",
    }))
    // Lo que solo informa (sin asunto del servicio) no sale del teléfono.
    await tx((db) => createWorkspaceNotification(db, orgId, {
      userId: people[who]!, dedupeKey: `firma:${who}`, title: "Un consentimiento fue firmado", body: "", href: "/home", permission: "clinical.read",
    }))
  }
  const sent = await collect()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ endpoint: keys("dueña").endpoint, urgency: "high", message: { tag: "servicio", body: "WhatsApp se desconectó: no llegan mensajes", href: "/settings/channels" } })
  expect(await collect()).toEqual([])
})

it("quien deja la clínica no recibe nada y su equipo se olvida; el mismo equipo pasa a quien lo activa después", async () => {
  const { orgId, people, writes, subscribe, collect, tx } = await clinic({ rita: "reception", tomas: "reception" })
  await subscribe("rita", "reception", "mostrador")
  await collect()
  // Tomás activa los avisos en la misma compu: el equipo es suyo ahora.
  await subscribe("tomas", "reception", "mostrador")
  expect(await tx((db) => getPushSubscription(db, orgId, people.rita!, keys("mostrador").endpoint))).toEqual({ active: false })
  expect(await tx((db) => getPushSubscription(db, orgId, people.tomas!, keys("mostrador").endpoint))).toEqual({ active: true })
  // Con la dirección sola, sin las claves de ese navegador, nadie se queda con el equipo de otro.
  await expect(tx((db) => savePushSubscription(db, orgId, people.rita!, workspaceAccessFor("reception"), { ...keys("mostrador"), auth: "AAAAAAAAAAAAAAAAAAAAAA" })))
    .rejects.toThrow(/otra persona/)
  // Rita no puede apagar el equipo de Tomás.
  await tx((db) => deletePushSubscription(db, orgId, people.rita!, keys("mostrador").endpoint))
  expect(await tx((db) => getPushSubscription(db, orgId, people.tomas!, keys("mostrador").endpoint))).toEqual({ active: true })

  await collect()
  await ownerDb.delete(member).where(and(eq(member.organizationId, orgId), eq(member.userId, people.tomas!)))
  await writes("Alguien")
  expect(await collect()).toEqual([])
  expect(await ownerDb.select().from(pushSubscription).where(eq(pushSubscription.organizationId, orgId))).toEqual([])
  expect(await pushSubscribedOrgs(ownerDb)).not.toContain(orgId)
})

it("una clínica no ve ni avisa los equipos de otra", async () => {
  const a = await clinic({ rita: "reception" })
  const b = await clinic({ ana: "reception" })
  await a.subscribe("rita", "reception", "aislada")
  expect(await withOrgContext(appDb, b.orgId, (db) => db.select().from(pushSubscription))).toEqual([])
  expect(await withOrgContext(appDb, b.orgId, (db) => collectOrgPushes(db, a.orgId))).toEqual([])
  expect(await b.tx((db) => getPushSubscription(db, a.orgId, a.people.rita!, keys("aislada").endpoint))).toEqual({ active: false })
})

it("rechaza una dirección que no es de un servicio de push o claves que no son del navegador", async () => {
  const { orgId, people, tx } = await clinic({ rita: "reception" })
  const save = (k: { endpoint: string; p256dh: string; auth: string }) =>
    tx((db) => savePushSubscription(db, orgId, people.rita!, workspaceAccessFor("reception"), k))
  await expect(save({ ...keys("x"), endpoint: "http://fcm.googleapis.com/x" })).rejects.toThrow(/dirección/)
  // Solo los servicios de push de los navegadores: el worker no llega a otro servidor.
  await expect(save({ ...keys("x"), endpoint: "https://169.254.169.254/latest" })).rejects.toThrow(/dirección/)
  await expect(save({ ...keys("x"), endpoint: "https://fcm.googleapis.com.evil.test/x" })).rejects.toThrow(/dirección/)
  await expect(save({ ...keys("x"), endpoint: "https://fcm.googleapis.com:8443/x" })).rejects.toThrow(/dirección/)
  await expect(save({ ...keys("apple"), endpoint: "https://web.push.apple.com/QGuQyavXut" })).resolves.toEqual({ active: true })
  await expect(save({ ...keys("x"), p256dh: "no es base64!" })).rejects.toThrow(/claves/)
  await expect(save({ ...keys("x"), auth: "corto" })).rejects.toThrow(/claves/)
  await expect(save({ ...keys("x"), endpoint: "https://alguien@fcm.googleapis.com/x" })).rejects.toThrow(/dirección/)
})

it("una clínica sin horario cargado no avisa de madrugada; volver a activar el mismo equipo no repite «Listo»; hay un tope de equipos por persona", async () => {
  const { orgId, people, writes, subscribe, collect } = await clinic({ rita: "reception" })
  await subscribe("rita", "reception", "madrugada")
  expect((await collect()).map((d) => d.message.tag)).toEqual(["listo"])
  await subscribe("rita", "reception", "madrugada")
  expect(await collect()).toEqual([])
  await writes("Escribe a las 3")
  // Lunes 16, 3:00 en Lima.
  expect(await collect(new Date("2026-11-16T08:00:00Z"))).toEqual([])
  expect((await collect()).map((d) => d.message.tag)).toEqual(["te-espera"])

  for (let n = 0; n < PUSH_DEVICES_PER_PERSON + 2; n += 1) await subscribe("rita", "reception", `equipo-${n}`)
  const left = await ownerDb.select({ endpoint: pushSubscription.endpoint }).from(pushSubscription)
    .where(and(eq(pushSubscription.organizationId, orgId), eq(pushSubscription.userId, people.rita!)))
  expect(left).toHaveLength(PUSH_DEVICES_PER_PERSON)
  expect(left.map((row) => row.endpoint)).toContain(keys(`equipo-${PUSH_DEVICES_PER_PERSON + 1}`).endpoint)
})
