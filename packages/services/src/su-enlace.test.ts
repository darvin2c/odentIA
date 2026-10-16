/**
 * «Su enlace» (fase 3, decisión 8; ADR 0037): una página por persona con lo
 * que tiene pendiente. Cada cosa sale de su regla y deja de servir cuando ya
 * no hace falta; nunca se muestra lo guardado y nunca se unen fichas solas.
 */
import { randomUUID } from "node:crypto"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { automationLinkToken } from "@odentia/db/schema/automation"
import { patient, patientResponsibility } from "@odentia/db/schema/clinical"
import { consentDocument } from "@odentia/db/schema/clinical-forms"
import { crmTask } from "@odentia/db/schema/crm"
import { crmNote } from "@odentia/db/schema/crm-workspace"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { createChair } from "./appointments.js"
import { issuePersonalLink } from "./booking-links.js"
import { createBudget, deliverBudget } from "./budgets.js"
import {
  confirmLinkSignedConsent,
  createConsentDocument,
  createConsentTemplate,
  markConsentSentByLink,
  publishConsentTemplate,
} from "./clinical-forms.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem } from "./plan.js"
import { getPatientRegistrationConfig, savePatientRegistrationConfig } from "./patient-registration.js"
import { createPatient, patientPersonId } from "./patients.js"
import { configurePublicLinks } from "./public-links.js"
import {
  decidePersonalLinkBudget,
  getPersonalLinkView,
  personalLinkForEmailToken,
  signPersonalLinkConsent,
  submitPersonalLinkData,
} from "./su-enlace.js"
import { secretsKeyFromEnv } from "./secrets.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const ORG = "org_a"
const KEY = secretsKeyFromEnv("cd".repeat(32))

/** Una persona registrada por teléfono con lo mínimo: nombres, apellido y celular. */
async function minimal(f: Awaited<ReturnType<typeof clinicalFixture>>, name: { given: string; surname: string }) {
  const created = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, {
      displayName: `${name.given} ${name.surname}`,
      givenNames: name.given,
      paternalSurname: name.surname,
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
  const [saved] = await ownerDb.select().from(patient).where(eq(patient.id, pedro.patientId))
  expect(saved).toMatchObject({ birthDate: "1988-02-14", phone: "+51987111222", identityNeedsReview: false })
  // Una sola vez: después dice «Recibido» y no se vuelve a llenar desde aquí.
  await expect(
    f.run((tx) => submitPersonalLinkData(tx, ORG, first.token, { data: { birthDate: "1990-01-01" } })),
  ).rejects.toMatchObject({ code: "DATA_ALREADY_SENT" })
  // Sin nada pendiente, el enlace entero ya no sirve.
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, first.token))).status).toBe("vencido")
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
      paternalSurname: "Pérez",
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
  const [saved] = await ownerDb.select().from(patient).where(eq(patient.id, otro.patientId))
  expect(saved).toMatchObject({ birthDate: "1991-04-04", docNumber: null })
  const tasks = await ownerDb
    .select({ title: crmTask.title, kind: crmTask.kind, area: crmTask.area, reason: crmTask.reason })
    .from(crmTask)
    .where(and(eq(crmTask.patientId, otro.patientId), eq(crmTask.kind, "ficha_repetida")))
  expect(tasks).toEqual([
    expect.objectContaining({ title: "Posible ficha repetida: Pedro Ríos", area: "recepcion", reason: expect.stringContaining("en la página de Juan Pérez") }),
  ])
})

it("si la fecha dice que es menor, la misma pantalla pide a su representante legal", async () => {
  const f = await clinicalFixture()
  const nina = await minimal(f, { given: "Sofía", surname: "Paz" })
  const link = await f.run((tx) => issuePersonalLink(tx, ORG, { contactId: nina.personId, patientId: nina.patientId }, { secretsKey: KEY }))
  const minorDate = `${new Date().getUTCFullYear() - 10}-03-10`
  await expect(
    f.run((tx) => submitPersonalLinkData(tx, ORG, link.token, { data: { birthDate: minorDate } })),
  ).rejects.toMatchObject({ code: "REPRESENTATIVE_REQUIRED" })
  await f.run((tx) =>
    submitPersonalLinkData(tx, ORG, link.token, {
      data: { birthDate: minorDate },
      representative: { displayName: "Rosa Paz", docType: "DNI", docNumber: "42345678", phone: "+51955111222" },
    }),
  )
  const [saved] = await ownerDb.select().from(patient).where(eq(patient.id, nina.patientId))
  expect(saved?.birthDate).toBe(minorDate)
  const reps = await ownerDb
    .select({ kind: patientResponsibility.kind })
    .from(patientResponsibility)
    .where(eq(patientResponsibility.patientId, nina.patientId))
  expect(reps.map((row) => row.kind)).toEqual(["representante_legal"])
})

it("el consentimiento se firma en su enlace con su documento y el profesional lo confirma en la cita", async () => {
  const f = await clinicalFixture()
  const lucia = await f.run((tx) =>
    createPatient(tx, ORG, f.actor, {
      displayName: "Lucía Fernández",
      givenNames: "Lucía",
      paternalSurname: "Fernández",
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
  // Sin enviarlo a firmar, no aparece en su enlace.
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).status).toBe("vencido")
  await f.run((tx) => markConsentSentByLink(tx, ORG, f.actor, consent.id))
  expect((await f.run((tx) => getPersonalLinkView(tx, ORG, link.token))).consents).toEqual([{ id: consent.id, title: "Exodoncia" }])

  const strokes = { strokes: [[[10, 10], [200, 120]]] }
  // El documento que escribe se compara con el de su registro.
  await expect(
    f.run((tx) => signPersonalLinkConsent(tx, ORG, link.token, consent.id, { docNumber: "99999999", comprehensionConfirmed: true, signatureData: strokes })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await f.run((tx) =>
    signPersonalLinkConsent(tx, ORG, link.token, consent.id, { docNumber: "40.000.004", comprehensionConfirmed: true, signatureData: strokes }),
  )
  const [signed] = await ownerDb.select().from(consentDocument).where(eq(consentDocument.id, consent.id))
  // Firmó la persona, pero sigue pendiente hasta que el profesional la informe y confirme.
  expect(signed).toMatchObject({ status: "pendiente", signatureMethod: "enlace", signerKind: "paciente", signerContactId: personId })
  expect(signed?.personSignedAt).toBeInstanceOf(Date)
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
    const chair = await f.run((tx) => createChair(tx, ORG, { branchId: site!.id, name: "Sillón 1" }))
    const startsAt = new Date(Date.now() + 3 * 86_400_000)
    const [booked] = await ownerDb
      .insert(appointment)
      .values({
        organizationId: ORG,
        branchId: site!.id,
        patientId: ana.patientId,
        dentistUserId: f.actor,
        chairId: chair.id,
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
