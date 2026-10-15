import { type Db, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
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
  ensureCaseForHelpRequest,
  getAccountSupportCase,
  getMySupportCase,
  getSupportCaseForStaff,
  grantSupportAccess,
  listMySupportCases,
  readSupportDiagnostic,
  reopenMySupportCase,
  replyToMySupportCase,
  replyToSupportCase,
  replyToSupportCasesMany,
  revokeSupportAccess,
  revokeSupportGrantAsStaff,
  setSupportCaseStatus,
  staffAttachToSupportCase,
  type HelpRequestSeed,
} from "./admin-support.js"
import { helpDedupeKeyOf, sendHelpRequest } from "./help.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/** Soporte: hilos privados por clínica, notas internas separadas y acceso delegado con permiso vigente. */
setupTestDb()
const ORG = "org_a"
const OTHER = "org_b"
const CLIENT = "support-client-a"
const OTHER_CLIENT = "support-client-b"
const OWNER = "support-owner-a"
const STAFF_ID = "support-staff"

const staff: AdminActor = { userId: STAFF_ID, role: "support" }
const storage = { attachmentUrl: async (objectKey: string) => `https://firmada.test/${objectKey}` }

function run<T>(fn: (tx: Db) => Promise<T>, org = ORG): Promise<T> {
  return withOrgContext(appDb, org, fn)
}

async function seedRequest(org: string, userId: string, question: string): Promise<HelpRequestSeed> {
  const request = await run(
    (tx) => sendHelpRequest(tx, org, { userId, roleLabel: "Recepción" }, { question, screen: "/agenda", kind: "problema" }),
    org,
  )
  return {
    id: request.id,
    userId,
    kind: request.kind,
    question: request.question,
    detail: null,
    screen: request.screen,
    role: "Recepción",
    appVersion: null,
    dedupeKey: helpDedupeKeyOf(request.question),
  }
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: CLIENT, name: "Clínica A", email: "a@support.test", emailVerified: true },
    { id: OTHER_CLIENT, name: "Clínica B", email: "b@support.test", emailVerified: true },
    { id: OWNER, name: "Dueña A", email: "duena@support.test", emailVerified: true },
    { id: STAFF_ID, name: "Soporte", email: "staff@support.test", emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: "m-support-a", userId: CLIENT, organizationId: ORG, role: "reception", createdAt: new Date() },
    { id: "m-support-owner-a", userId: OWNER, organizationId: ORG, role: "owner", createdAt: new Date() },
    { id: "m-support-b", userId: OTHER_CLIENT, organizationId: OTHER, role: "owner", createdAt: new Date() },
  ])
})

describe("conversación del caso", () => {
  it("staff responde, anota en interno y reasigna; el cliente solo ve lo público y reabre", async () => {
    const seed = await seedRequest(ORG, CLIENT, "La impresora del ticket no responde")
    const kase = await run((tx) => ensureCaseForHelpRequest(tx, ORG, seed))
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
    const kase = await run((tx) => ensureCaseForHelpRequest(tx, ORG, seed))
    await expect(run((tx) => getMySupportCase(tx, OTHER, OTHER_CLIENT, kase.id), OTHER)).rejects.toThrow(/no encontrado/i)
    await expect(run((tx) => canAccessSupportCase(tx, OTHER, OTHER_CLIENT, kase.id), OTHER)).resolves.toBe(false)
    await expect(run((tx) => listMySupportCases(tx, OTHER, OTHER_CLIENT), OTHER)).resolves.toEqual([])
  })

  it("lo colgado de una nota interna no existe para el cliente: ni metadatos ni URL", async () => {
    const seed = await seedRequest(ORG, CLIENT, "Caso con material interno del equipo")
    const kase = await run((tx) => ensureCaseForHelpRequest(tx, ORG, seed))
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
    const caseA = await run((tx) => ensureCaseForHelpRequest(tx, ORG, seedA))
    const caseB = await run((tx) => ensureCaseForHelpRequest(tx, OTHER, seedB), OTHER)
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
    const kase = await run((tx) => ensureCaseForHelpRequest(tx, ORG, seed))

    await expect(run((tx) => grantSupportAccess(tx, ORG, CLIENT, false, kase.id, 30))).rejects.toThrow(/propietario/i)
    const grant = await run((tx) => grantSupportAccess(tx, ORG, OWNER, true, kase.id, 30))
    expect(grant.active).toBe(true)

    const diagnostic = await readSupportDiagnostic(ownerDb, staff, kase.id)
    expect(diagnostic.organizationId).toBe(ORG)
    expect(diagnostic.channels).toEqual([])
    expect(diagnostic.scope).toMatch(/Nunca abre/)

    await run((tx) => revokeSupportAccess(tx, ORG, OWNER, true, grant.id))
    await expect(readSupportDiagnostic(ownerDb, staff, kase.id)).rejects.toThrow(/permiso vigente/i)
    await revokeSupportGrantAsStaff(ownerDb, staff, grant.id)
  })

  it("más de una hora se rechaza y el adjunto de otra clínica no se sirve", async () => {
    const seed = await seedRequest(ORG, CLIENT, "Adjunto con captura del error")
    const kase = await run((tx) => ensureCaseForHelpRequest(tx, ORG, seed))
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
