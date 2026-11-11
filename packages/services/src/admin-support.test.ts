import { type Db, withOrgContext } from "@odentia/db"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { supportCase, supportNotice } from "@odentia/db/schema/admin-support"
import { member, user } from "@odentia/db/schema/auth"
import { helpAsk } from "@odentia/db/schema/workspace"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import {
  accountSupportAttachmentUrl,
  addSupportInternalNote,
  assignSupportCase,
  attachToAccountSupportCase,
  attachToMySupportCase,
  canAccessSupportCase,
  clientSupportAttachmentUrl,
  createAccessSupportCase,
  getAccountSupportCase,
  getAdminSupportAttention,
  getMySupportCase,
  getSupportCaseForStaff,
  grantSupportAccess,
  listGuideGaps,
  listMySupportCases,
  listSupportCasesForStaff,
  markGuideGap,
  openSupportCaseFromHelp,
  readSupportDiagnostic,
  reopenMySupportCase,
  requestSupportAccess,
  replyToAccountSupportCase,
  replyToMySupportCase,
  replyToSupportCase,
  replyToSupportCasesMany,
  revokeSupportAccess,
  revokeSupportGrantAsStaff,
  setSupportCaseStatus,
  staffAttachToSupportCase,
  type SupportCaseListItem,
  supportHelpStats,
  supportHomeRows,
  supportKnowledgeGroups,
  unmarkGuideGap,
} from "./admin-support.js"
import { sendHelpRequest } from "./help.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Soporte: hilos privados por clínica, notas internas separadas y acceso delegado con permiso vigente. */
setupTestDb()
const ORG = "org_a"
const OTHER = "org_b"
const CLIENT = "support-client-a"
const OTHER_CLIENT = "support-client-b"
const OWNER = "support-owner-a"
const STAFF_ID = "support-staff"

const ADMIN_ID = "support-admin"
/** Una clínica por bloque de la cola: así sus listas no dependen de las otras pruebas. */
const QUEUE = "org_cola"
const FILTERS = "org_filtros"
const QUEUE_CLIENT = "support-client-cola"

const staff: AdminActor = { userId: STAFF_ID, role: "support" }
const admin: AdminActor = { userId: ADMIN_ID, role: "admin" }
const storage = { attachmentUrl: async (objectKey: string) => `https://firmada.test/${objectKey}` }

function run<T>(fn: (tx: Db) => Promise<T>, org = ORG): Promise<T> {
  return withOrgContext(appDb, org, fn)
}

async function statusOf(caseId: string): Promise<string | undefined> {
  const [row] = await ownerDb.select({ status: supportCase.status }).from(supportCase).where(eq(supportCase.id, caseId))
  return row?.status
}

/** Lo que ya salió al buzón: así un aviso nuevo no se junta con uno pendiente. */
async function inboxSent(caseId: string): Promise<void> {
  await ownerDb.update(supportNotice).set({ emailState: "enviado" }).where(eq(supportNotice.caseId, caseId))
}

async function inboxReplies(caseId: string): Promise<number> {
  const rows = await ownerDb
    .select({ id: supportNotice.id })
    .from(supportNotice)
    .where(and(eq(supportNotice.caseId, caseId), eq(supportNotice.kind, "clinica_respondio")))
  return rows.length
}

async function setCreatedAt(caseId: string, at: Date): Promise<void> {
  await ownerDb.update(supportCase).set({ createdAt: at, updatedAt: at }).where(eq(supportCase.id, caseId))
}

/** Un caso «Revisión de cobro» como el que abre «Pedir revisión» (con el importe en la pregunta). */
function seedBillingCase(question: string): Promise<SupportCaseListItem> {
  return run((tx) =>
    openSupportCaseFromHelp(tx, ORG, {
      userId: OWNER,
      kind: "cobro",
      question,
      detail: null,
      screen: "/billing/acciones",
      role: "Propietario",
      appVersion: null,
      dedupeKey: `revision:${question}`,
    }),
  )
}

/** Lo que una persona envía desde la Ayuda: abre su caso (la única fuente). */
function seedRequest(org: string, userId: string, question: string): Promise<SupportCaseListItem> {
  return run(
    (tx) => sendHelpRequest(tx, org, { userId, roleLabel: "Recepción" }, { question, screen: "/agenda", kind: "problema" }),
    org,
  )
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: CLIENT, name: "Clínica A", email: "a@support.test", emailVerified: true },
    { id: OTHER_CLIENT, name: "Clínica B", email: "b@support.test", emailVerified: true },
    { id: OWNER, name: "Dueña A", email: "duena@support.test", emailVerified: true },
    { id: STAFF_ID, name: "Soporte", email: "staff@support.test", emailVerified: true },
    { id: ADMIN_ID, name: "Administración", email: "admin@support.test", emailVerified: true },
    { id: QUEUE_CLIENT, name: "Recepción Cola", email: "cola@support.test", emailVerified: true },
  ])
  await insertOrg(ownerDb, QUEUE, "cola")
  await insertOrg(ownerDb, FILTERS, "filtros")
  await ownerDb.insert(member).values([
    { id: "m-support-a", userId: CLIENT, organizationId: ORG, role: "reception", createdAt: new Date() },
    { id: "m-support-owner-a", userId: OWNER, organizationId: ORG, role: "owner", createdAt: new Date() },
    { id: "m-support-b", userId: OTHER_CLIENT, organizationId: OTHER, role: "owner", createdAt: new Date() },
    { id: "m-support-cola", userId: QUEUE_CLIENT, organizationId: QUEUE, role: "reception", createdAt: new Date() },
    { id: "m-support-filtros", userId: QUEUE_CLIENT, organizationId: FILTERS, role: "reception", createdAt: new Date() },
  ])
})

describe("lo que Ariadna no supo", () => {
  it("cuenta por pantalla y por tema, sin el texto de nadie", async () => {
    await ownerDb.insert(helpAsk).values([
      { organizationId: ORG, userId: CLIENT, screen: "/agenda", topicId: null },
      { organizationId: OTHER, userId: OTHER_CLIENT, screen: "/agenda", topicId: null },
      { organizationId: ORG, userId: CLIENT, screen: "/people/123", topicId: null },
      { organizationId: ORG, userId: CLIENT, screen: "/home", topicId: "finanzas", helpful: false },
      { organizationId: ORG, userId: CLIENT, screen: "/home", topicId: "agenda", helpful: true },
      // Lo de hace más de 30 días ya no cuenta.
      { organizationId: ORG, userId: CLIENT, screen: "/tasks", topicId: null, createdAt: new Date(Date.now() - 40 * 86_400_000) },
      // Con Jev (ADR 0146): «ninguna» no supo; la duda resuelta con un toque cuenta una vez, como lo tocado; lo de
      // las cifras va a Argos y no es «sin respuesta».
      { organizationId: ORG, userId: CLIENT, screen: "/agenda", topicId: null, via: "jev", verdict: "ninguna" },
      { organizationId: ORG, userId: CLIENT, screen: "/inbox", topicId: null, via: "jev", verdict: "duda" },
      { organizationId: ORG, userId: CLIENT, screen: "/inbox", topicId: "agente", faq: "¿Cómo apago a Sofi?", via: "exacta" },
      { organizationId: ORG, userId: CLIENT, screen: "/finance", topicId: null, via: "jev", verdict: "datos" },
    ])
    expect(await supportHelpStats(ownerDb, staff)).toEqual({
      days: 30,
      asked: 8,
      unanswered: 4,
      notHelpful: 1,
      unansweredByScreen: [
        { name: "Agenda", total: 3 },
        { name: "Pacientes", total: 1 },
      ],
      notHelpfulByTopic: [{ name: "Finanzas", total: 1 }],
    })
  })
})

describe("conversación del caso", () => {
  it("staff responde, anota en interno y reasigna; el cliente solo ve lo público y reabre", async () => {
    const seed = await seedRequest(ORG, CLIENT, "La impresora del ticket no responde")
    const kase = seed
    expect(kase.status).toBe("abierto")

    await assignSupportCase(ownerDb, staff, kase.id, STAFF_ID)
    await replyToSupportCase(ownerDb, staff, kase.id, "Revisa que el ticket tenga nombre comercial en Medios de pago y ticket.")
    await addSupportInternalNote(ownerDb, staff, kase.id, "Parece el mismo driver que en el caso anterior.")

    const mine = await run((tx) => getMySupportCase(tx, ORG, CLIENT, kase.id))
    expect(mine.messages.map((message) => message.body)).toEqual([
      "Revisa que el ticket tenga nombre comercial en Medios de pago y ticket.",
    ])
    expect(mine.messages.every((message) => !message.isInternal)).toBe(true)

    const full = await getSupportCaseForStaff(ownerDb, staff, kase.id)
    expect(full.messages).toHaveLength(2)
    expect(full.messages.filter((message) => message.isInternal)).toHaveLength(1)

    await setSupportCaseStatus(ownerDb, staff, kase.id, "resuelto")
    await run((tx) => reopenMySupportCase(tx, ORG, CLIENT, kase.id))
    const reopened = await run((tx) => getMySupportCase(tx, ORG, CLIENT, kase.id))
    expect(reopened.status).toBe("en_atencion")
    expect(reopened.reopenedCount).toBe(1)

    const reply = await run((tx) => replyToMySupportCase(tx, ORG, CLIENT, kase.id, "Sigue sin salir el nombre"))
    expect(reply.authorKind).toBe("cliente")
  })

  it("los tenants están aislados: otra clínica no ve ni abre el caso", async () => {
    const seed = await seedRequest(ORG, CLIENT, "Caso privado de la clínica A")
    const kase = seed
    await expect(run((tx) => getMySupportCase(tx, OTHER, OTHER_CLIENT, kase.id), OTHER)).rejects.toThrow(/no encontrado/i)
    await expect(run((tx) => canAccessSupportCase(tx, OTHER, OTHER_CLIENT, kase.id), OTHER)).resolves.toBe(false)
    await expect(run((tx) => listMySupportCases(tx, OTHER, OTHER_CLIENT), OTHER)).resolves.toEqual([])
  })

  it("lo colgado de una nota interna no existe para el cliente: ni metadatos ni URL", async () => {
    const seed = await seedRequest(ORG, CLIENT, "Caso con material interno del equipo")
    const kase = seed
    const note = await addSupportInternalNote(ownerDb, staff, kase.id, "Diagnóstico interno del equipo")
    const hidden = await staffAttachToSupportCase(ownerDb, staff, kase.id, {
      messageId: note.id,
      objectKey: `support/${kase.id}/interno.png`,
      mimeType: "image/png",
      filename: "interno.png",
      size: 512,
    })
    const shown = await staffAttachToSupportCase(ownerDb, staff, kase.id, {
      objectKey: `support/${kase.id}/publico.png`,
      mimeType: "image/png",
      filename: "publico.png",
      size: 512,
    })
    const mine = await run((tx) => getMySupportCase(tx, ORG, CLIENT, kase.id))
    expect(mine.attachments.map((attachment) => attachment.id)).toEqual([shown.id])
    await expect(
      run((tx) => clientSupportAttachmentUrl(tx, ORG, CLIENT, kase.id, hidden.id, storage)),
    ).rejects.toThrow(/no encontrado/i)
    const url = await run((tx) => clientSupportAttachmentUrl(tx, ORG, CLIENT, kase.id, shown.id, storage))
    expect(url).toMatch(/^https:\/\/firmada\.test\//)
  })
})

describe("respuesta a varios casos", () => {
  it("sin confirmación exacta de destinatarias no escribe nada; con ella mantiene hilos privados", async () => {
    const seedA = await seedRequest(ORG, CLIENT, "Incidencia común: el recordatorio llega tarde")
    const seedB = await seedRequest(OTHER, OTHER_CLIENT, "Incidencia común: el recordatorio llega tarde")
    const caseA = seedA
    const caseB = seedB
    expect(caseB.id).not.toBe(caseA.id)

    await expect(
      replyToSupportCasesMany(ownerDb, staff, { caseIds: [caseA.id, caseB.id], body: "Ya está corregido.", confirmOrganizationIds: [ORG] }),
    ).rejects.toThrow(/destinatarias/)
    expect((await getSupportCaseForStaff(ownerDb, staff, caseA.id)).messages).toHaveLength(0)

    const { replied } = await replyToSupportCasesMany(ownerDb, staff, {
      caseIds: [caseA.id, caseB.id],
      body: "Ya está corregido.",
      confirmOrganizationIds: [ORG, OTHER],
    })
    expect([...replied].sort()).toEqual([caseA.id, caseB.id].sort())
    const mineA = await run((tx) => getMySupportCase(tx, ORG, CLIENT, caseA.id))
    const mineB = await run((tx) => getMySupportCase(tx, OTHER, OTHER_CLIENT, caseB.id), OTHER)
    expect(mineA.messages.map((message) => message.body)).toEqual(["Ya está corregido."])
    expect(mineB.messages.map((message) => message.body)).toEqual(["Ya está corregido."])
  })
})

describe("acceso delegado", () => {
  it("solo owner/admin autoriza; sin permiso vigente se deniega y audita; revocar corta el acceso", async () => {
    const seed = await seedRequest(ORG, CLIENT, "Necesito que revisen mi configuración")
    const kase = seed

    await expect(run((tx) => grantSupportAccess(tx, ORG, CLIENT, false, kase.id, 30))).rejects.toThrow(/propietario/i)
    const grant = await run((tx) => grantSupportAccess(tx, ORG, OWNER, true, kase.id, 30))
    expect(grant.active).toBe(true)

    const diagnostic = await readSupportDiagnostic(ownerDb, staff, kase.id)
    expect(diagnostic.organizationId).toBe(ORG)
    expect(diagnostic.channels).toEqual([])
    expect(diagnostic.scope).toMatch(/Nunca abre/)
    // Los roles llegan en español, en el producto de la clínica.
    expect(diagnostic.membersByRole).toEqual(
      expect.arrayContaining([
        { role: "owner", label: "Propietario", total: 1 },
        { role: "reception", label: "Recepción", total: 1 },
      ]),
    )

    await run((tx) => revokeSupportAccess(tx, ORG, OWNER, true, grant.id))
    await expect(readSupportDiagnostic(ownerDb, staff, kase.id)).rejects.toThrow(/permiso vigente/i)
    await revokeSupportGrantAsStaff(ownerDb, staff, grant.id)
  })

  it("más de una hora se rechaza y el adjunto de otra clínica no se sirve", async () => {
    const seed = await seedRequest(ORG, CLIENT, "Adjunto con captura del error")
    const kase = seed
    await expect(run((tx) => grantSupportAccess(tx, ORG, OWNER, true, kase.id, 61))).rejects.toThrow(/60/)
    const attachment = await run((tx) =>
      attachToMySupportCase(tx, ORG, CLIENT, kase.id, {
        objectKey: `support/${kase.id}/captura.png`,
        mimeType: "image/png",
        filename: "captura.png",
        size: 1024,
      }),
    )
    const url = await run((tx) => clientSupportAttachmentUrl(tx, ORG, CLIENT, kase.id, attachment.id, storage))
    expect(url).toMatch(/^https:\/\/firmada\.test\//)
    await expect(
      run((tx) => clientSupportAttachmentUrl(tx, OTHER, OTHER_CLIENT, kase.id, attachment.id, storage), OTHER),
    ).rejects.toThrow(/no encontrado/i)
  })
})

describe("lo que hace la clínica vuelve el caso a nosotros", () => {
  it("su respuesta saca el caso de «Esperando a la clínica», en la clínica y en la cuenta", async () => {
    const kase = await seedRequest(ORG, CLIENT, "No me llegan los recordatorios de cita")
    await replyToSupportCase(ownerDb, staff, kase.id, "¿Desde qué día?")
    await setSupportCaseStatus(ownerDb, staff, kase.id, "esperando_clinica")
    await run((tx) => replyToMySupportCase(tx, ORG, CLIENT, kase.id, "Desde el lunes"))
    expect(await statusOf(kase.id)).toBe("en_atencion")

    const account = await createAccessSupportCase(ownerDb, OTHER_CLIENT, { question: "No puedo cambiar mi correo" })
    await setSupportCaseStatus(ownerDb, staff, account.id, "esperando_clinica")
    await replyToAccountSupportCase(ownerDb, OTHER_CLIENT, account.id, "Ya lo intenté otra vez")
    expect(await statusOf(account.id)).toBe("en_atencion")
  })

  it("autorizar el acceso o adjuntar sin escribir también es responder, y avisa al buzón", async () => {
    const granted = await seedRequest(ORG, CLIENT, "No puedo imprimir el ticket desde Caja")
    await setSupportCaseStatus(ownerDb, staff, granted.id, "esperando_clinica")
    await inboxSent(granted.id)
    await run((tx) => grantSupportAccess(tx, ORG, OWNER, true, granted.id, 30))
    expect(await statusOf(granted.id)).toBe("en_atencion")
    expect(await inboxReplies(granted.id)).toBe(1)

    const attached = await seedRequest(ORG, CLIENT, "Les mando la captura del error de Caja")
    await setSupportCaseStatus(ownerDb, staff, attached.id, "esperando_clinica")
    await inboxSent(attached.id)
    await run((tx) =>
      attachToMySupportCase(tx, ORG, CLIENT, attached.id, {
        objectKey: `support/${attached.id}/caja.png`,
        mimeType: "image/png",
        filename: "caja.png",
        size: 1024,
      }),
    )
    expect(await statusOf(attached.id)).toBe("en_atencion")
    expect(await inboxReplies(attached.id)).toBe(1)
  })
})

describe("la cola de soporte", () => {
  it("soporte no ve los casos de cobro en ningún lado; la administración sí", async () => {
    const billing = await seedBillingCase("Revisión de cobro · Conversación del 2026-11-02 · 0,40 USD · No la pedí")
    const seen = await listSupportCasesForStaff(ownerDb, staff, { limit: 100 })
    expect(seen.items.map((item) => item.id)).not.toContain(billing.id)
    expect(JSON.stringify(seen)).not.toContain("USD")
    await expect(getSupportCaseForStaff(ownerDb, staff, billing.id)).rejects.toThrow(/no encontrado/i)
    await expect(replyToSupportCase(ownerDb, staff, billing.id, "Lo revisamos")).rejects.toThrow(/no encontrado/i)
    await expect(addSupportInternalNote(ownerDb, staff, billing.id, "Nota")).rejects.toThrow(/no encontrado/i)
    await expect(assignSupportCase(ownerDb, staff, billing.id, STAFF_ID)).rejects.toThrow(/no encontrado/i)
    await expect(setSupportCaseStatus(ownerDb, staff, billing.id, "en_atencion")).rejects.toThrow(/no encontrado/i)
    await expect(readSupportDiagnostic(ownerDb, staff, billing.id)).rejects.toThrow(/no encontrado/i)
    const knowledge = await supportKnowledgeGroups(ownerDb, staff)
    expect(knowledge.some((group) => group.kind === "cobro")).toBe(false)
    expect(JSON.stringify(knowledge)).not.toContain("USD")
    const home = await supportHomeRows(ownerDb, staff)
    expect(home.map((row) => row.id)).not.toContain(billing.id)
    expect(JSON.stringify(home)).not.toContain("USD")

    const adminList = await listSupportCasesForStaff(ownerDb, admin, { limit: 100 })
    expect(adminList.items.map((item) => item.id)).toContain(billing.id)
    expect((await getSupportCaseForStaff(ownerDb, admin, billing.id)).question).toContain("USD")
    expect((await supportHomeRows(ownerDb, admin)).map((row) => row.id)).toContain(billing.id)
    expect((await supportKnowledgeGroups(ownerDb, admin)).some((group) => group.kind === "cobro")).toBe(true)
    const forStaff = await getAdminSupportAttention(ownerDb, staff)
    const forAdmin = await getAdminSupportAttention(ownerDb, admin)
    expect(forAdmin.openCount).toBe(forStaff.openCount + 1)
    expect(await getAdminSupportAttention(ownerDb)).toEqual(forStaff)
  })

  it("lo ya respondido no nos espera hasta que la clínica vuelve a escribir, desde ese mensaje", async () => {
    const kase = await seedRequest(QUEUE, QUEUE_CLIENT, "El odontograma no guarda la pieza 18")
    const waitingIds = async () => (await supportHomeRows(ownerDb, staff)).map((row) => row.id)
    expect(await waitingIds()).toContain(kase.id)
    const before = await getAdminSupportAttention(ownerDb, staff)

    await replyToSupportCase(ownerDb, staff, kase.id, "¿Qué navegador usas?")
    expect(await statusOf(kase.id)).toBe("en_atencion")
    expect(await waitingIds()).not.toContain(kase.id)
    expect((await getAdminSupportAttention(ownerDb, staff)).openCount).toBe(before.openCount - 1)

    const message = await run((tx) => replyToMySupportCase(tx, QUEUE, QUEUE_CLIENT, kase.id, "Chrome, en la computadora de recepción"), QUEUE)
    const row = (await supportHomeRows(ownerDb, staff)).find((item) => item.id === kase.id)
    expect(row?.waitingSince).toBe(message.createdAt)
    expect((await getAdminSupportAttention(ownerDb, staff)).openCount).toBe(before.openCount)
    const listed = (await listSupportCasesForStaff(ownerDb, staff, { organizationId: QUEUE })).items.find((item) => item.id === kase.id)
    expect(listed).toMatchObject({ waitingOnUs: true, waitingSince: message.createdAt })
  })

  it("ordena por la espera más larga, después lo que espera a la clínica, y deja fuera lo resuelto", async () => {
    const day = 86_400_000
    const now = Date.now()
    const oldest = await seedRequest(FILTERS, QUEUE_CLIENT, "Orden: el más viejo sin responder")
    await setCreatedAt(oldest.id, new Date(now - 3 * day))
    const newer = await seedRequest(FILTERS, QUEUE_CLIENT, "Orden: el más nuevo sin responder")
    await setCreatedAt(newer.id, new Date(now - day))
    // Abierto hace 5 días y respondido: nos espera solo desde que la clínica volvió a escribir.
    const answered = await seedRequest(FILTERS, QUEUE_CLIENT, "Orden: respondido y la clínica volvió a escribir")
    await setCreatedAt(answered.id, new Date(now - 5 * day))
    await replyToSupportCase(ownerDb, staff, answered.id, "Prueba otra vez")
    await run((tx) => replyToMySupportCase(tx, FILTERS, QUEUE_CLIENT, answered.id, "Sigue igual"), FILTERS)
    const asked = await seedRequest(FILTERS, QUEUE_CLIENT, "Orden: esperamos a la clínica")
    await setSupportCaseStatus(ownerDb, staff, asked.id, "esperando_clinica")
    const solved = await seedRequest(FILTERS, QUEUE_CLIENT, "Orden: ya resuelto")
    await setSupportCaseStatus(ownerDb, staff, solved.id, "resuelto")

    const queue = await listSupportCasesForStaff(ownerDb, staff, { organizationId: FILTERS })
    expect(queue.items.map((item) => item.id)).toEqual([oldest.id, newer.id, answered.id, asked.id])
    expect(queue.resolvedCount).toBe(1)
    expect(queue.items.map((item) => item.waitingOnUs)).toEqual([true, true, true, false])
    const home = (await supportHomeRows(ownerDb, staff)).filter((row) => row.organizationId === FILTERS)
    expect(home.map((row) => row.id)).toEqual([oldest.id, newer.id, answered.id])
    const resolved = await listSupportCasesForStaff(ownerDb, staff, { organizationId: FILTERS, status: "resuelto" })
    expect(resolved.items.map((item) => item.id)).toEqual([solved.id])

    // Los filtros: los míos, sin responsable y uno por id.
    await assignSupportCase(ownerDb, staff, newer.id, STAFF_ID)
    await assignSupportCase(ownerDb, admin, oldest.id, ADMIN_ID)
    const ids = async (assignee: string) =>
      (await listSupportCasesForStaff(ownerDb, staff, { organizationId: FILTERS, assignee })).items.map((item) => item.id)
    expect(await ids("me")).toEqual([newer.id])
    expect(await ids(ADMIN_ID)).toEqual([oldest.id])
    expect(await ids("none")).toEqual([answered.id, asked.id])
    expect((await supportHomeRows(ownerDb, staff)).find((row) => row.id === newer.id)?.assigneeName).toBe("Soporte")
  })

  it("«Responder hasta» es la apertura más 2 días hábiles, mientras nadie respondió y si lo abrió una persona", async () => {
    const kase = await seedRequest(QUEUE, QUEUE_CLIENT, "Plazo: el viernes abre un caso")
    await setCreatedAt(kase.id, new Date("2026-11-13T15:00:00.000Z"))
    const itemOf = async (id: string, actor: AdminActor = staff) =>
      (await listSupportCasesForStaff(ownerDb, actor, { limit: 100 })).items.find((item) => item.id === id)
    expect((await itemOf(kase.id))?.answerBy).toBe("2026-11-17T15:00:00.000Z")
    expect((await supportHomeRows(ownerDb, staff)).find((row) => row.id === kase.id)?.answerBy).toBe("2026-11-17T15:00:00.000Z")
    await replyToSupportCase(ownerDb, staff, kase.id, "Ya lo vemos")
    expect((await itemOf(kase.id))?.answerBy).toBeNull()
    expect((await itemOf(kase.id))?.lastStaffReplyAt).not.toBeNull()

    // El automático de odentIA («Modelo sin responder») no es de ninguna clínica ni tiene plazo.
    const [automatic] = await ownerDb
      .insert(supportCase)
      .values({ organizationId: null, kind: "problema", question: "Modelo sin responder · Plazo", dedupeKey: "plazo-automatico" })
      .returning()
    if (!automatic) throw new Error("sin caso automático")
    expect((await itemOf(automatic.id))?.answerBy).toBeNull()
    const home = (await supportHomeRows(ownerDb, staff)).find((row) => row.id === automatic.id)
    expect(home).toMatchObject({ organizationName: "odentIA · automático", answerBy: null })
  })
})

describe("pedir acceso de diagnóstico", () => {
  it("dos pedidos dejan un solo mensaje y pasan el caso a esperar a la clínica", async () => {
    const kase = await seedRequest(ORG, CLIENT, "Pedir acceso: no puedo imprimir el ticket desde Caja")
    const before = await getSupportCaseForStaff(ownerDb, staff, kase.id)
    // Lo abrió recepción: el texto dice quién lo autoriza y la ficha, a quién.
    expect(before).toMatchObject({
      opener: { name: "Clínica A", roleLabel: "Recepción" },
      openerCanGrant: false,
      granters: [{ name: "Dueña A", roleLabel: "Propietario" }],
      accessRequestPending: false,
      accessRequestBlocked: null,
    })
    expect(before.accessRequestText).toMatch(/Lo autoriza la propietaria o un administrador/)

    const first = await requestSupportAccess(ownerDb, staff, kase.id)
    const again = await requestSupportAccess(ownerDb, staff, kase.id)
    expect(first.repeated).toBe(false)
    expect(again).toEqual({ requestedAt: first.requestedAt, repeated: true })
    const after = await getSupportCaseForStaff(ownerDb, staff, kase.id)
    expect(after.messages.map((message) => message.body)).toEqual([before.accessRequestText])
    expect(after).toMatchObject({ status: "esperando_clinica", accessRequestPending: true, accessRequestText: null })
    expect(after.accessRequestedAt).toBe(first.requestedAt)

    // La propietaria autoriza sin escribir: el caso vuelve a nosotros y ya hay acceso vigente.
    await run((tx) => grantSupportAccess(tx, ORG, OWNER, true, kase.id, 30))
    expect(await statusOf(kase.id)).toBe("en_atencion")
    const row = (await supportHomeRows(ownerDb, staff)).find((item) => item.id === kase.id)
    expect(row?.accessUntil).not.toBeNull()
    await expect(requestSupportAccess(ownerDb, staff, kase.id)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/^Ya hay un acceso vigente hasta las \d\d:\d\d$/) })
  })

  it("dos pedidos a la vez (un doble clic, dos pestañas) dejan un solo mensaje y una sola auditoría", async () => {
    const kase = await seedRequest(ORG, CLIENT, "Pedir acceso: dos pedidos en el mismo instante")
    // Cada uno en su transacción, como la ruta: llegan juntos y ninguno ha escrito todavía.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => ownerDb.transaction((tx) => requestSupportAccess(tx, staff, kase.id))),
    )
    expect(results.filter((result) => !result.repeated)).toHaveLength(1)
    const [first] = results.filter((result) => !result.repeated)
    for (const result of results) expect(result.requestedAt).toBe(first?.requestedAt)
    const after = await getSupportCaseForStaff(ownerDb, staff, kase.id)
    expect(after.messages).toHaveLength(1)
    const audits = await ownerDb
      .select({ id: adminAudit.id })
      .from(adminAudit)
      .where(and(eq(adminAudit.action, "support.case.access_requested"), eq(adminAudit.entityId, kase.id)))
    expect(audits).toHaveLength(1)
  })

  it("no se pide en un caso de cobro, de entrar a su cuenta o resuelto", async () => {
    const billing = await seedBillingCase("Revisión de cobro · Pedir acceso · 0,10 USD")
    await expect(requestSupportAccess(ownerDb, admin, billing.id)).rejects.toThrow(/cobro/)
    await expect(requestSupportAccess(ownerDb, staff, billing.id)).rejects.toThrow(/no encontrado/i)
    const account = await createAccessSupportCase(ownerDb, OTHER_CLIENT, { question: "Pedir acceso: no entro a mi cuenta" })
    await expect(requestSupportAccess(ownerDb, staff, account.id)).rejects.toThrow(/clínica/)
    const solved = await seedRequest(ORG, CLIENT, "Pedir acceso: ya resuelto")
    await setSupportCaseStatus(ownerDb, staff, solved.id, "resuelto")
    await expect(requestSupportAccess(ownerDb, staff, solved.id)).rejects.toThrow(/resuelto/)
    expect((await getSupportCaseForStaff(ownerDb, staff, solved.id)).messages).toHaveLength(0)
  })

  it("desde el pedido, la propietaria lee el caso que abrió recepción; antes no", async () => {
    const kase = await seedRequest(ORG, CLIENT, "Pedir acceso: la propietaria lo ve después")
    const ownerSees = async () => (await run((tx) => listMySupportCases(tx, ORG, OWNER))).map((item) => item.id)
    expect(await ownerSees()).not.toContain(kase.id)
    await expect(run((tx) => getMySupportCase(tx, ORG, OWNER, kase.id))).rejects.toThrow(/no encontrado/i)
    await requestSupportAccess(ownerDb, staff, kase.id)
    expect(await ownerSees()).toContain(kase.id)
    const read = await run((tx) => getMySupportCase(tx, ORG, OWNER, kase.id))
    expect(read.accessRequestedAt).not.toBeNull()
    expect(read.messages).toHaveLength(1)
    // Otra clínica sigue sin verlo.
    await expect(run((tx) => getMySupportCase(tx, OTHER, OTHER_CLIENT, kase.id), OTHER)).rejects.toThrow(/no encontrado/i)
  })
})

describe("falta en la guía", () => {
  it("se marca, sale en «Para llevar a la guía» con su tema, se quita y se vuelve a poner", async () => {
    const kase = await seedRequest(ORG, CLIENT, "Guía: ¿cómo cambio la duración de una cita?")
    await markGuideGap(ownerDb, staff, kase.id)
    await markGuideGap(ownerDb, staff, kase.id)
    const listed = (await listGuideGaps(ownerDb, staff)).filter((item) => item.caseId === kase.id)
    expect(listed).toEqual([{ caseId: kase.id, question: kase.question, kind: "problema", topic: "Agenda", markedAt: expect.any(String) }])
    expect((await getSupportCaseForStaff(ownerDb, staff, kase.id)).guideGapMarkedAt).toBe(listed[0]?.markedAt)
    await unmarkGuideGap(ownerDb, staff, kase.id)
    expect((await listGuideGaps(ownerDb, staff)).map((item) => item.caseId)).not.toContain(kase.id)
    expect((await getSupportCaseForStaff(ownerDb, staff, kase.id)).guideGapMarkedAt).toBeNull()
    // «Deshacer» la vuelve a poner.
    await markGuideGap(ownerDb, staff, kase.id)
    expect((await listGuideGaps(ownerDb, staff)).map((item) => item.caseId)).toContain(kase.id)
  })

  it("soporte no ve ni marca los casos de cobro; la administración sí", async () => {
    const billing = await seedBillingCase("Revisión de cobro · Guía · 0,20 USD")
    await expect(markGuideGap(ownerDb, staff, billing.id)).rejects.toThrow(/no encontrado/i)
    await markGuideGap(ownerDb, admin, billing.id)
    const forStaff = await listGuideGaps(ownerDb, staff)
    expect(forStaff.map((item) => item.caseId)).not.toContain(billing.id)
    expect(JSON.stringify(forStaff)).not.toContain("USD")
    expect((await listGuideGaps(ownerDb, admin)).map((item) => item.caseId)).toContain(billing.id)
  })
})

describe("casos de acceso de la cuenta", () => {
  it("adjunta y descarga lo propio; lo interno del equipo no se expone", async () => {
    const kase = await createAccessSupportCase(ownerDb, OTHER_CLIENT, { question: "No puedo entrar a mi clínica" })
    expect(kase.kind).toBe("acceso")
    const shown = await attachToAccountSupportCase(ownerDb, OTHER_CLIENT, kase.id, {
      objectKey: `support/${kase.id}/error.png`,
      mimeType: "image/png",
      filename: "error.png",
      size: 512,
    })
    const note = await addSupportInternalNote(ownerDb, staff, kase.id, "Revisar identidad por otro canal")
    const hidden = await staffAttachToSupportCase(ownerDb, staff, kase.id, {
      messageId: note.id,
      objectKey: `support/${kase.id}/nota.png`,
      mimeType: "image/png",
      filename: "nota.png",
      size: 512,
    })
    const mine = await getAccountSupportCase(ownerDb, OTHER_CLIENT, kase.id)
    expect(mine.attachments.map((attachment) => attachment.id)).toEqual([shown.id])
    await expect(accountSupportAttachmentUrl(ownerDb, OTHER_CLIENT, kase.id, hidden.id, storage)).rejects.toThrow(
      /no encontrado/i,
    )
    const url = await accountSupportAttachmentUrl(ownerDb, OTHER_CLIENT, kase.id, shown.id, storage)
    expect(url).toMatch(/^https:\/\/firmada\.test\//)
    await expect(accountSupportAttachmentUrl(ownerDb, CLIENT, kase.id, shown.id, storage)).rejects.toThrow(/no encontrado/i)
  })
})

describe("Inicio y el número del menú", () => {
  it("con más de 50 casos que nos esperan, Inicio los trae todos: el mismo número del menú", async () => {
    await ownerDb.insert(supportCase).values(
      Array.from({ length: 55 }, (_, index) => ({
        organizationId: QUEUE,
        kind: "pregunta",
        question: `Muchos casos: pregunta ${index + 1}`,
        dedupeKey: `muchos-casos-${index + 1}`,
        openedBy: QUEUE_CLIENT,
      })),
    )
    const rows = await supportHomeRows(ownerDb, staff)
    expect(rows.length).toBeGreaterThan(55)
    expect(rows.length).toBe((await getAdminSupportAttention(ownerDb, staff)).openCount)
  })
})
