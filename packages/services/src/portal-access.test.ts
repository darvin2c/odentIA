import { withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { patientContact, patientResponsibility } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { portalLink, portalSession } from "@odentia/db/schema/portal"
import { portalGrant, portalPasskey } from "@odentia/db/schema/portal-access"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { and, eq, sql } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import {
  createPasskeyAuthOptions,
  createPasskeyRegistrationOptions,
  createPortalGrant,
  getPortalAccessSummary,
  givePortalAccess,
  listMyPortalGrants,
  listPortalGrants,
  listPortalSessions,
  requestPortalReentry,
  resendPortalAccess,
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
import { patientPersonId } from "./patients.js"
import { revokeResponsibility } from "./responsibilities.js"
import { getWorkspaceHome, type WorkspaceAccess } from "./workspace.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients, setTestPatientIdentity } from "./test-patient.js"

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

/** El contacto pasa a ser representante legal vigente del paciente. */
async function represent(tx: Parameters<Parameters<typeof withOrgContext>[2]>[0], patient: string): Promise<void> {
  await tx.insert(patientResponsibility).values({
    organizationId: ORG,
    patientId: patient,
    contactId,
    kind: "representante_legal",
    startsAt: "2020-01-01",
    createdBy: ACTOR,
  })
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
  const [createdPatient] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Paciente Portal", patientNumber: 9201 })
  patientId = createdPatient!.id
  const [createdPatient2] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Paciente Portal Dos", patientNumber: 9202 })
  patient2Id = createdPatient2!.id
  const [createdPatient3] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Paciente Portal Tres", patientNumber: 9203 })
  patient3Id = createdPatient3!.id
  const [createdContact] = await ownerDb
    .insert(contact)
    .values({ organizationId: ORG, displayName: "Contacto Portal", phone: "+51999000111" })
    .returning({ id: contact.id })
  contactId = createdContact!.id
  await withOrgContext(appDb, ORG, async (tx) => {
    // Quien entra al portal decide por los pacientes: es su representante legal vigente.
    for (const id of [patientId, patient2Id, patient3Id]) {
      await tx.insert(patientContact).values({ organizationId: ORG, patientId: id, contactId, relationship: "guardian", createdBy: ACTOR })
      await represent(tx, id)
    }
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
      allowedScope: { appointments: true, budgets: true, account: true, documents: true },
    })
  })
}, 180_000)

const NO_RIGHTS = { canShareBudgets: false, canShareAccount: false, canShareDocuments: false }

it("sin política el portal está apagado", async () => {
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
        { linkUrl: () => "https://x", ...NO_RIGHTS },
      ),
    ),
  )
  expect(issue).toBe("PORTAL_DISABLED")
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
      relationship: "guardian",
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
      { linkUrl: (token) => `https://portal.test/a/${token}`, ...NO_RIGHTS },
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
      relationship: "guardian",
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

it("la emisión conserva las passkeys vigentes", async () => {
  const grants = await withOrgContext(appDb, ORG, (tx) => listPortalGrants(tx, ORG, patientId))
  await withOrgContext(appDb, ORG, (tx) =>
    tx.insert(portalPasskey).values({
      organizationId: ORG,
      grantId: grants.find((grant) => grant.status === "activo")!.id,
      credentialId: "credencial-auto-test",
      publicKey: "c2VtaWxsYQ",
      counter: 0,
      transports: ["internal"],
      nickname: "Auto test",
    }),
  )
  await withOrgContext(appDb, ORG, (tx) =>
    issuePortalLink(
      tx,
      ORG,
      ACTOR,
      { patientId, contactId, conversationId, scope: { appointments: true } },
      { linkUrl: (token) => `https://portal.test/a/${token}`, ...NO_RIGHTS },
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
  await withOrgContext(appDb, ORG, (tx) =>
    createPortalGrant(tx, ORG, ACTOR, {
      patientId: patient3Id,
      contactId,
      relationship: "guardian",
      scope: { appointments: true },
      verifiedMethod: "presencial_documento",
    }),
  )
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
      relationship: "guardian",
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

it("el código de 6 dígitos siempre activa el acceso, también para volver a entrar", async () => {
  const [created] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Paciente Portal Cuatro", patientNumber: 9204 })
  const patient4Id = created!.id
  await withOrgContext(appDb, ORG, async (tx) => {
    await tx.insert(patientContact).values({ organizationId: ORG, patientId: patient4Id, contactId, relationship: "guardian", createdBy: ACTOR })
    await represent(tx, patient4Id)
    await createPortalGrant(tx, ORG, ACTOR, {
      patientId: patient4Id,
      contactId,
      relationship: "guardian",
      scope: { appointments: true },
      verifiedMethod: "presencial_documento",
    })
  })
  const { raw } = await insertPendingLink(patient4Id)
  const opened = await withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, raw, { pin: "123456" }))
  expect(opened.session.patientId).toBe(patient4Id)
  // La sesión dura 48 horas: es un valor fijo, no una opción de la clínica.
  const hours = (opened.session.expiresAt.getTime() - Date.now()) / 3_600_000
  expect(hours).toBeGreaterThan(47)
  expect(hours).toBeLessThanOrEqual(48)

  // Volver a entrar con un enlace nuevo y otro código siempre se puede.
  const issued = await withOrgContext(appDb, ORG, (tx) =>
    issuePortalLink(
      tx,
      ORG,
      ACTOR,
      { patientId: patient4Id, contactId, conversationId, scope: { appointments: true } },
      { linkUrl: (token) => `https://portal.test/a/${token}`, ...NO_RIGHTS },
    ),
  )
  expect(issued.pinOnce).toMatch(/^\d{6}$/)
  const { raw: again } = await insertPendingLink(patient4Id)
  const reopened = await withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, again, { pin: "123456" }))
  expect(reopened.session.revokedAt).toBeNull()

  // «Entró el …» en la fila de acceso sale de sus sesiones.
  const summary = await withOrgContext(appDb, ORG, (tx) => getPortalAccessSummary(tx, ORG, patient4Id))
  expect(summary.access[0]?.lastEntryAt).toBeInstanceOf(Date)

  // «Sesiones activas»: la sesión cerrada por el equipo llega con su cierre.
  await withOrgContext(appDb, ORG, (tx) => revokePortalSession(tx, ORG, ACTOR, opened.session.id))
  const sessions = await withOrgContext(appDb, ORG, (tx) => listPortalSessions(tx, ORG, { patientId: patient4Id }))
  expect(sessions.find((row) => row.id === opened.session.id)?.revokedAt).toBeInstanceOf(Date)
})

/** Una persona adulta con su ficha propia y su documento, que escribe por WhatsApp. */
async function adultWithDocument(number: number, doc: string | null): Promise<{ patientId: string; personId: string }> {
  const [created] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: `Adulta ${number}`, patientNumber: number, birthDate: "1990-05-05" })
  const personId = await withOrgContext(appDb, ORG, (tx) => patientPersonId(tx, ORG, created!.id))
  if (!personId) throw new Error("Sin persona propia")
  if (doc) {
    await setTestPatientIdentity(ownerDb, created!.id, { docType: "DNI", docNumber: doc, docCountry: "PE" })
  }
  return { patientId: created!.id, personId }
}

it("dar acceso en un paso: su documento a la vista, recepción comparte presupuestos y el código va aparte", async () => {
  const sin = await adultWithDocument(9301, null)
  // Sin documento no se puede comprobar su identidad.
  expect(
    await errorCode(
      withOrgContext(appDb, ORG, (tx) =>
        givePortalAccess(
          tx,
          ORG,
          ACTOR,
          sin.patientId,
          { contactId: sin.personId, scope: { appointments: true }, identityChecked: true, delivery: "qr" },
          { linkUrl: (token) => `https://portal.test/a/${token}`, ...NO_RIGHTS },
        ),
      ),
    ),
  ).toBe("VALIDATION")

  const con = await adultWithDocument(9302, "47120836")
  const summary = await withOrgContext(appDb, ORG, (tx) => getPortalAccessSummary(tx, ORG, con.patientId))
  // El documento se dice con su tipo y sin el número entero.
  expect(summary.candidates).toEqual([
    expect.objectContaining({ contactId: con.personId, relation: "self", document: "DNI 4•••••36", whatsappReady: false }),
  ])
  const rights = { canShareBudgets: true, canShareAccount: false, canShareDocuments: false }
  // Sin marcar la comprobación no se da.
  expect(
    await errorCode(
      withOrgContext(appDb, ORG, (tx) =>
        givePortalAccess(
          tx,
          ORG,
          ACTOR,
          con.patientId,
          { contactId: con.personId, scope: { appointments: true }, identityChecked: false, delivery: "qr" },
          { linkUrl: (token) => `https://portal.test/a/${token}`, ...rights },
        ),
      ),
    ),
  ).toBe("VALIDATION")
  // La cuenta pide caja: recepción no la comparte.
  expect(
    await errorCode(
      withOrgContext(appDb, ORG, (tx) =>
        givePortalAccess(
          tx,
          ORG,
          ACTOR,
          con.patientId,
          { contactId: con.personId, scope: { appointments: true, account: true }, identityChecked: true, delivery: "qr" },
          { linkUrl: (token) => `https://portal.test/a/${token}`, ...rights },
        ),
      ),
    ),
  ).toBe("PORTAL_FORBIDDEN")
  const given = await withOrgContext(appDb, ORG, (tx) =>
    givePortalAccess(
      tx,
      ORG,
      ACTOR,
      con.patientId,
      { contactId: con.personId, scope: { appointments: true, budgets: true }, identityChecked: true, delivery: "qr" },
      { linkUrl: (token) => `https://portal.test/a/${token}`, ...rights },
    ),
  )
  expect(given.activationUrlOnce).toMatch(/^https:\/\/portal\.test\/a\//)
  expect(given.pinOnce).toMatch(/^\d{6}$/)
  // El código nunca viaja con el enlace.
  expect(given.activationUrlOnce).not.toContain(given.pinOnce)
  const after = await withOrgContext(appDb, ORG, (tx) => getPortalAccessSummary(tx, ORG, con.patientId))
  expect(after.access).toEqual([
    expect.objectContaining({ contactId: con.personId, relation: "self", saved: false, lastEntryAt: null }),
  ])
  expect(after.access[0]?.scope).toMatchObject({ appointments: true, budgets: true, account: false })
})

it("pedir volver al portal por el chat deja el pedido en «Te espera» y lo atiende una persona", async () => {
  const lucia = await adultWithDocument(9303, "40000004")
  const [conv] = await withOrgContext(appDb, ORG, (tx) =>
    tx
      .insert(conversation)
      .values({ organizationId: ORG, contactId: lucia.personId, channelConnectionId: connectionId, externalThreadId: "portal:lucia", status: "open" })
      .returning({ id: conversation.id }),
  )
  // Sin acceso vigente no hay nada que reenviar: se da en la clínica.
  expect(
    await withOrgContext(appDb, ORG, (tx) => requestPortalReentry(tx, ORG, { contactId: lucia.personId, conversationId: conv!.id })),
  ).toEqual({ status: "sin_acceso", names: [] })
  const grant = await withOrgContext(appDb, ORG, (tx) =>
    createPortalGrant(tx, ORG, ACTOR, {
      patientId: lucia.patientId,
      contactId: lucia.personId,
      scope: { appointments: true },
      verifiedMethod: "presencial_documento",
    }),
  )
  const asked = await withOrgContext(appDb, ORG, (tx) => requestPortalReentry(tx, ORG, { contactId: lucia.personId, conversationId: conv!.id }))
  expect(asked.status).toBe("pedido")
  // El mismo pedido repetido el mismo día no deja otra fila.
  await withOrgContext(appDb, ORG, (tx) => requestPortalReentry(tx, ORG, { contactId: lucia.personId, conversationId: conv!.id }))
  const access: WorkspaceAccess = {
    patients: true, appointments: false, conversations: false, tasks: true, finance: false, clinical: false,
    crm: true, agent: false, allTasks: true, configure: false, ownAppointments: false,
  }
  const home = await withOrgContext(appDb, ORG, (tx) => getWorkspaceHome(tx, ORG, ACTOR, access))
  const rows = home.waiting.filter((row) => row.kind === "portalReentry")
  expect(rows).toEqual([expect.objectContaining({ patientId: lucia.patientId, grantId: grant.id })])
  // No sale además como una tarea cualquiera.
  expect(home.waiting.some((row) => row.kind === "task" && row.title.includes("volver a entrar"))).toBe(false)
  // «Enviar nuevo enlace» sin volver a comprobar su identidad: el pedido se va solo.
  const resent = await withOrgContext(appDb, ORG, (tx) =>
    resendPortalAccess(tx, ORG, ACTOR, grant.id, { delivery: "qr" }, { linkUrl: (token) => `https://portal.test/a/${token}`, ...NO_RIGHTS }),
  )
  expect(resent.pinOnce).toMatch(/^\d{6}$/)
  const later = await withOrgContext(appDb, ORG, (tx) => getWorkspaceHome(tx, ORG, ACTOR, access))
  expect(later.waiting.some((row) => row.kind === "portalReentry")).toBe(false)
})

/** Una hija con su madre como representante legal y una sesión abierta en el portal. */
async function daughterWithSession(number: number, birthDate: string) {
  const [created] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: `Hija ${number}`, patientNumber: number, birthDate })
  const daughter = created!.id
  const grant = await withOrgContext(appDb, ORG, async (tx) => {
    await tx.insert(patientContact).values({ organizationId: ORG, patientId: daughter, contactId, relationship: "guardian", createdBy: ACTOR })
    await represent(tx, daughter)
    return createPortalGrant(tx, ORG, ACTOR, {
      patientId: daughter,
      contactId,
      scope: { appointments: true },
      verifiedMethod: "representacion_verificada",
    })
  })
  const { raw } = await insertPendingLink(daughter)
  const opened = await withOrgContext(appDb, ORG, (tx) => exchangePortalToken(tx, ORG, raw, { pin: "123456" }))
  return { daughter, grantId: grant.id, sessionToken: opened.sessionToken }
}

const minorBirth = () => `${new Date().getUTCFullYear() - 12}-01-15`

it("tutela revocada: su portal de ese paciente se cierra en el acto, con sesiones y enlaces", async () => {
  const { daughter, grantId, sessionToken } = await daughterWithSession(9401, minorBirth())
  expect(await errorCode(withOrgContext(appDb, ORG, (tx) => requirePortalSession(tx, ORG, sessionToken)))).toBe("OK")
  const [tutela] = await ownerDb
    .select({ id: patientResponsibility.id })
    .from(patientResponsibility)
    .where(and(eq(patientResponsibility.patientId, daughter), eq(patientResponsibility.contactId, contactId)))
  await withOrgContext(appDb, ORG, (tx) => revokeResponsibility(tx, ORG, ACTOR, daughter, tutela!.id, { reason: "Resolución judicial" }))
  expect(await errorCode(withOrgContext(appDb, ORG, (tx) => requirePortalSession(tx, ORG, sessionToken)))).toBe("PORTAL_REVOKED")
  const grants = await withOrgContext(appDb, ORG, (tx) => listPortalGrants(tx, ORG, daughter))
  expect(grants.find((row) => row.id === grantId)?.status).toBe("revocado")
})

it("la hija cumple 18: la representación de menor termina y su madre ya no entra ni recibe otro enlace", async () => {
  const { daughter, grantId, sessionToken } = await daughterWithSession(9402, minorBirth())
  // Cumplió 18 ayer.
  const yesterday = new Date(Date.now() - 86_400_000)
  const eighteen = `${yesterday.getUTCFullYear() - 18}-${String(yesterday.getUTCMonth() + 1).padStart(2, "0")}-${String(yesterday.getUTCDate()).padStart(2, "0")}`
  await setTestPatientIdentity(ownerDb, daughter, { birthDate: eighteen })
  expect(await errorCode(withOrgContext(appDb, ORG, (tx) => requirePortalSession(tx, ORG, sessionToken)))).toBe("PORTAL_REVOKED")
  expect(
    await errorCode(
      withOrgContext(appDb, ORG, (tx) =>
        resendPortalAccess(tx, ORG, ACTOR, grantId, { delivery: "qr" }, { linkUrl: (token) => `https://portal.test/a/${token}`, ...NO_RIGHTS }),
      ),
    ),
  ).toBe("PORTAL_NOT_ALLOWED")
  // Ya no es candidata a entrar por ella: ahora entra la propia hija.
  const summary = await withOrgContext(appDb, ORG, (tx) => getPortalAccessSummary(tx, ORG, daughter))
  expect(summary.candidates.map((row) => row.contactId)).not.toContain(contactId)
})

it("la migración 0096 no revive lo vencido: lo revoca con su sesión, y solo lo vigente deja de vencer", async () => {
  const [created] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Paciente Vencida", patientNumber: 9403 })
  const [fresh] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Paciente Vigente", patientNumber: 9404 })
  const grantOf = async (patientId: string, expiresAt: Date) => {
    await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId, contactId, relationship: "guardian", createdBy: ACTOR })
    const [row] = await ownerDb
      .insert(portalGrant)
      .values({ organizationId: ORG, patientId, contactId, scope: { appointments: true, budgets: false, account: false, documents: [] }, verifiedMethod: "presencial_documento", expiresAt })
      .returning({ id: portalGrant.id })
    return row!.id
  }
  const expired = await grantOf(created!.id, new Date(Date.now() - 86_400_000))
  const live = await grantOf(fresh!.id, new Date(Date.now() + 86_400_000))
  const [session] = await ownerDb
    .insert(portalSession)
    .values({
      organizationId: ORG,
      patientId: created!.id,
      contactId,
      grantId: expired,
      scope: { appointments: true, budgets: false, account: false, documents: [] },
      tokenHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: portalSession.id })
  const file = readFileSync(new URL("../../db/drizzle/0096_su_enlace_y_portal_en_un_paso.sql", import.meta.url), "utf8")
  const tail = file.slice(file.indexOf("-- El acceso ya no vence solo."))
  for (const statement of tail.split("--> statement-breakpoint")) {
    if (statement.trim()) await ownerDb.execute(sql.raw(statement))
  }
  const [gone] = await ownerDb.select().from(portalGrant).where(eq(portalGrant.id, expired))
  expect(gone).toMatchObject({ status: "revocado" })
  expect(gone?.revokedAt).toBeInstanceOf(Date)
  const [kept] = await ownerDb.select().from(portalGrant).where(eq(portalGrant.id, live))
  expect(kept).toMatchObject({ status: "activo", expiresAt: null })
  const [closed] = await ownerDb.select().from(portalSession).where(eq(portalSession.id, session!.id))
  expect(closed?.revokedAt).toBeInstanceOf(Date)
})
