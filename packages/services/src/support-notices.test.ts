import { type Db, withOrgContext } from "@odentia/db"
import { supportCase, supportNotice } from "@odentia/db/schema/admin-support"
import { member, user } from "@odentia/db/schema/auth"
import { and, eq, isNull } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import {
  createAccessSupportCase,
  getMySupportCase,
  listMySupportCases,
  markSupportCaseSeen,
  replyToAccountSupportCase,
  replyToMySupportCase,
  replyToSupportCase,
  setSupportCaseStatus,
} from "./admin-support.js"
import { sendHelpRequest } from "./help.js"
import { reportModelOutage } from "./model-outage.js"
import {
  claimSupportNotice,
  completeSupportNotice,
  SUPPORT_REPLY_NOTICE_DELAY_MS,
  SUPPORT_REPLY_NOTICE_GAP_MS,
  tickSupportNotices,
} from "./support-notices.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/** Avisos por correo de soporte: a soporte al abrir y al responder la clínica; a quien preguntó si no vio la respuesta. */
setupTestDb()
const ORG = "org_a"
const ANA = "notice-ana"
const LUIS = "notice-luis"
const OWNER = "notice-owner"
const STAFF_ID = "notice-staff"
const staff: AdminActor = { userId: STAFF_ID, role: "support" }
const MIN = 60_000

function run<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return withOrgContext(appDb, ORG, fn)
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: ANA, name: "Ana Torres", email: "ana@notice.test", emailVerified: true },
    { id: LUIS, name: "Luis Caja", email: "luis@notice.test", emailVerified: true },
    { id: OWNER, name: "Dueña", email: "duena@notice.test", emailVerified: true },
    { id: STAFF_ID, name: "Soporte", email: "staff@notice.test", emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: "m-notice-ana", userId: ANA, organizationId: ORG, role: "admin", createdAt: new Date() },
    { id: "m-notice-luis", userId: LUIS, organizationId: ORG, role: "cashier", createdAt: new Date() },
    { id: "m-notice-owner", userId: OWNER, organizationId: ORG, role: "owner", createdAt: new Date() },
  ])
})

function ask(question: string, userId = ANA) {
  return run((tx) => sendHelpRequest(tx, ORG, { userId, roleLabel: "Administrador" }, { question, screen: "/agent/administrador" }))
}

function noticesOf(caseId: string) {
  return ownerDb.select().from(supportNotice).where(eq(supportNotice.caseId, caseId))
}

function personNoticesOf(caseId: string) {
  return noticesOf(caseId).then((rows) => rows.filter((row) => row.recipientUserId !== null))
}

/** Momento de la última respuesta pública de soporte, para medir los 15 minutos desde ahí. */
async function lastAnswerOf(caseId: string): Promise<number> {
  const [row] = await ownerDb.select({ at: supportCase.lastPublicMessageAt }).from(supportCase).where(eq(supportCase.id, caseId))
  if (!row?.at) throw new Error("sin respuesta pública")
  return row.at.getTime()
}

describe("a soporte", () => {
  it("se encola al abrir un caso y cuando la clínica responde; una ráfaga sin salir deja un solo aviso", async () => {
    const kase = await ask("No puedo cambiar la hora del recordatorio")
    expect((await noticesOf(kase.id)).map((row) => [row.kind, row.recipientUserId, row.emailState])).toEqual([
      ["caso_nuevo", null, "pendiente"],
    ])
    // Repetir la misma pregunta abierta no abre otro caso ni otro aviso.
    expect((await ask("No puedo cambiar la hora del recordatorio")).id).toBe(kase.id)
    expect(await noticesOf(kase.id)).toHaveLength(1)

    // El aviso del caso sale; luego la clínica responde dos veces seguidas.
    const [first] = await noticesOf(kase.id)
    await claimSupportNotice(ownerDb, first!.id)
    await completeSupportNotice(ownerDb, first!.id, true)
    await run((tx) => replyToMySupportCase(tx, ORG, ANA, kase.id, "Les adjunto más detalle"))
    await run((tx) => replyToMySupportCase(tx, ORG, ANA, kase.id, "Y otra cosa más"))
    const inbox = (await noticesOf(kase.id)).filter((row) => row.recipientUserId === null)
    expect(inbox.map((row) => [row.kind, row.emailState])).toEqual([
      ["caso_nuevo", "enviado"],
      ["clinica_respondio", "pendiente"],
    ])
  })

  it("los casos de acceso, sin clínica, también avisan a soporte", async () => {
    const kase = await createAccessSupportCase(ownerDb, LUIS, { question: "No me llega el correo de verificación" })
    await replyToAccountSupportCase(ownerDb, LUIS, kase.id, "Sigo sin poder entrar")
    const rows = await ownerDb.select().from(supportNotice).where(and(eq(supportNotice.caseId, kase.id), isNull(supportNotice.organizationId)))
    expect(rows.map((row) => row.kind).sort()).toEqual(["caso_nuevo"])
    const claimed = await claimSupportNotice(ownerDb, rows[0]!.id)
    expect(claimed).toMatchObject({ kind: "caso_nuevo", to: null, clinicName: null, caseKind: "acceso" })
  })
})

describe("a quien preguntó", () => {
  it("respeta los 15 minutos y como mucho uno por caso cada hora", async () => {
    const kase = await ask("¿Cómo pido una plantilla nueva?")
    await replyToSupportCase(ownerDb, staff, kase.id, "Hola, te explico.")
    const t0 = await lastAnswerOf(kase.id)

    await tickSupportNotices(ownerDb, new Date(t0 + SUPPORT_REPLY_NOTICE_DELAY_MS - MIN))
    expect(await personNoticesOf(kase.id)).toEqual([])

    await tickSupportNotices(ownerDb, new Date(t0 + SUPPORT_REPLY_NOTICE_DELAY_MS + MIN))
    const [notice] = await personNoticesOf(kase.id)
    expect(notice).toMatchObject({ kind: "respuesta", recipientUserId: ANA, emailState: "pendiente" })
    const claimed = await claimSupportNotice(ownerDb, notice!.id)
    expect(claimed).toMatchObject({ to: "ana@notice.test", topic: "Administrador", caseKind: "pregunta" })
    await completeSupportNotice(ownerDb, notice!.id, true)
    // La misma respuesta no avisa dos veces.
    await tickSupportNotices(ownerDb, new Date(t0 + 3 * SUPPORT_REPLY_NOTICE_GAP_MS))
    expect(await personNoticesOf(kase.id)).toHaveLength(1)

    // Soporte escribe otra vez: dentro de la hora del aviso anterior no sale otro.
    await replyToSupportCase(ownerDb, staff, kase.id, "¿Pudiste probar?")
    const t1 = await lastAnswerOf(kase.id)
    const firstAt = t0 + SUPPORT_REPLY_NOTICE_DELAY_MS + MIN
    await tickSupportNotices(ownerDb, new Date(Math.max(t1 + SUPPORT_REPLY_NOTICE_DELAY_MS + MIN, firstAt + SUPPORT_REPLY_NOTICE_GAP_MS - MIN)))
    expect(await personNoticesOf(kase.id)).toHaveLength(1)
    await tickSupportNotices(ownerDb, new Date(Math.max(t1, firstAt) + SUPPORT_REPLY_NOTICE_GAP_MS + MIN))
    expect((await personNoticesOf(kase.id)).map((row) => row.kind)).toEqual(["respuesta", "respuesta"])
  })

  it("si la vio antes de 15 minutos no se le escribe", async () => {
    const kase = await ask("¿Dónde veo las facturas de odentIA?")
    await replyToSupportCase(ownerDb, staff, kase.id, "En Plan y pagos.")
    const t0 = await lastAnswerOf(kase.id)
    await run((tx) => markSupportCaseSeen(tx, ORG, ANA, kase.id))
    await tickSupportNotices(ownerDb, new Date(t0 + SUPPORT_REPLY_NOTICE_DELAY_MS + MIN))
    expect(await personNoticesOf(kase.id)).toEqual([])
  })

  it("«Esperando a la clínica» pide algo; «Resuelto» no envía correo", async () => {
    const waiting = await ask("El recordatorio sale con otra hora")
    await setSupportCaseStatus(ownerDb, staff, waiting.id, "esperando_clinica")
    // Pasa a la clínica como novedad sin leer.
    expect((await run((tx) => listMySupportCases(tx, ORG, ANA))).find((item) => item.id === waiting.id)?.unread).toBe(true)
    const t0 = await lastAnswerOf(waiting.id)
    await tickSupportNotices(ownerDb, new Date(t0 + SUPPORT_REPLY_NOTICE_DELAY_MS + MIN))
    expect((await personNoticesOf(waiting.id)).map((row) => row.kind)).toEqual(["necesita_algo"])

    const resolved = await ask("¿Se puede exportar la agenda?")
    await replyToSupportCase(ownerDb, staff, resolved.id, "Todavía no; lo anotamos.")
    await setSupportCaseStatus(ownerDb, staff, resolved.id, "resuelto")
    const t1 = await lastAnswerOf(resolved.id)
    await tickSupportNotices(ownerDb, new Date(t1 + SUPPORT_REPLY_NOTICE_DELAY_MS + MIN))
    expect(await personNoticesOf(resolved.id)).toEqual([])
  })

  it("un aviso pendiente no sale si el caso se resolvió antes de enviarlo", async () => {
    const kase = await ask("¿Cómo cambio el logo del ticket?")
    await replyToSupportCase(ownerDb, staff, kase.id, "En Medios de pago y ticket.")
    const t0 = await lastAnswerOf(kase.id)
    await tickSupportNotices(ownerDb, new Date(t0 + SUPPORT_REPLY_NOTICE_DELAY_MS + MIN))
    const [notice] = await personNoticesOf(kase.id)
    await setSupportCaseStatus(ownerDb, staff, kase.id, "resuelto")
    expect(await claimSupportNotice(ownerDb, notice!.id)).toBeNull()
    expect((await personNoticesOf(kase.id))[0]).toMatchObject({ emailState: "omitido" })
  })

  it("el caso automático «Modelo sin responder» no tiene a quién avisar: responderle o pedirle algo no detiene los avisos de las demás clínicas", async () => {
    const outage = await reportModelOutage(ownerDb, {
      orgId: ORG,
      llm: "gpt-6-luna",
      llmLabel: "ChatGPT",
      code: "PROVIDER_QUOTA",
      detail: "prueba: sin saldo",
      at: new Date(),
    })
    // Soporte le responde en público por error y lo pasa a «Esperando a la clínica».
    await replyToSupportCase(ownerDb, staff, outage.caseId, "Respondido por error en público.")
    await setSupportCaseStatus(ownerDb, staff, outage.caseId, "esperando_clinica")
    const other = await ask("¿Cómo cambio el horario para escribir?")
    await replyToSupportCase(ownerDb, staff, other.id, "En Agente › Horario para escribir.")
    const latest = Math.max(await lastAnswerOf(outage.caseId), await lastAnswerOf(other.id))
    await expect(tickSupportNotices(ownerDb, new Date(latest + SUPPORT_REPLY_NOTICE_DELAY_MS + MIN))).resolves.toBeDefined()
    expect(await personNoticesOf(outage.caseId)).toEqual([])
    expect((await personNoticesOf(other.id)).map((row) => [row.kind, row.recipientUserId])).toEqual([["respuesta", ANA]])
  })

  it("si ya no está en la clínica no se le envía; el caso lo siguen propietario y administrador", async () => {
    const kase = await ask("¿Por qué no veo la caja de ayer?", LUIS)
    await replyToSupportCase(ownerDb, staff, kase.id, "Revisa la sede elegida.")
    const t0 = await lastAnswerOf(kase.id)
    // Antes de irse, el caso es solo suyo.
    await expect(run((tx) => getMySupportCase(tx, ORG, OWNER, kase.id))).rejects.toThrow(/no encontrado/i)
    await ownerDb.delete(member).where(eq(member.id, "m-notice-luis"))

    await tickSupportNotices(ownerDb, new Date(t0 + SUPPORT_REPLY_NOTICE_DELAY_MS + MIN))
    expect(await personNoticesOf(kase.id)).toEqual([])
    expect((await run((tx) => listMySupportCases(tx, ORG, OWNER))).map((item) => item.id)).toContain(kase.id)
    expect((await run((tx) => getMySupportCase(tx, ORG, ANA, kase.id))).id).toBe(kase.id)
  })
})

describe("reclamo antes de SMTP", () => {
  it("solo uno reclama; incierto no vuelve a pendiente ni se ofrece otra vez", async () => {
    const kase = await ask("La lista de pacientes se queda cargando")
    const [notice] = await noticesOf(kase.id)
    const pendingBefore = await tickSupportNotices(ownerDb)
    expect(pendingBefore).toContainEqual({ id: notice!.id, inbox: true })

    const claimed = await claimSupportNotice(ownerDb, notice!.id)
    expect(claimed).toMatchObject({ kind: "caso_nuevo", to: null, who: "Ana Torres", screen: "Agente › Administrador" })
    // Reclamado antes de enviar: nadie más lo toma.
    expect(await claimSupportNotice(ownerDb, notice!.id)).toBeNull()
    expect((await noticesOf(kase.id))[0]).toMatchObject({ emailState: "reclamado" })

    await completeSupportNotice(ownerDb, notice!.id, false, "SMTP no respondió")
    expect((await noticesOf(kase.id))[0]).toMatchObject({ emailState: "incierto", error: "SMTP no respondió" })
    expect((await tickSupportNotices(ownerDb)).map((row) => row.id)).not.toContain(notice!.id)
    expect(await claimSupportNotice(ownerDb, notice!.id)).toBeNull()
  })

  it("la aplicación crea avisos pero no los reclama ni los cambia", async () => {
    const kase = await ask("¿Cómo agrego otra sede?")
    const [notice] = await noticesOf(kase.id)
    await expect(
      run((tx) => tx.update(supportNotice).set({ emailState: "enviado" }).where(eq(supportNotice.id, notice!.id))),
    ).rejects.toThrow()
  })
})
