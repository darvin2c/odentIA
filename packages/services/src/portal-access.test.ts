import { withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { patient, patientContact } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { portalLink } from "@odentia/db/schema/portal"
import { portalPasskey } from "@odentia/db/schema/portal-access"
import { createHash, randomBytes } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import {
  approvePortalRequest,
  createPasskeyAuthOptions,
  createPasskeyRegistrationOptions,
  createPortalGrant,
  createPublicPortalRequest,
  handlePortalChannelRequest,
  listMyPortalGrants,
  listPortalGrants,
  listPortalRequests,
  listPortalSessions,
  rejectPortalRequest,
  revokePortalGrant,
  selectPortalGrant,
  verifyPasskeyAuth,
  verifyPasskeyRegistration,
} from "./portal-access.js"
import { exchangePortalToken, issuePortalLink, requirePortalSession, revokePortalSession } from "./portal.js"
import { getPortalQuestionnaire, savePortalQuestionnaire } from "./portal-questionnaire.js"
import {
  createFormTemplate,
  finalizeFormResponse,
  listFormResponses,
  publishFormTemplate,
} from "./clinical-forms.js"
import { recordPortalPinFailure, upsertPortalPolicy } from "./portal-policy.js"
import { ServiceError } from "./errors.js"
import { listTasks } from "./tasks.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ORG = "org_portal_acc"
const ORG_OFF = "org_portal_off"
const ACTOR = "portal-actor"

let patientId: string
let patient2Id: string
let patient3Id: string
let contactId: string
let connectionId: string
let conversationId: string

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ServiceError) return error.code
    throw error
  }
  return "OK"
}

/** Enlace pendiente insertado directo con token/PIN conocidos (simula el entregado). */
async function insertPendingLink(patient: string, pin = "123456"): Promise<{ raw: string }> {
  const raw = randomBytes(32).toString("base64url")
  const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")
  await withOrgContext(appDb, ORG, (tx) =>
    tx.insert(portalLink).values({
      organizationId: ORG,
      patientId: patient,
      contactId,
      scope: { appointments: true, budgets: false, account: false, documents: [] },
      tokenHash: hash(raw),
      pinHash: hash(pin),
      status: "pendiente",
      expiresAt: new Date(Date.now() + 3600_000),
      createdBy: ACTOR,
    }),
  )
  return { raw }
}

beforeAll(async () => {
  await ownerDb.execute(sql`
    insert into "organization" ("id", "name", "slug", "created_at")
    values (${ORG}, 'Clínica Portal Acc', 'portal-acc', now()),
           (${ORG_OFF}, 'Clínica Portal Off', 'portal-off', now())
    on conflict do nothing`)
  await ownerDb.execute(sql`
    insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
    values (${ORG}, 'Clínica Portal Acc', 'PE', 'PEN', 'America/Lima', 'es-PE'), (${ORG_OFF}, 'Clínica Portal Off', 'PE', 'PEN', 'America/Lima', 'es-PE')
    on conflict do nothing`)
  await ownerDb.insert(user).values([{ id: ACTOR, name: "Recepción Portal", email: "portal-actor@example.test" }])
  await ownerDb.execute(sql`
    insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values
      ('m-portal-actor', ${ORG}, ${ACTOR}, 'owner', now()),
      ('m-portal-actor-off', ${ORG_OFF}, ${ACTOR}, 'owner', now())`)
  const [createdPatient] = await ownerDb
    .insert(patient)
    .values({ organizationId: ORG, displayName: "Paciente Portal", patientNumber: 9201 })
    .returning({ id: patient.id })
  patientId = createdPatient!.id
  const [createdPatient2] = await ownerDb
    .insert(patient)
    .values({ organizationId: ORG, displayName: "Paciente Portal Dos", patientNumber: 9202 })
    .returning({ id: patient.id })
  patient2Id = createdPatient2!.id
  const [createdPatient3] = await ownerDb
    .insert(patient)
    .values({ organizationId: ORG, displayName: "Paciente Portal Tres", patientNumber: 9203 })
    .returning({ id: patient.id })
  patient3Id = createdPatient3!.id
  const [createdContact] = await ownerDb
    .insert(contact)
    .values({ organizationId: ORG, displayName: "Contacto Portal", phone: "+51999000111" })
    .returning({ id: contact.id })
  contactId = createdContact!.id
  await withOrgContext(appDb, ORG, async (tx) => {
    await tx.insert(patientContact).values({
      organizationId: ORG,
      patientId,
      contactId,
      relationship: "family",
      createdBy: ACTOR,
    })
    const [conn] = await tx
      .insert(channelConnection)
      .values({
        organizationId: ORG,
        channel: "telegram",
        provider: "telegram_bot_api",
        displayName: "Bot Portal",
        configEncrypted: "x",
        webhookSecret: "s",
        status: "active",
      })
      .returning({ id: channelConnection.id })
    connectionId = conn!.id
    const [conv] = await tx
      .insert(conversation)
      .values({
        organizationId: ORG,
        contactId,
        channelConnectionId: connectionId,
        externalThreadId: "portal:t1",
        status: "open",
      })
      .returning({ id: conversation.id })
    conversationId = conv!.id
    await upsertPortalPolicy(tx, ORG, ACTOR, {
      enabled: true,
      requestsEnabled: true,
      publicRequestsEnabled: true,
      channelRequestsEnabled: true,
      autoApproveVerified: false,
      allowedConnectionIds: [connectionId],
      linkTtlMinutes: 4320,
      sessionTtlHours: 48,
      grantTtlDays: null,
      allowedScope: { appointments: true, budgets: true, account: true, documents: true },
      passkeysEnabled: true,
      assistedRecoveryEnabled: true,
    })
  })
}, 180_000)

it("sin política el portal está deshabilitado y la web no revela nada", async () => {
  const issue = await errorCode(
    withOrgContext(appDb, ORG_OFF, (tx) =>
      issuePortalLink(
        tx,
        ORG_OFF,
        ACTOR,
        {
          patientId: "00000000-0000-0000-0000-000000000000",
          contactId: "00000000-0000-0000-0000-000000000000",
          conversationId: "00000000-0000-0000-0000-000000000000",
          scope: { appointments: true },
        },
        { linkUrl: () => "https://x", canShareFinance: false },
      ),
    ),
  )
  expect(issue).toBe("PORTAL_DISABLED")
  const received = await withOrgContext(appDb, ORG_OFF, (tx) =>
    createPublicPortalRequest(tx, ORG_OFF, { contactName: "Alguien", contactText: "+51000" }),
  )
  expect(received).toEqual({ received: true })
  const requests = await withOrgContext(appDb, ORG_OFF, (tx) => listPortalRequests(tx, ORG_OFF))
  expect(requests).toEqual([])
})

it("la web pública nunca matchea por teléfono ni crea accesos", async () => {
  const received = await withOrgContext(appDb, ORG, (tx) =>
    createPublicPortalRequest(tx, ORG, {
      contactName: "Contacto Portal",
      contactText: "+51999000111",
      patientHint: "Paciente Portal",
    }),
  )
  expect(received).toEqual({ received: true })
  const grants = await withOrgContext(appDb, ORG, (tx) => listPortalGrants(tx, ORG, patientId))
  expect(grants).toEqual([])
  const requests = await withOrgContext(appDb, ORG, (tx) => listPortalRequests(tx, ORG))
  expect(requests).toHaveLength(1)
  expect(requests[0]?.patientName).toBeNull()
})

it("el canje exige grant verificado aunque el PIN sea correcto", async () => {
  const { raw } = await insertPendingLink(patientId)
  const code = await errorCode(
    withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, raw, { pin: "123456" })),
  )
  expect(code).toBe("PORTAL_REVOKED")
})

it("la emisión exige grant verificado y es discreta", async () => {
  await withOrgContext(appDb, ORG, (tx) =>
    createPortalGrant(tx, ORG, ACTOR, {
      patientId,
      contactId,
      relationship: "family",
      scope: { appointments: true },
      verifiedMethod: "presencial_documento",
      evidenceNote: "DNI revisado en recepción.",
    }),
  )
  const issued = await withOrgContext(appDb, ORG, (tx) =>
    issuePortalLink(
      tx,
      ORG,
      ACTOR,
      { patientId, contactId, conversationId, scope: { appointments: true } },
      { linkUrl: (token) => `https://portal.test/a/${token}`, canShareFinance: false },
    ),
  )
  expect(issued.link.status).toBe("pendiente")
  expect(issued.pinOnce).toMatch(/^\d{6}$/)
  const bodies = await withOrgContext(appDb, ORG, (tx) =>
    tx
      .select({ body: message.body })
      .from(message)
      .where(and(eq(message.conversationId, conversationId), eq(message.direction, "out"))),
  )
  const last = bodies[bodies.length - 1]?.body ?? ""
  expect(last).not.toContain("Paciente Portal")
  expect(last).not.toContain("Contacto Portal")
  const grants = await withOrgContext(appDb, ORG, (tx) => listPortalGrants(tx, ORG, patientId))
  expect(grants).toHaveLength(1)
  expect(grants[0]?.verifiedMethod).toBe("presencial_documento")
})

it("el PIN fallido no escribe en la tx; el registro separado bloquea a los 10", async () => {
  const { raw } = await insertPendingLink(patientId)
  const code = await errorCode(
    withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, raw, { pin: "000000" })),
  )
  expect(code).toBe("PORTAL_PIN_INVALID")
  const [link] = await withOrgContext(appDb, ORG, (tx) =>
    tx
      .select({ failedAttempts: portalLink.failedAttempts })
      .from(portalLink)
      .where(
        and(
          eq(portalLink.organizationId, ORG),
          eq(portalLink.tokenHash, createHash("sha256").update(raw, "utf8").digest("hex")),
        ),
      )
      .limit(1),
  )
  expect(link?.failedAttempts).toBe(0)
  let locked = false
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await withOrgContext(appDb, ORG, (tx) => recordPortalPinFailure(tx, ORG, raw))
    locked = result.locked
  }
  expect(locked).toBe(true)
  const afterLock = await errorCode(
    withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, raw, { pin: "123456" })),
  )
  expect(afterLock).toBe("PORTAL_REVOKED")
})

it("sesión, anti-escalada PIN y revocación en cascada del grant", async () => {
  const grant = await withOrgContext(appDb, ORG, (tx) =>
    createPortalGrant(tx, ORG, ACTOR, {
      patientId: patient2Id,
      contactId,
      relationship: "family",
      scope: { appointments: true },
      verifiedMethod: "presencial_documento",
      evidenceNote: "DNI revisado en recepción.",
    }),
  )
  expect(grant.status).toBe("activo")
  const { raw } = await insertPendingLink(patient2Id)
  const opened = await withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, raw, { pin: "123456" }))
  const ctx = await withOrgContext(appDb, ORG, (tx) => requirePortalSession(tx, ORG, opened.sessionToken))
  expect(ctx.session.patientId).toBe(patient2Id)
  // Anti-escalada: la sesión PIN solo ve su grant.
  const mine = await withOrgContext(appDb, ORG, (tx) => listMyPortalGrants(tx, ctx))
  expect(mine).toHaveLength(1)
  expect(mine[0]?.patientId).toBe(patient2Id)
  // Cruzar a otro grant del mismo contacto exige passkey.
  const other = await withOrgContext(appDb, ORG, (tx) => listPortalGrants(tx, ORG, patientId))
  const forbidden = await errorCode(
    withOrgContext(appDb, ORG, (tx) => selectPortalGrant(tx, ctx, other[0]!.id)),
  )
  expect(forbidden).toBe("PORTAL_FORBIDDEN")
  // Revocar el grant mata sesiones y bloquea lecturas y enlaces pendientes.
  const { raw: rawPending } = await insertPendingLink(patient2Id)
  const revoked = await withOrgContext(appDb, ORG, (tx) => revokePortalGrant(tx, ORG, ACTOR, grant.id, "Prueba"))
  expect(revoked.status).toBe("revocado")
  const dead = await errorCode(withOrgContext(appDb, ORG, (tx) => requirePortalSession(tx, ORG, opened.sessionToken)))
  expect(dead).toBe("PORTAL_REVOKED")
  const reused = await errorCode(
    withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, rawPending, { pin: "123456" })),
  )
  expect(reused).toBe("PORTAL_REVOKED")
})

it("el canal solo gestiona conexiones autorizadas y responde genérico", async () => {
  const policyBase = {
    enabled: true,
    requestsEnabled: true,
    publicRequestsEnabled: true,
    channelRequestsEnabled: true,
    autoApproveVerified: false,
    allowedConnectionIds: [] as string[],
    linkTtlMinutes: 4320,
    sessionTtlHours: 48,
    grantTtlDays: null as number | null,
    allowedScope: { appointments: true, budgets: true, account: true, documents: true },
    passkeysEnabled: true,
    assistedRecoveryEnabled: true,
  }
  await withOrgContext(appDb, ORG, (tx) => upsertPortalPolicy(tx, ORG, ACTOR, policyBase))
  const [inbound] = await withOrgContext(appDb, ORG, (tx) =>
    tx
      .insert(message)
      .values({
        organizationId: ORG,
        conversationId,
        direction: "in",
        senderKind: "contact",
        contentType: "text",
        body: "Hola, quiero mi acceso al portal por favor",
        status: "received",
      })
      .returning({ id: message.id }),
  )
  const denied = await withOrgContext(appDb, ORG, (tx) =>
    handlePortalChannelRequest(
      tx,
      ORG,
      { conversationId, messageId: inbound!.id },
      { portalUrl: () => "https://portal.test/ingresar" },
    ),
  )
  expect(denied).toBe(false)
  await withOrgContext(appDb, ORG, (tx) =>
    upsertPortalPolicy(tx, ORG, ACTOR, { ...policyBase, allowedConnectionIds: [connectionId] }),
  )
  const handled = await withOrgContext(appDb, ORG, (tx) =>
    handlePortalChannelRequest(
      tx,
      ORG,
      { conversationId, messageId: inbound!.id },
      { portalUrl: () => "https://portal.test/ingresar" },
    ),
  )
  expect(handled).toBe(true)
  const channelRequests = await withOrgContext(appDb, ORG, (tx) => listPortalRequests(tx, ORG, "pendiente"))
  const created = channelRequests.find((request) => request.channel === "conversacion")
  expect(created?.contactName).toBe("Contacto Portal")
  const replies = await withOrgContext(appDb, ORG, (tx) =>
    tx
      .select({ body: message.body })
      .from(message)
      .where(and(eq(message.conversationId, conversationId), eq(message.direction, "out"))),
  )
  const reply = replies[replies.length - 1]?.body ?? ""
  expect(reply).toContain("solicitud de acceso al portal")
  expect(reply).not.toContain("Paciente Portal")
  expect(reply).not.toContain("portal.test")
})

it("la ruta automática responde ingreso con passkey sin credenciales nuevas", async () => {
  const grants = await withOrgContext(appDb, ORG, (tx) => listPortalGrants(tx, ORG, patientId))
  expect(grants.length).toBeGreaterThan(0)
  await withOrgContext(appDb, ORG, (tx) =>
    tx.insert(portalPasskey).values({
      organizationId: ORG,
      grantId: grants[0]!.id,
      credentialId: "credencial-auto-test",
      publicKey: "c2VtaWxsYQ",
      counter: 0,
      transports: ["internal"],
      nickname: "Auto test",
    }),
  )
  await withOrgContext(appDb, ORG, (tx) =>
    upsertPortalPolicy(tx, ORG, ACTOR, {
      enabled: true,
      requestsEnabled: true,
      publicRequestsEnabled: true,
      channelRequestsEnabled: true,
      autoApproveVerified: true,
      allowedConnectionIds: [connectionId],
      linkTtlMinutes: 4320,
      sessionTtlHours: 48,
      grantTtlDays: null,
      allowedScope: { appointments: true, budgets: true, account: true, documents: true },
      passkeysEnabled: true,
      assistedRecoveryEnabled: true,
    }),
  )
  const [inbound] = await withOrgContext(appDb, ORG, (tx) =>
    tx
      .insert(message)
      .values({
        organizationId: ORG,
        conversationId,
        direction: "in",
        senderKind: "contact",
        contentType: "text",
        body: "Necesito mi acceso al portal, por favor",
        status: "received",
      })
      .returning({ id: message.id }),
  )
  const handled = await withOrgContext(appDb, ORG, (tx) =>
    handlePortalChannelRequest(
      tx,
      ORG,
      { conversationId, messageId: inbound!.id },
      { portalUrl: () => "https://portal.test/ingresar" },
    ),
  )
  expect(handled).toBe(true)
  const approved = await withOrgContext(appDb, ORG, (tx) => listPortalRequests(tx, ORG, "aprobada"))
  expect(approved.some((request) => request.channel === "conversacion")).toBe(true)
  const pending = await withOrgContext(appDb, ORG, (tx) => listPortalRequests(tx, ORG, "pendiente"))
  expect(pending.filter((request) => request.channel === "conversacion")).toHaveLength(1)
  const replies = await withOrgContext(appDb, ORG, (tx) =>
    tx
      .select({ body: message.body })
      .from(message)
      .where(and(eq(message.conversationId, conversationId), eq(message.direction, "out"))),
  )
  const reply = replies[replies.length - 1]?.body ?? ""
  expect(reply).toContain("https://portal.test/ingresar")
  expect(reply).not.toContain("portal.test/a/")
  await withOrgContext(appDb, ORG, (tx) =>
    upsertPortalPolicy(tx, ORG, ACTOR, {
      enabled: true,
      requestsEnabled: true,
      publicRequestsEnabled: true,
      channelRequestsEnabled: true,
      autoApproveVerified: false,
      allowedConnectionIds: [connectionId],
      linkTtlMinutes: 4320,
      sessionTtlHours: 48,
      grantTtlDays: null,
      allowedScope: { appointments: true, budgets: true, account: true, documents: true },
      passkeysEnabled: true,
      assistedRecoveryEnabled: true,
    }),
  )
})

it("aprobar crea vínculo+grant+enlace y liquida la tarea", async () => {
  const pending = await withOrgContext(appDb, ORG, (tx) => listPortalRequests(tx, ORG, "pendiente"))
  const web = pending.find((request) => request.channel === "web_publica")
  expect(web).toBeDefined()
  const decided = await withOrgContext(appDb, ORG, (tx) =>
    approvePortalRequest(tx, ORG, ACTOR, web!.id, {
      patientId: patient3Id,
      contactId,
      relationship: "family",
      scope: { appointments: true },
      verifiedMethod: "presencial_documento",
      evidenceNote: "DNI del apoderado revisado en recepción.",
      conversationId,
      deliver: { linkUrl: (token) => `https://portal.test/a/${token}`, canShareFinance: false },
    }),
  )
  expect(decided.grant.patientId).toBe(patient3Id)
  expect(decided.link.link.status).toBe("pendiente")
  const open = await withOrgContext(appDb, ORG, (tx) => listTasks(tx, ORG, { status: "open" }))
  const openPortal = open.filter((task) => task.title.includes("portal"))
  // La tarea de la solicitud web quedó liquidada; solo sigue abierta la del canal.
  expect(openPortal).toHaveLength(1)
  const decidedList = await withOrgContext(appDb, ORG, (tx) => listPortalRequests(tx, ORG, "aprobada"))
  expect(decidedList.some((request) => request.id === web!.id)).toBe(true)
})
it("rechazar una solicitud cierra su tarea, igual que aprobarla o que venza", async () => {
  const openPortalTasks = async () =>
    (await withOrgContext(appDb, ORG, (tx) => listTasks(tx, ORG, { status: "open" }))).filter((task) => task.title.includes("portal")).length
  const before = await openPortalTasks()
  await withOrgContext(appDb, ORG, (tx) =>
    createPublicPortalRequest(tx, ORG, { contactName: "Persona que rechazan", contactText: "+51999000222" }),
  )
  expect(await openPortalTasks()).toBe(before + 1)
  const pending = await withOrgContext(appDb, ORG, (tx) => listPortalRequests(tx, ORG, "pendiente"))
  const request = pending.find((item) => item.contactName === "Persona que rechazan")
  await withOrgContext(appDb, ORG, (tx) => rejectPortalRequest(tx, ORG, ACTOR, request!.id, "No es paciente"))
  expect(await openPortalTasks()).toBe(before)
})

it("la emisión conserva las passkeys vigentes", async () => {
  await withOrgContext(appDb, ORG, (tx) =>
    issuePortalLink(
      tx,
      ORG,
      ACTOR,
      { patientId, contactId, conversationId, scope: { appointments: true } },
      { linkUrl: (token) => `https://portal.test/a/${token}`, canShareFinance: false },
    ),
  )
  const creds = await withOrgContext(appDb, ORG, (tx) =>
    tx
      .select({ revokedAt: portalPasskey.revokedAt })
      .from(portalPasskey)
      .where(
        and(
          eq(portalPasskey.organizationId, ORG),
          eq(portalPasskey.credentialId, "credencial-auto-test"),
        ),
      )
      .limit(1),
  )
  expect(creds[0]?.revokedAt).toBeNull()
})

it("passkeys: registro con sesión Bearer; respuestas inválidas no crean nada", async () => {
  const { raw } = await insertPendingLink(patient3Id)
  const opened = await withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, raw, { pin: "123456" }))
  const ctx = await withOrgContext(appDb, ORG, (tx) => requirePortalSession(tx, ORG, opened.sessionToken))
  const rp = { rpID: "portal.test", rpName: "Clínica", expectedOrigin: "https://portal.test" }
  const registration = await withOrgContext(appDb, ORG, (tx) => createPasskeyRegistrationOptions(tx, ctx, rp))
  expect(registration.challengeId).toMatch(/^[0-9a-f-]{36}$/)
  expect(typeof registration.options["challenge"]).toBe("string")
  // Descubrible con desbloqueo real del dispositivo (sin bypass configurable).
  const selection: unknown = registration.options["authenticatorSelection"]
  if (!selection || typeof selection !== "object") throw new Error("Faltan opciones del autenticador")
  if (!("residentKey" in selection) || !("userVerification" in selection)) {
    throw new Error("Faltan residentKey/userVerification")
  }
  expect(selection.residentKey).toBe("required")
  expect(selection.userVerification).toBe("required")
  await expect(
    withOrgContext(appDb, ORG, (tx) =>
      verifyPasskeyRegistration(tx, ctx, registration.challengeId, { id: "falsa" }, rp),
    ),
  ).rejects.toThrow()
  const authentication = await withOrgContext(appDb, ORG, (tx) => createPasskeyAuthOptions(tx, ORG, rp))
  expect(authentication.options["userVerification"]).toBe("required")
  await expect(
    withOrgContext(appDb, ORG, (tx) => verifyPasskeyAuth(tx, ORG, authentication.challengeId, { id: "falsa" }, rp)),
  ).rejects.toThrow()
})

it("cuestionario previo: lo responde quien tiene la sesión, se envía completo y el equipo lo finaliza", async () => {
  await withOrgContext(appDb, ORG, async (tx) => {
    const draft = await createFormTemplate(tx, ORG, ACTOR, {
      title: "Cuestionario previo",
      respondent: "portal",
      schema: {
        sections: [
          {
            id: "salud",
            title: "Salud",
            fields: [
              { id: "alergia", label: "¿Eres alérgica a algún medicamento?", type: "booleano", required: true },
              { id: "cual", label: "¿A cuál?", type: "texto", required: true, showIf: { field: "alergia", equals: true } },
              { id: "medicamentos", label: "Medicamentos que tomas", type: "texto_largo" },
            ],
          },
        ],
      },
    })
    await publishFormTemplate(tx, ORG, ACTOR, draft.id)
  })
  await withOrgContext(appDb, ORG, (tx) =>
    createPortalGrant(tx, ORG, ACTOR, {
      patientId: patient3Id,
      contactId,
      relationship: "family",
      scope: { appointments: true },
      verifiedMethod: "presencial_documento",
      evidenceNote: "DNI revisado en recepción.",
    }),
  )
  const { raw } = await insertPendingLink(patient3Id)
  const opened = await withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, raw, { pin: "123456" }))
  const inPortal = <T>(fn: (tx: typeof appDb, ctx: Awaited<ReturnType<typeof requirePortalSession>>) => Promise<T>) =>
    withOrgContext(appDb, ORG, async (tx) => fn(tx, await requirePortalSession(tx, ORG, opened.sessionToken)))

  const first = await inPortal((tx, ctx) => getPortalQuestionnaire(tx, ctx))
  expect(first.template?.title).toBe("Cuestionario previo")
  expect(first.respondent).toMatchObject({ name: "Contacto Portal" })
  expect(first.response).toBeNull()
  // Guardar avance acepta respuestas parciales.
  const partial = await inPortal((tx, ctx) => savePortalQuestionnaire(tx, ctx, { answers: { alergia: true } }))
  expect(partial.response?.submittedAt).toBeNull()
  // Enviar exige lo obligatorio visible y nombra el campo.
  await expect(
    inPortal((tx, ctx) => savePortalQuestionnaire(tx, ctx, { answers: { alergia: true }, submit: true })),
  ).rejects.toThrow(/¿A cuál\?/)
  const sent = await inPortal((tx, ctx) =>
    savePortalQuestionnaire(tx, ctx, { answers: { alergia: true, cual: "Penicilina" }, submit: true }),
  )
  expect(sent.response?.submittedAt).toBeTruthy()
  expect(sent.response?.id).toBe(partial.response?.id)
  expect(
    await errorCode(
      inPortal((tx, ctx) => savePortalQuestionnaire(tx, ctx, { answers: { alergia: false } })),
    ),
  ).toBe("ALREADY_SUBMITTED")
  // El equipo lo ve como declarado por el portal y lo finaliza tras revisarlo.
  const responses = await withOrgContext(appDb, ORG, (tx) => listFormResponses(tx, ORG, { patientId: patient3Id }))
  expect(responses[0]).toMatchObject({ source: "portal", respondentContactId: contactId, status: "borrador" })
  expect(
    await withOrgContext(appDb, ORG, (tx) => finalizeFormResponse(tx, ORG, ACTOR, responses[0]!.id)),
  ).toMatchObject({ status: "finalizado" })
})

it("el código de 6 dígitos siempre activa el acceso; apagado, solo impide recuperarlo así", async () => {
  const [created] = await ownerDb
    .insert(patient)
    .values({ organizationId: ORG, displayName: "Paciente Portal Cuatro", patientNumber: 9204 })
    .returning({ id: patient.id })
  const patient4Id = created!.id
  const policy = (assistedRecoveryEnabled: boolean) =>
    withOrgContext(appDb, ORG, (tx) =>
      upsertPortalPolicy(tx, ORG, ACTOR, {
        enabled: true,
        requestsEnabled: true,
        publicRequestsEnabled: true,
        channelRequestsEnabled: true,
        autoApproveVerified: false,
        allowedConnectionIds: [connectionId],
        linkTtlMinutes: 4320,
        sessionTtlHours: 48,
        grantTtlDays: null,
        allowedScope: { appointments: true, budgets: true, account: true, documents: true },
        passkeysEnabled: true,
        assistedRecoveryEnabled,
      }),
    )
  await withOrgContext(appDb, ORG, async (tx) => {
    await tx.insert(patientContact).values({ organizationId: ORG, patientId: patient4Id, contactId, relationship: "family", createdBy: ACTOR })
    await createPortalGrant(tx, ORG, ACTOR, {
      patientId: patient4Id,
      contactId,
      relationship: "family",
      scope: { appointments: true },
      verifiedMethod: "presencial_documento",
      evidenceNote: "DNI revisado en recepción.",
    })
  })
  await policy(false)
  try {
    // La primera vez entra con su código aunque la clínica no recupere accesos así.
    const { raw } = await insertPendingLink(patient4Id)
    const opened = await withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, raw, { pin: "123456" }))
    expect(opened.session.patientId).toBe(patient4Id)

    // Volver a entrar con otro código es recuperarlo: el equipo no puede emitirlo
    // y un enlace que ya salió tampoco sirve. Los dos lo dicen en palabras.
    const issued = await withOrgContext(appDb, ORG, (tx) =>
      issuePortalLink(
        tx,
        ORG,
        ACTOR,
        { patientId: patient4Id, contactId, conversationId, scope: { appointments: true } },
        { linkUrl: (token) => `https://portal.test/a/${token}`, canShareFinance: false },
      ),
    ).then(() => null, (error: unknown) => error)
    expect(issued).toMatchObject({ code: "PORTAL_RECOVERY_OFF", message: expect.stringContaining("quita su acceso") })
    const { raw: again } = await insertPendingLink(patient4Id)
    expect(
      await errorCode(withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, again, { pin: "123456" }))),
    ).toBe("PORTAL_RECOVERY_OFF")

    // «Sesiones activas»: la sesión cerrada por el equipo llega con su cierre.
    await withOrgContext(appDb, ORG, (tx) => revokePortalSession(tx, ORG, ACTOR, opened.session.id))
    const sessions = await withOrgContext(appDb, ORG, (tx) => listPortalSessions(tx, ORG, { patientId: patient4Id }))
    expect(sessions.find((row) => row.id === opened.session.id)?.revokedAt).toBeInstanceOf(Date)
  } finally {
    await policy(true)
  }
  // Con la recuperación encendida, el mismo enlace vuelve a servir.
  const { raw: recovered } = await insertPendingLink(patient4Id)
  const reopened = await withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, recovered, { pin: "123456" }))
  expect(reopened.session.revokedAt).toBeNull()
})
