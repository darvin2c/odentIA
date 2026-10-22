/**
 * «Su enlace» (fase 3, decisión 8; ADR 0037): una página por persona con lo
 * que tiene pendiente. Cada cosa sale de su regla y deja de servir cuando ya
 * no hace falta; nunca se muestra lo guardado y nunca se unen fichas solas.
 */
import { randomUUID } from "node:crypto"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { automationLinkToken } from "@odentia/db/schema/automation"
import { patient, patientContact, patientResponsibility } from "@odentia/db/schema/clinical"
import { consentDocument } from "@odentia/db/schema/clinical-forms"
import { contact, crmTask } from "@odentia/db/schema/crm"
import { crmNote } from "@odentia/db/schema/crm-workspace"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { createRoom } from "./appointments.js"
import { issuePersonalLink, listBookingLinkSlots, reserveBookingLink, revokePersonalLinks } from "./booking-links.js"
import { setProfessionalSchedule } from "./availability.js"
import { hidePersonalLinkRefs, personalLinkRef, personalLinkToken, resolvePersonalLinkRefs } from "./personal-link-token.js"
import { createBudget, deliverBudget } from "./budgets.js"
import {
  confirmLinkSignedConsent,
  createConsentDocument,
  createConsentTemplate,
  markConsentSentByLink,
  publishConsentTemplate,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { getPatientHealth } from "./clinical.js"
import { addPlanItem } from "./plan.js"
import { getPatientRegistrationConfig, savePatientRegistrationConfig } from "./patient-registration.js"
import { createPatient, patientPersonId, requirePatient, setPatientContact } from "./patients.js"
import { configurePublicLinks } from "./public-links.js"
import { getWorkspaceHome, type WorkspaceAccess } from "./workspace.js"
import {
  decidePersonalLinkBudget,
  bookedDataLink,
  getPersonalLinkDataForm,
  getPersonalLinkView,
  personalLinkForEmailToken,
  signPersonalLinkConsent,
  submitPersonalLinkData,
} from "./su-enlace.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { selectTestPatients } from "./test-patient.js"

setupTestDb()

const ORG = "org_a"
const KEY = secretsKeyFromEnv("cd".repeat(32))

/** Una persona registrada por teléfono con lo mínimo: nombres, apellido y celular. */
async function minimal(f: Awaited<ReturnType<typeof clinicalFixture>>, name: { given: string; surname: string }) {
  const created = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, {
      displayName: `${name.given} ${name.surname}`,
      givenNames: name.given,
      familyName: name.surname,
      phone: "+51987111222",
    }),
  )
  const personId = await f.run((tx) => patientPersonId(tx, ORG, created.id))
  if (!personId) throw new Error("Sin persona propia")
  return { patientId: created.id, personId }
}

it("uno por persona; «Tus datos» pide solo lo que falta, se envía una vez y nunca muestra lo guardado", async () => {
  const f = await clinicalFixture()
  const pedro = await minimal(f, { given: "Pedro", surname: "Ríos" })
  const first = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: pedro.personId, patientId: pedro.patientId }, { secretsKey: KEY }))
  // Enviarlo otra vez da el mismo enlace: lo que llegue después aparece en él.
  const again = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: pedro.personId, patientId: pedro.patientId }, { secretsKey: KEY }))
  expect(again).toMatchObject({ token: first.token, reused: true })
  const rows = await ownerDb.select().from(appointmentBookingLink).where(eq(appointmentBookingLink.patientId, pedro.patientId))
  expect(rows).toHaveLength(1)
  // Solo se guarda su huella.
  expect(rows[0]?.tokenHash).not.toBe(first.token)

  const view = await f.run((tx) => getPersonalLinkView(tx, ORG, first.token))
  expect(view).toMatchObject({ status: "abierto", firstName: "Pedro", patientFirstName: null, booking: null, appointment: null })
  expect(view.data?.missing.map((item) => item.key)).toContain("birthDate")
  // Nada de lo guardado viaja a la página: ni su celular ni su apellido.
  expect(JSON.stringify(view)).not.toContain("987111222")
  expect(JSON.stringify(view)).not.toContain("Ríos")

  // Lo que no falta no se toca aunque venga en el envío.
  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, first.token, {
      data: { birthDate: "1988-02-14", docType: "DNI", docNumber: "47120836", phone: "+51900000000" },
    }),
  )
  const [saved] = await selectTestPatients(ownerDb).where(eq(patient.id, pedro.patientId))
  expect(saved).toMatchObject({ birthDate: "1988-02-14", phone: "+51987111222", identityNeedsReview: false })
  // Una sola vez: después dice «Recibido» y no se vuelve a llenar desde aquí.
  await expect(
    f.run((tx) => submitPersonalLinkData(tx, ORG, first.token, { data: { birthDate: "1990-01-01" } })),
  ).rejects.toMatchObject({ code: "DATA_ALREADY_SENT" })
  // Sin nada pendiente solo le queda «Tus mensajes» (ADR 0040): ni sus datos ni nada de lo guardado.
  expect(await f.run((tx) => getPersonalLinkView(tx, ORG, first.token))).toMatchObject({
    status: "abierto", data: null, budgets: [], consents: [], questionnaire: null, papers: [],
    messages: { recordatorio: true, seguimiento: true, novedades: false, nothing: false },
  })
  // Su persona guarda una nota con lo que completó.
  const notes = await ownerDb.select({ body: crmNote.body }).from(crmNote).where(eq(crmNote.contactId, pedro.personId))
  expect(notes.map((note) => note.body).join(" ")).toContain("Completó desde su enlace")
})

it("un documento que ya es de otra ficha no se guarda y deja «Posible ficha repetida» a recepción", async () => {
  const f = await clinicalFixture()
  // Esta clínica pide el documento para atender: es de lo que falta.
  const config = await f.run((tx) => getPatientRegistrationConfig(tx, ORG))
  await f.run((tx) =>
    savePatientRegistrationConfig(tx, ORG, f.actor, {
      expectedVersion: config.version,
      enabled: true,
      fields: { ...config.fields, docType: "required", docNumber: "required" },
      privacyNotice: "Tus datos se usan solo para tu atención.",
    }),
  )
  await f.run((tx) =>
    createPatient(tx, ORG, f.actor, {
      displayName: "Juan Pérez",
      givenNames: "Juan",
      familyName: "Pérez",
      docType: "DNI",
      docNumber: "41231234",
    }),
  )
  const otro = await minimal(f, { given: "Pedro", surname: "Ríos" })
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: otro.personId, patientId: otro.patientId }, { secretsKey: KEY }))
  // A la persona no se le dice de quién es: recibe «Recibido».
  expect(
    await f.run((tx) =>
      submitPersonalLinkData(tx, ORG, link.token, { data: { birthDate: "1991-04-04", docType: "DNI", docNumber: "41231234" } }),
    ),
  ).toEqual({ received: true })
  const [saved] = await selectTestPatients(ownerDb).where(eq(patient.id, otro.patientId))
  expect(saved).toMatchObject({ birthDate: "1991-04-04", docNumber: null })
  const tasks = await ownerDb
    .select({ title: crmTask.title, kind: crmTask.kind, area: crmTask.area, reason: crmTask.reason })
    .from(crmTask)
    .where(and(eq(crmTask.patientId, otro.patientId), eq(crmTask.kind, "ficha_repetida")))
  expect(tasks).toEqual([
    expect.objectContaining({ title: "Posible ficha repetida: Pedro Ríos", area: "recepcion", reason: expect.stringContaining("en la página de Juan Pérez") }),
  ])
})

it("si la fecha dice que es menor, desde el enlace no se registra a nadie: queda «Faltan datos» y una tarea a recepción", async () => {
  const f = await clinicalFixture()
  const nina = await minimal(f, { given: "Sofía", surname: "Paz" })
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: nina.personId, patientId: nina.patientId }, { secretsKey: KEY }))
  const minorDate = `${new Date().getUTCFullYear() - 10}-03-10`
  await expect(
    f.run((tx) => submitPersonalLinkData(tx, ORG, link.token, { data: { birthDate: minorDate } })),
  ).rejects.toMatchObject({ code: "REPRESENTATIVE_REQUIRED" })
  // El documento de su madre se revisa con las reglas del país y se dice qué arreglar.
  await expect(
    f.run((tx) =>
      submitPersonalLinkData(tx, ORG, link.token, {
        data: { birthDate: minorDate },
        representative: { displayName: "Rosa Paz", docType: "DNI", docNumber: "423" },
      }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION", message: "El DNI tiene 8 números; faltan 5" })
  await expect(
    f.run((tx) =>
      submitPersonalLinkData(tx, ORG, link.token, {
        data: { birthDate: minorDate },
        representative: { displayName: "Rosa Paz", docType: "INVENTADO", docNumber: "42345678" },
      }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, link.token, {
      data: { birthDate: minorDate },
      representative: { displayName: "Rosa Paz", docType: "DNI", docNumber: "42345678", phone: "+51955111222" },
    }),
  )
  // Ni la fecha ni un representante: la ficha sigue con lo que falta.
  const saved = await f.run((tx) => requirePatient(tx, ORG, nina.patientId))
  expect(saved?.birthDate).toBeNull()
  const reps = await ownerDb.select({ id: patientResponsibility.id }).from(patientResponsibility).where(eq(patientResponsibility.patientId, nina.patientId))
  expect(reps).toEqual([])
  const tasks = await ownerDb
    .select({ title: crmTask.title, area: crmTask.area })
    .from(crmTask)
    .where(eq(crmTask.patientId, nina.patientId))
  expect(tasks).toEqual([{ title: "Registrar a su representante legal: Sofía Paz", area: "recepcion" }])
  // Lo que escribió de su madre queda en una nota para recepción.
  const notes = await ownerDb.select({ body: crmNote.body }).from(crmNote).where(eq(crmNote.contactId, nina.personId))
  expect(notes.map((note) => note.body).join(" ")).toContain("Rosa Paz, DNI 42345678")
})

it("la tía: otro vínculo que abre el enlace ve solo la cita; ni presupuesto, ni consentimiento, ni sus datos", async () => {
  const f = await clinicalFixture()
  const [tia] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Marta Tía", givenNames: "Marta" }).returning({ id: contact.id })
  await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId: f.patient.id, contactId: tia!.id, relationship: "family", createdBy: f.actor })
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: tia!.id, patientId: f.patient.id }, { secretsKey: KEY }))
  const view = await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))
  expect(view).toMatchObject({ budgets: [], consents: [], data: null, questionnaire: null })
  await expect(
    f.run((tx) => decidePersonalLinkBudget(tx, ORG, link.token, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] })),
  ).rejects.toMatchObject({ code: "PORTAL_FORBIDDEN" })
  await expect(
    f.run((tx) => submitPersonalLinkData(tx, ORG, link.token, { data: { birthDate: "1980-01-01" } })),
  ).rejects.toMatchObject({ code: "PORTAL_FORBIDDEN" })
  // La propia persona sí lo ve con su enlace.
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  const own = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id }, { secretsKey: KEY }))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, own.token))).budgets.map((row) => row.id)).toEqual([budget.id])
})

it("pasada su vigencia solo queda su cita; «Quitar enlace» y cambiar el vínculo lo dejan sin efecto", async () => {
  const f = await clinicalFixture()
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id }, { secretsKey: KEY }))
  await ownerDb.update(appointmentBookingLink).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(appointmentBookingLink.id, link.linkId))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).budgets).toEqual([])
  await expect(
    f.run((tx) => decidePersonalLinkBudget(tx, ORG, link.token, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] })),
  ).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })

  const fresh = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id }, { secretsKey: KEY }))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, fresh.token))).status).toBe("abierto")
  expect(await f.run((tx) => revokePersonalLinks(tx, ORG, f.actor, f.patient.id))).toEqual({ revoked: 1 })
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, fresh.token))).status).toBe("vencido")

  // Cambiar el vínculo de quien lo tenía también lo deja sin efecto.
  const [madre] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Elsa Madre" }).returning({ id: contact.id })
  await f.run((tx) => setPatientContact(tx, ORG, f.actor, f.patient.id, { contactId: madre!.id, relationship: "guardian", isPreferred: false }))
  const hers = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: madre!.id, patientId: f.patient.id }, { secretsKey: KEY }))
  await f.run((tx) => setPatientContact(tx, ORG, f.actor, f.patient.id, { contactId: madre!.id, relationship: "family", isPreferred: false }))
  const [row] = await ownerDb.select({ revokedAt: appointmentBookingLink.revokedAt }).from(appointmentBookingLink).where(eq(appointmentBookingLink.id, hers.linkId))
  expect(row?.revokedAt).toBeInstanceOf(Date)
})

it("el token de «Su enlace» no queda en el mensaje: se guarda una referencia que el worker resuelve al enviar", () => {
  const linkId = randomUUID()
  const stored = `Hola. Mira aquí: https://norte.odentia.test/reserva?token=${personalLinkRef(linkId)}`
  expect(stored).not.toMatch(/[0-9a-f]{64}/)
  const sent = resolvePersonalLinkRefs(stored, KEY)
  expect(sent).toBe(`Hola. Mira aquí: https://norte.odentia.test/reserva?token=${personalLinkToken(KEY, linkId)}`)
  expect(hidePersonalLinkRefs(stored)).toBe("Hola. Mira aquí: https://norte.odentia.test/reserva?token=…")
})

it("el consentimiento se firma en su enlace con su documento y el profesional lo confirma en la cita", async () => {
  const f = await clinicalFixture()
  const lucia = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, {
      displayName: "Lucía Fernández",
      givenNames: "Lucía",
      familyName: "Fernández",
      birthDate: "1995-07-30",
      docType: "DNI",
      docNumber: "40000004",
      phone: "+51911222333",
    }),
  )
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, lucia.id)))!
  const draft = await f.run((tx) =>
    createConsentTemplate(tx, ORG, f.actor, {
      key: `t-${randomUUID().slice(0, 8)}`,
      title: "Exodoncia",
      sections: {
        procedure: "Extracción de la pieza dentaria con anestesia local.",
        benefits: ["Quitar el dolor"],
        risks: ["Sangrado los primeros días"],
        alternatives: ["Tratamiento de conductos"],
        consequences: "La infección puede avanzar.",
      },
    }),
  )
  const template = await f.run((tx) => publishConsentTemplate(tx, ORG, f.actor, draft.id))
  const consent = await f.run((tx) => createConsentDocument(tx, ORG, f.actor, { templateId: template.id, patientId: lucia.id, procedureRef: "Exodoncia de la pieza 38" }))
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: lucia.id }, { secretsKey: KEY }))
  // Sin enviarlo a firmar, no aparece en su enlace (solo «Tus mensajes», ADR 0040).
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).consents).toEqual([])
  await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, consent.id))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).consents).toEqual([{ id: consent.id, title: "Exodoncia" }])

  const strokes = { strokes: [[[10, 10], [200, 120]]] }
  // El documento que escribe se compara con el de su registro.
  await expect(
    f.run((tx) => signPersonalLinkConsent(tx, ORG, link.token, consent.id, { docNumber: "99999999", comprehensionConfirmed: true, signatureData: strokes })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await f.run((tx) =>
    signPersonalLinkConsent(
      tx,
      ORG,
      link.token,
      consent.id,
      { docNumber: "40.000.004", comprehensionConfirmed: true, signatureData: strokes },
      { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Android)" },
    ),
  )
  const [signed] = await ownerDb.select().from(consentDocument).where(eq(consentDocument.id, consent.id))
  // Firmó la persona, pero sigue pendiente hasta que el profesional la informe y confirme.
  expect(signed).toMatchObject({ status: "pendiente", signatureMethod: "enlace", signerKind: "paciente", signerContactId: personId })
  expect(signed?.personSignedAt).toBeInstanceOf(Date)
  // Firmó a distancia: queda desde dónde y la declaración que aceptó (#47).
  expect(signed).toMatchObject({ personSignedIp: "203.0.113.7", personSignedUserAgent: "Mozilla/5.0 (Android)" })
  expect(signed?.declarationSnapshot).toMatch(/He leído y comprendido/)
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).consents).toEqual([])
  await f.run((tx) => confirmLinkSignedConsent(tx, ORG, f.actor, consent.id))
  const [confirmed] = await ownerDb.select().from(consentDocument).where(eq(consentDocument.id, consent.id))
  expect(confirmed).toMatchObject({ status: "firmado", signatureMethod: "enlace", signatureLevel: "simple", informedBy: f.actor })
})

it("«Ver y responder»: el presupuesto aparece en el mismo enlace, se responde y deja de servir al decidirlo", async () => {
  const f = await clinicalFixture()
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id }, { secretsKey: KEY }))
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  // Un borrador no se ve: solo lo que se le entregó.
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).budgets).toEqual([])
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const view = await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))
  expect(view.budgets.map((row) => row.id)).toEqual([budget.id])
  const answer = await f.run((tx) =>
    decidePersonalLinkBudget(tx, ORG, link.token, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }),
  )
  expect(answer.budget.status).toBe("aceptado")
  // «¿Reservamos…?»: lo aceptado queda para elegir horario.
  expect(answer.toSchedule.map((line) => line.planItemId)).toEqual([item.id])
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).budgets).toEqual([])
})

it("revocado no sirve, y el enlace de un correo (/c/) solo lleva a «Su enlace» con esa cita", async () => {
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
  try {
    const f = await clinicalFixture()
    const ana = await minimal(f, { given: "Ana", surname: "Soto" })
    const issued = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: ana.personId, patientId: ana.patientId }, { secretsKey: KEY }))
    await ownerDb.update(appointmentBookingLink).set({ revokedAt: new Date() }).where(eq(appointmentBookingLink.id, issued.linkId))
    expect((await f.run((tx) => getPersonalLinkView(tx, ORG, issued.token))).status).toBe("vencido")
    await expect(
      f.run((tx) => submitPersonalLinkData(tx, ORG, issued.token, { data: { birthDate: "1980-01-01" } })),
    ).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })

    // Un token de «confirmar» de un correo, aún vigente, da su enlace con esa cita.
    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
    const room = await f.run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental 1" }))
    const startsAt = new Date(Date.now() + 3 * 86_400_000)
    const [booked] = await ownerDb
      .insert(appointment)
      .values({
        organizationId: ORG,
        branchId: site!.id,
        patientId: ana.patientId,
        professionalUserId: f.actor,
        roomId: room.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        durationMin: 30,
      })
      .returning({ id: appointment.id })
    const raw = randomUUID()
    await ownerDb.insert(automationLinkToken).values({
      tokenHash: createHash("sha256").update(raw).digest("hex"),
      organizationId: ORG,
      purpose: "confirm",
      appointmentId: booked!.id,
      contactId: ana.personId,
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    const redirect = await f.run((tx) => personalLinkForEmailToken(tx, ORG, raw, { secretsKey: KEY }))
    // La dirección es la de la clínica, con su subdominio, y el enlace muestra esa cita.
    expect(redirect.url).toBe(`https://norte.odentia.test/reserva?token=${redirect.token}`)
    const view = await f.run((tx) => getPersonalLinkView(tx, ORG, redirect.token))
    expect(view.appointment).toMatchObject({ canConfirm: true, canChange: true, branchName: "Centro" })
    // Un token vencido, o uno que no existe, ya no lleva a ningún lado.
    await expect(f.run((tx) => personalLinkForEmailToken(tx, ORG, randomUUID(), { secretsKey: KEY }))).rejects.toMatchObject({
      code: "BOOKING_LINK_EXPIRED",
    })
  } finally {
    configurePublicLinks(null)
  }
})

it("lo aceptado se reserva una sola vez, y solo quien decide por el paciente", async () => {
  const f = await clinicalFixture()
  const personId = (await f.run((tx) => patientPersonId(tx, ORG, f.patient.id)))!
  const item = await f.run((tx) => addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }))
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: personId, patientId: f.patient.id }, { secretsKey: KEY }))
  await f.run((tx) => decidePersonalLinkBudget(tx, ORG, link.token, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))

  const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: `Sede ${randomUUID().slice(0, 6)}`, timezone: "America/Lima" }).returning({ id: branch.id })
  await f.run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental 1" }))
  await f.run((tx) =>
    setProfessionalSchedule(tx, ORG, f.actor, {
      branchId: site!.id,
      professionalUserId: f.actor,
      rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMin: 8 * 60, endMin: 20 * 60 })),
    }),
  )
  const from = new Date(Date.now() + 2 * 86_400_000)
  from.setUTCHours(5, 0, 0, 0)
  const range = { branchId: site!.id, from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString() }
  const { slots } = await f.run((tx) => listBookingLinkSlots(tx, ORG, link.token, range))
  const [first, second] = slots
  if (!first || !second) throw new Error("Sin horarios")
  const pick = (slot: typeof first) => ({ branchId: site!.id, startsAt: slot.startsAt, professionalUserId: slot.professionalUserId, ...(slot.roomId ? { roomId: slot.roomId } : {}), planItemIds: [item.id] })
  await f.run((tx) => reserveBookingLink(tx, ORG, link.token, pick(first)))
  // Un segundo toque, o el mismo tratamiento en otro horario, no crea otra cita.
  await expect(f.run((tx) => reserveBookingLink(tx, ORG, link.token, pick(second)))).rejects.toMatchObject({ code: "BOOKING_ALREADY_SCHEDULED" })
  const booked = await ownerDb.select({ id: appointment.id }).from(appointment).where(eq(appointment.patientId, f.patient.id))
  expect(booked).toHaveLength(1)

  // La tía no agenda lo aceptado por su sobrina.
  const [tia] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName: "Marta Tía" }).returning({ id: contact.id })
  await ownerDb.insert(patientContact).values({ organizationId: ORG, patientId: f.patient.id, contactId: tia!.id, relationship: "family", createdBy: f.actor })
  const hers = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: tia!.id, patientId: f.patient.id }, { secretsKey: KEY }))
  await expect(f.run((tx) => reserveBookingLink(tx, ORG, hers.token, pick(second)))).rejects.toMatchObject({ code: "PORTAL_FORBIDDEN" })
})

it("«Tus datos y tu salud»: la salud se pregunta solo si nadie la registró y entra declarada", async () => {
  const f = await clinicalFixture()
  const lia = await minimal(f, { given: "Lía", surname: "Paz" })
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: lia.personId, patientId: lia.patientId }, { secretsKey: KEY }))
  const view = await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))
  expect(view.data?.health).toBe(true)
  const form = await f.run((tx) => getPersonalLinkDataForm(tx, ORG, link.token))
  expect(form).toMatchObject({ asksHealth: true, firstName: "Lía" })
  expect(form.registration.fields).toBeDefined()

  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, link.token, {
      data: { birthDate: "1992-06-01" },
      health: { allergies: { state: "recorded", items: [{ substance: "Penicilina", severity: "desconocida" }] } },
    }),
  )
  const health = await f.run((tx) => getPatientHealth(tx, ORG, lia.patientId))
  expect(health.revision).toBeGreaterThan(0)
  expect(health.allergies.map((item) => item.substance)).toContain("Penicilina")
  const notes = await ownerDb.select({ body: crmNote.body }).from(crmNote).where(eq(crmNote.contactId, lia.personId))
  expect(notes.map((note) => note.body).join(" ")).toContain("Declaró su salud")
})

it("al confirmar la cita del agente, a quien le faltan datos se le da su enlace; a quien no, nada", async () => {
  const f = await clinicalFixture()
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" })
  try {
    const tomas = await minimal(f, { given: "Tomás", surname: "Vega" })
    const ask = () =>
      f.run((tx) => bookedDataLink(tx, ORG, { contactId: tomas.personId, patientId: tomas.patientId, appointmentId: null }, { secretsKey: KEY }))
    const data = await ask()
    expect(data?.missing).toContain("fecha de nacimiento")
    // Es su mismo enlace, con el token escrito: el que ya tiene, no otro.
    const again = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: tomas.personId, patientId: tomas.patientId }, { secretsKey: KEY }))
    expect(again.reused).toBe(true)
    expect(data?.url).toContain(again.token)

    await f.run((tx) => submitPersonalLinkData(tx, ORG, again.token, { data: { birthDate: "1990-03-03" } }))
    expect((await ask())?.missing ?? []).not.toContain("fecha de nacimiento")
  } finally {
    configurePublicLinks(null)
  }
})

it("Inicio: quien terminó su registro hoy y tiene cita hoy sale en «Te espera» hasta que llega", async () => {
  const f = await clinicalFixture()
  const carla = await minimal(f, { given: "Carla", surname: "Núñez" })
  const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Centro", timezone: "UTC" }).returning({ id: branch.id })
  const room = await f.run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental 1" }))
  const startsAt = new Date(Date.now() + 60_000)
  const [booked] = await ownerDb
    .insert(appointment)
    .values({ organizationId: ORG, branchId: site!.id, patientId: carla.patientId, professionalUserId: f.actor, roomId: room.id, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30 })
    .returning({ id: appointment.id })
  const access: WorkspaceAccess = {
    patients: true, appointments: true, conversations: false, tasks: false, finance: false, clinical: false,
    crm: false, agent: false, allTasks: false, configure: false, ownAppointments: false,
  }
  const rows = async () =>
    (await f.run((tx) => getWorkspaceHome(tx, ORG, f.actor, access, { branchId: site!.id }))).waiting.filter((row) => row.kind === "registrationDone")
  expect(await rows()).toEqual([])

  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: carla.personId, patientId: carla.patientId }, { secretsKey: KEY }))
  await f.run((tx) => submitPersonalLinkData(tx, ORG, link.token, { data: { birthDate: "1994-07-07" } }))
  expect(await rows()).toEqual([
    expect.objectContaining({ kind: "registrationDone", appointmentId: booked!.id, patientId: carla.patientId, patientName: "Carla Núñez", professionalName: "Clínico" }),
  ])

  // Llegó: la fila se va.
  await ownerDb.update(appointment).set({ status: "confirmada", arrivedAt: new Date(), arrivedBy: f.actor }).where(eq(appointment.id, booked!.id))
  expect(await rows()).toEqual([])
})
