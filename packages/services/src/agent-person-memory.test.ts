import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type Db, type InboundMessageJob, withOrgContext } from "@odentia/db"
import { agentPersonFact } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { patient, patientDataConsent, patientRegistration, patientRegistrationLink } from "@odentia/db/schema/clinical"
import { channelConnection, contactIdentity, conversation } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { auditEvent } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"
import {
  addPersonFact,
  formatPersonMemoryForPrompt,
  getPersonMemory,
  listPersonFacts,
  looksClinical,
  PERSON_FACT_LIMIT,
  removePersonFact,
} from "./agent-person-memory.js"
import { addAgentCaseNote } from "./agent-case.js"
import { getCaseBrief, parseHandoffSaid } from "./agent-case-brief.js"
import { annotateHandoff, createHandoff, listHandoffs } from "./agent-operations.js"
import { createChair } from "./appointments.js"
import { setProfessionalSchedule } from "./availability.js"
import {
  cancelBookingLinkAppointment,
  changeBookingLinkAppointment,
  createBookingLink,
  listBookingLinkSlots,
  reserveBookingLink,
  getBookingLinkRegistrationForm,
  registerFromBookingLink,
} from "./booking-links.js"
import { getPersonalLinkView as getBookingLinkView } from "./su-enlace.js"
import { createConnection } from "./connections.js"
import { createContact } from "./contacts.js"
import { type IngestDeps, ingestInbound } from "./conversations.js"
import { getOrgLocale } from "./locale.js"
import { getPatientRegistrationConfig, registerPatient, savePatientRegistrationConfig } from "./patient-registration.js"
import { listPatientsByContact, nextPatientNumber, setPatientContact } from "./patients.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/** Memoria de la persona: datos prácticos con fecha y origen, nunca clínicos, que se reemplazan o se quitan. */
setupTestDb()
const ORG = "org_a"
const OTHER = "org_b"
const OWNER = "memory-owner"
const KEY = secretsKeyFromEnv("ab".repeat(32))

beforeAll(async () => {
  await ownerDb.insert(user).values([{ id: OWNER, name: "Carmen", email: "carmen@memory.test", emailVerified: true }])
  await ownerDb.insert(member).values([
    { id: `m-${OWNER}`, userId: OWNER, organizationId: ORG, role: "owner", createdAt: new Date() },
  ])
})

function run<T>(fn: (tx: Db) => Promise<T>, org = ORG): Promise<T> {
  return withOrgContext(appDb, org, fn)
}

const stubAdapter: ChannelAdapter = {
  provider: "telegram_bot_api",
  capabilities: { templates: false, media: true, interactive: false, readReceipts: false, edit: true },
  verifyWebhook: () => true,
  parseWebhook: () => ({ messages: [], statuses: [] }),
  sendMessage: async () => ({ externalId: "stub-1" }),
  validateConnection: async () => ({ externalId: "bot-1", displayName: "Bot" }),
}
const unused = async (): Promise<never> => {
  throw new Error("no usado")
}
const storageStub: Storage = {
  putAvatar: unused,
  deleteByUrl: async () => {},
  putAttachment: unused,
  attachmentUrl: async (key) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: unused,
  putPatientAvatar: unused,
}
const deps: IngestDeps = { storage: storageStub, fetch, secretsKey: KEY }

/** Una persona que escribió por Telegram: su contacto y su conversación. */
async function person(sender: string): Promise<{ contactId: string; conversationId: string }> {
  const connectionId = await run((tx) =>
    createConnection(tx, ORG, KEY,
      { channel: "telegram", provider: "telegram_bot_api", displayName: `Bot ${sender}`, config: { botToken: sender } },
      { fetch, validateExternal: false }).then((c) => c.id))
  const event: NormalizedInbound = {
    externalEventId: `evt-${sender}`, externalMessageId: `evt-${sender}`,
    externalThreadId: `tg:${sender}`, senderExternalId: `tg:${sender}`, senderDisplayName: sender,
    content: { type: "text", text: "Hola" }, sentAt: new Date().toISOString(),
  }
  const job: InboundMessageJob = { orgId: ORG, connectionId, event }
  const { conversationId } = await run((tx) => ingestInbound(tx, job, stubAdapter, deps))
  const [thread] = await ownerDb.select({ contactId: conversation.contactId }).from(conversation).where(eq(conversation.id, conversationId))
  return { contactId: thread!.contactId, conversationId }
}

describe("filtro de información de salud", () => {
  it("rechaza lo clínico y deja pasar lo práctico", () => {
    for (const text of [
      "Le duele la muela desde ayer",
      "Es alérgica a la penicilina",
      "Está embarazada de 5 meses",
      "Toma medicación para la presión alta",
      "Tiene diabetes",
      "Viene por su tratamiento de conducto",
    ]) expect(looksClinical(text), text).toBe(true)
    for (const text of [
      "Prefiere citas por la tarde",
      "Quiere que la llamen Lucha",
      "Escribe por su hijo Mateo",
      "Solo puede los sábados",
      "Paga con tarjeta",
      "Viaja en octubre",
    ]) expect(looksClinical(text), text).toBe(false)
  })
})

describe("memoria de la persona", () => {
  it("guarda con origen, no duplica, reemplaza sin borrar la historia y quita al instante", async () => {
    const lucia = await person("lucia-mem")
    const fromAgent = await run((tx) =>
      addPersonFact(tx, ORG, { userId: null, source: "agente" }, {
        contactId: lucia.contactId, text: "  Prefiere citas   por la tarde ", conversationId: lucia.conversationId,
      }))
    expect(fromAgent).toMatchObject({ text: "Prefiere citas por la tarde", source: "agente", channel: "telegram", createdByName: null })
    const fromTeam = await run((tx) =>
      addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: lucia.contactId, text: "Quiere que la llamen Lucha" }))
    expect(fromTeam).toMatchObject({ source: "equipo", channel: null, createdByName: "Carmen" })

    // Decir lo mismo otra vez no crea otro dato.
    const again = await run((tx) =>
      addPersonFact(tx, ORG, { userId: null, source: "agente" }, { contactId: lucia.contactId, text: "prefiere citas por la tarde" }))
    expect(again.id).toBe(fromAgent.id)
    expect(await run((tx) => listPersonFacts(tx, ORG, lucia.contactId))).toHaveLength(2)

    // Cambió de preferencia: el nuevo reemplaza al anterior, que queda en la historia.
    const changed = await run((tx) =>
      addPersonFact(tx, ORG, { userId: null, source: "agente" }, {
        contactId: lucia.contactId, text: "Prefiere citas por la mañana", replacesId: fromAgent.id, conversationId: lucia.conversationId,
      }))
    expect((await run((tx) => listPersonFacts(tx, ORG, lucia.contactId))).map((fact) => fact.text)).toEqual([
      "Quiere que la llamen Lucha", "Prefiere citas por la mañana",
    ])
    const [old] = await ownerDb.select().from(agentPersonFact).where(eq(agentPersonFact.id, fromAgent.id))
    expect(old).toMatchObject({ status: "reemplazado", replacedById: changed.id })

    await run((tx) => removePersonFact(tx, ORG, OWNER, lucia.contactId, fromTeam.id))
    expect((await run((tx) => listPersonFacts(tx, ORG, lucia.contactId))).map((fact) => fact.id)).toEqual([changed.id])
    const [removed] = await ownerDb.select().from(agentPersonFact).where(eq(agentPersonFact.id, fromTeam.id))
    expect(removed).toMatchObject({ status: "quitado", removedBy: OWNER })
    await expect(run((tx) => removePersonFact(tx, ORG, OWNER, lucia.contactId, fromTeam.id))).rejects.toMatchObject({ code: "NOT_FOUND" })

    // La auditoría dice quién y de quién, sin repetir el dato.
    const audits = await ownerDb.select().from(auditEvent).where(eq(auditEvent.entityId, changed.id))
    expect(JSON.stringify(audits)).not.toContain("mañana")
    expect(audits[0]?.metadata).toMatchObject({ contactId: lucia.contactId, source: "agente", replaced: fromAgent.id })
  })

  it("nunca guarda nada clínico, venga del agente o del equipo", async () => {
    const andres = await person("andres-mem")
    for (const actor of [{ userId: null, source: "agente" as const }, { userId: OWNER, source: "equipo" as const }]) {
      await expect(run((tx) => addPersonFact(tx, ORG, actor, { contactId: andres.contactId, text: "Es alérgico al látex" })))
        .rejects.toMatchObject({ code: "PERSON_FACT_CLINICAL" })
    }
    await expect(run((tx) => addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: andres.contactId, text: "   " })))
      .rejects.toThrow(/Escribe el dato/)
    await expect(run((tx) => addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: andres.contactId, text: "x".repeat(201) })))
      .rejects.toThrow(/200/)
    expect(await ownerDb.select().from(agentPersonFact).where(eq(agentPersonFact.contactId, andres.contactId))).toEqual([])
  })

  it("es de una persona y de una organización: no se mezcla ni pasa el tope", async () => {
    const elena = await person("elena-mem")
    const other = await person("otra-mem")
    // La conversación tiene que ser de esa persona.
    await expect(run((tx) =>
      addPersonFact(tx, ORG, { userId: null, source: "agente" }, { contactId: elena.contactId, text: "Prefiere WhatsApp", conversationId: other.conversationId }),
    )).rejects.toMatchObject({ code: "NOT_FOUND" })
    for (let index = 0; index < PERSON_FACT_LIMIT; index += 1) {
      await run((tx) => addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: elena.contactId, text: `Dato práctico número ${index}` }))
    }
    await expect(run((tx) => addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: elena.contactId, text: "Uno más" })))
      .rejects.toMatchObject({ code: "PERSON_FACT_LIMIT" })
    // Reemplazar no cuenta contra el tope.
    const [first] = await run((tx) => listPersonFacts(tx, ORG, elena.contactId))
    await run((tx) => addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: elena.contactId, text: "Uno más", replacesId: first!.id }))
    expect(await run((tx) => listPersonFacts(tx, ORG, other.contactId))).toEqual([])
    await expect(run((tx) => getPersonMemory(tx, OTHER, elena.contactId), OTHER)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("al agente le llega con fecha y origen, y sin datos si no hay nada", async () => {
    const zone = await run((tx) => getOrgLocale(tx, ORG))
    const empty = await run((tx) => createContact(tx, ORG, { displayName: "Sin memoria" }))
    expect(formatPersonMemoryForPrompt(await run((tx) => getPersonMemory(tx, ORG, empty.id)), zone)).toBeNull()

    const mateo = await person("mateo-mem")
    const fact = await run((tx) =>
      addPersonFact(tx, ORG, { userId: null, source: "agente" }, { contactId: mateo.contactId, text: "Solo puede los sábados", conversationId: mateo.conversationId }))
    await run((tx) => addPersonFact(tx, ORG, { userId: OWNER, source: "equipo" }, { contactId: mateo.contactId, text: "Paga con tarjeta" }))
    const block = formatPersonMemoryForPrompt(await run((tx) => getPersonMemory(tx, ORG, mateo.contactId)), zone)
    const day = new Date().toLocaleDateString(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long" })
    expect(block).toContain(`- Solo puede los sábados (id ${fact.id}; lo dijo por Telegram el ${day})`)
    expect(block).toContain(`lo anotó el equipo el ${day})`)
    expect(block).toContain("si hoy dice otra cosa, vale lo de hoy")
  })

  it("«la última vez» sale de lo que el sistema ya guarda, sin nada clínico y solo si se pide", async () => {
    const rosa = await person("rosa-ultima")
    // El agente no la recibe: solo la pantalla la pide.
    expect(await run((tx) => getPersonMemory(tx, ORG, rosa.contactId))).not.toHaveProperty("lastTime")
    const zone = await run((tx) => getOrgLocale(tx, ORG))
    const first = (await run((tx) => getPersonMemory(tx, ORG, rosa.contactId, { lastTime: { appointments: true } }))).lastTime!
    expect(first).toMatchObject({ timezone: zone.timezone, locale: zone.locale, appointment: null, handoff: null })
    expect(first.wrote?.channel).toBe("telegram")
    expect(Date.now() - Date.parse(first.wrote!.at)).toBeLessThan(60_000)

    // Su caso pasó a una persona: el motivo se dice, salvo que parezca información de salud.
    await run((tx) =>
      createHandoff(tx, ORG, null, { conversationId: rosa.conversationId, reason: "Pide hablar con una persona", summary: "Escribió: «Hola»", priority: "media", createdBy: "agent" }))
    expect((await run((tx) => getPersonMemory(tx, ORG, rosa.contactId, { lastTime: { appointments: true } }))).lastTime!.handoff)
      .toMatchObject({ reason: "Pide hablar con una persona" })
    await run((tx) =>
      createHandoff(tx, ORG, null, { conversationId: rosa.conversationId, reason: "Dolor de muela intenso", summary: "Escribió: «Hola»", priority: "alta", createdBy: "agent" }))
    expect((await run((tx) => getPersonMemory(tx, ORG, rosa.contactId, { lastTime: { appointments: true } }))).lastTime!.handoff)
      .toMatchObject({ reason: null })

    // Su cita: la próxima en pie; si no hay, la última que pasó. Solo cuándo, dónde y con quién.
    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Surco", timezone: "America/Lima" }).returning({ id: branch.id })
    const dentist = "dentista-ultima"
    await ownerDb.insert(user).values([{ id: dentist, name: "Dra. Ana Torres", email: "ana.torres@ultima.test", emailVerified: true }])
    await ownerDb.insert(member).values([{ id: `m-${dentist}`, userId: dentist, organizationId: ORG, role: "member", createdAt: new Date() }])
    const chair = await run((tx) => createChair(tx, ORG, { branchId: site!.id, name: "Sillón U" }))
    const [created] = await ownerDb
      .insert(patient)
      .values({ organizationId: ORG, displayName: "Rosa Díaz", givenNames: "Rosa", patientNumber: await run((tx) => nextPatientNumber(tx, ORG)) })
      .returning({ id: patient.id })
    await run((tx) => setPatientContact(tx, ORG, OWNER, created!.id, { contactId: rosa.contactId, relationship: "self", isPreferred: true }))
    const visit = (startsAt: Date, status: string) => ({
      organizationId: ORG, branchId: site!.id, patientId: created!.id, dentistUserId: dentist, chairId: chair.id,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status,
      serviceName: "Endodoncia", reason: "Dolor de muela",
    })
    const past = new Date(Date.now() - 7 * 86_400_000)
    const future = new Date(Date.now() + 2 * 86_400_000)
    await ownerDb.insert(appointment).values([visit(past, "atendida"), visit(new Date(past.getTime() + 86_400_000), "cancelada")])
    const afterPast = (await run((tx) => getPersonMemory(tx, ORG, rosa.contactId, { lastTime: { appointments: true } }))).lastTime!
    expect(afterPast.appointment).toEqual({
      startsAt: past.toISOString(), status: "atendida", upcoming: false, branchName: "Surco", dentistName: "Dra. Ana Torres",
    })
    await ownerDb.insert(appointment).values([visit(future, "programada")])
    const withNext = (await run((tx) => getPersonMemory(tx, ORG, rosa.contactId, { lastTime: { appointments: true } }))).lastTime!
    expect(withNext.appointment).toMatchObject({ startsAt: future.toISOString(), status: "programada", upcoming: true })
    // Ni el servicio ni el motivo de la cita viajan.
    expect(JSON.stringify(withNext)).not.toMatch(/Endodoncia|Dolor/)
    // Quien no ve la agenda no recibe la cita.
    expect((await run((tx) => getPersonMemory(tx, ORG, rosa.contactId, { lastTime: { appointments: false } }))).lastTime!.appointment).toBeNull()
    // Lo que sale de la ficha o de la agenda dice dónde se cambia.
    const memory = await run((tx) => getPersonMemory(tx, ORG, rosa.contactId))
    for (const item of memory.derived) expect(["ficha", "agenda"]).toContain(item.managedIn)
  })
})

describe("resumen del caso para quien lo toma", () => {
  it("reúne lo que la persona escribió, lo que ya se sabe con su origen y nada de otra organización", async () => {
    const ana = await person("ana-resumen")
    await run((tx) => addAgentCaseNote(tx, ORG, ana.conversationId, "La cita es para ella; sede Miraflores"))
    await run((tx) =>
      addPersonFact(tx, ORG, { userId: null, source: "agente" }, {
        contactId: ana.contactId, text: "Prefiere citas por la tarde", conversationId: ana.conversationId,
      }))
    // Sin derivación: lo que escribió sale de sus últimos mensajes seguidos.
    const before = await run((tx) => getCaseBrief(tx, ORG, ana.conversationId))
    expect(before.handoff).toBeNull()
    expect(before.said).toEqual(["Hola"])

    await run((tx) =>
      createHandoff(tx, ORG, null, {
        conversationId: ana.conversationId,
        reason: "Urgencia clínica",
        summary: "Escribió: «Hola» · «Tengo la cara hinchada desde anoche» · «¿Me pueden atender?»",
        priority: "alta",
        createdBy: "agent",
      }))
    const created = await run((tx) => listHandoffs(tx, ORG, { conversationId: ana.conversationId }))
    // Lo que se sabe después de registrarla se completa sin tocar motivo ni prioridad; lo vacío no borra nada.
    await run((tx) => annotateHandoff(tx, ORG, created[0]!.id, { asks: "Que la atiendan hoy", pending: "  ", notice: "Ya avisé al equipo." }))
    await run((tx) => annotateHandoff(tx, ORG, created[0]!.id, { pending: "Saber si puede venir hoy" }))
    await run((tx) => annotateHandoff(tx, OTHER, created[0]!.id, { asks: "Otra clínica no la cambia" }), OTHER)
    const brief = await run((tx) => getCaseBrief(tx, ORG, ana.conversationId))
    expect(brief.handoff).toMatchObject({
      reason: "Urgencia clínica", priority: "alta", status: "abierta",
      asks: "Que la atiendan hoy", pending: "Saber si puede venir hoy", notice: "Ya avisé al equipo.",
    })
    expect(brief.channel).toBe("telegram")
    expect(brief.contactName).toBeTruthy()
    expect(brief.said).toEqual(["Hola", "Tengo la cara hinchada desde anoche", "¿Me pueden atender?"])
    expect(brief.known.map((item) => [item.origin, item.text, item.channel])).toEqual([
      ["caso", "La cita es para ella; sede Miraflores", null],
      ["persona", "Prefiere citas por la tarde", "telegram"],
    ])
    // Quien no puede ver lo que se recuerda de la persona recibe solo lo del caso.
    const limited = await run((tx) => getCaseBrief(tx, ORG, ana.conversationId, { includePerson: false }))
    expect(limited.known.map((item) => item.origin)).toEqual(["caso"])
    // Otra organización no llega a esta conversación.
    await expect(run((tx) => getCaseBrief(tx, OTHER, ana.conversationId), OTHER)).rejects.toMatchObject({ status: 404 })
  })

  it("lee los mensajes citados en una derivación y nada más", () => {
    expect(parseHandoffSaid("Escribió: «uno» · «dos»")).toEqual(["uno", "dos"])
    expect(parseHandoffSaid("Solicita que recepción continúe el caso.")).toEqual([])
  })
})

describe("reservar desde un enlace", () => {
  /** Próximo lunes con margen, a medianoche de Lima. */
  function upcomingMonday(): Date {
    const day = new Date(Date.now() + 3 * 86_400_000)
    day.setUTCHours(5, 0, 0, 0)
    while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1)
    return day
  }

  it("reserva una vez, con la operación de Agenda, y deja constancia en el caso", async () => {
    const eva = await person("eva-enlace")
    // Aún no es paciente y la clínica no tiene activo el registro en línea: no hay con qué pedirle sus datos.
    await expect(run((tx) => createBookingLink(tx, ORG, { conversationId: eva.conversationId }, { secretsKey: KEY }))).rejects.toMatchObject({ code: "BOOKING_NEEDS_PATIENT" })

    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Miraflores", timezone: "America/Lima" }).returning({ id: branch.id })
    const dentist = "dentista-enlace"
    await ownerDb.insert(user).values([{ id: dentist, name: "Dra. Lucía Salas", email: "lucia.salas@enlace.test", emailVerified: true }])
    await ownerDb.insert(member).values([{ id: `m-${dentist}`, userId: dentist, organizationId: ORG, role: "member", createdAt: new Date() }])
    await run((tx) => createChair(tx, ORG, { branchId: site!.id, name: "Sillón 1" }))
    await run((tx) =>
      setProfessionalSchedule(tx, ORG, OWNER, {
        branchId: site!.id,
        dentistUserId: dentist,
        rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 13 * 60 })),
      }))
    const [created] = await ownerDb
      .insert(patient)
      .values({ organizationId: ORG, displayName: "Eva María Rojas", givenNames: "Eva María", patientNumber: await run((tx) => nextPatientNumber(tx, ORG)) })
      .returning({ id: patient.id })
    await run((tx) => setPatientContact(tx, ORG, OWNER, created!.id, { contactId: eva.contactId, relationship: "self", isPreferred: true }))

    const first = await run((tx) => createBookingLink(tx, ORG, { conversationId: eva.conversationId, branchId: site!.id }, { secretsKey: KEY }))
    expect(first.token).toMatch(/^[0-9a-f]{64}$/)
    // «Su enlace» es uno por persona: enviarlo otra vez da el mismo, y solo se guarda su huella.
    const link = await run((tx) => createBookingLink(tx, ORG, { conversationId: eva.conversationId, branchId: site!.id }, { secretsKey: KEY }))
    expect(link.token).toBe(first.token)
    const stored = await ownerDb.select().from(appointmentBookingLink).where(eq(appointmentBookingLink.conversationId, eva.conversationId))
    expect(stored).toHaveLength(1)
    expect(stored.map((row) => row.tokenHash)).not.toContain(link.token)

    const view = await run((tx) => getBookingLinkView(tx, ORG, link.token))
    expect(view).toMatchObject({
      status: "abierto",
      firstName: "Eva",
      patientFirstName: null,
      booking: { needsRegistration: false, service: null, branchId: site!.id },
      appointment: null,
    })
    expect(view.branches.map((item) => item.name)).toEqual(["Miraflores"])
    // No hay tarifas en nada de lo que entrega la página.
    expect(JSON.stringify(view)).not.toMatch(/price|precio|S\//i)

    const monday = upcomingMonday()
    const range = { branchId: site!.id, from: monday.toISOString(), to: new Date(monday.getTime() + 86_400_000).toISOString() }
    const { slots } = await run((tx) => listBookingLinkSlots(tx, ORG, link.token, range))
    expect(slots.length).toBeGreaterThan(0)
    expect(slots[0]).toMatchObject({ dentistUserId: dentist, dentistName: "Dra. Lucía Salas" })
    // Otra organización, o un enlace mal escrito, no encuentran nada.
    await expect(run((tx) => getBookingLinkView(tx, OTHER, link.token), OTHER)).rejects.toMatchObject({ status: 404 })
    await expect(run((tx) => getBookingLinkView(tx, ORG, "no-es-un-enlace"))).rejects.toMatchObject({ status: 404 })

    const chosen = slots[0]!
    const booked = await run((tx) =>
      reserveBookingLink(tx, ORG, link.token, { branchId: site!.id, startsAt: chosen.startsAt, dentistUserId: chosen.dentistUserId, ...(chosen.chairId ? { chairId: chosen.chairId } : {}) }, { secretsKey: KEY }))
    expect(booked).toMatchObject({ startsAt: chosen.startsAt, branchName: "Miraflores", dentistName: "Dra. Lucía Salas" })
    const rows = await ownerDb.select().from(appointment).where(eq(appointment.patientId, created!.id))
    expect(rows.map((row) => [row.status, row.source, row.createdBy, row.conversationId])).toEqual([["programada", "enlace", null, eva.conversationId]])
    // El enlace no reserva dos veces y la página muestra la cita; ese horario ya no se ofrece.
    const after = await run((tx) => listBookingLinkSlots(tx, ORG, link.token, range))
    expect(after.slots.map((slot) => slot.startsAt)).not.toContain(chosen.startsAt)
    await expect(run((tx) =>
      reserveBookingLink(tx, ORG, link.token, { branchId: site!.id, startsAt: slots[1]!.startsAt, dentistUserId: dentist }))).rejects.toMatchObject({ code: "BOOKING_LINK_USED" })
    expect((await run((tx) => getBookingLinkView(tx, ORG, link.token))).appointment).toMatchObject({ startsAt: chosen.startsAt, canChange: true, cancelled: false })
    // El agente y quien tome el caso lo ven: queda anotado en el caso.
    const brief = await run((tx) => getCaseBrief(tx, ORG, eva.conversationId))
    expect(brief.known.map((item) => item.text).join(" ")).toContain("Reservó desde su enlace")

    // Con la cita reservada, el mismo enlace la cambia de horario: es la misma cita, movida, con las reglas de la Agenda.
    const other = after.slots[0]!
    await expect(run((tx) => listBookingLinkSlots(tx, ORG, link.token, { ...range, branchId: "00000000-0000-4000-8000-000000000099" }))).rejects.toMatchObject({ status: 400 })
    const moved = await run((tx) =>
      changeBookingLinkAppointment(tx, ORG, link.token, { startsAt: other.startsAt, dentistUserId: other.dentistUserId }, { secretsKey: KEY }))
    expect(moved).toMatchObject({ startsAt: other.startsAt, canChange: true })
    const movedRows = await ownerDb.select().from(appointment).where(eq(appointment.patientId, created!.id))
    expect(movedRows.map((row) => [row.id, row.status, row.startsAt.toISOString()])).toEqual([[rows[0]!.id, "programada", other.startsAt]])
    // Otra organización no llega a la cita con ese enlace.
    await expect(run((tx) => cancelBookingLinkAppointment(tx, OTHER, link.token), OTHER)).rejects.toMatchObject({ status: 404 })

    // Y la cancela: queda cancelada con su motivo, el enlace ya no cambia nada y el caso lo recuerda.
    const cancelled = await run((tx) => cancelBookingLinkAppointment(tx, ORG, link.token, { secretsKey: KEY }))
    expect(cancelled).toMatchObject({ cancelled: true, canChange: false })
    expect((await ownerDb.select().from(appointment).where(eq(appointment.patientId, created!.id))).map((row) => row.status)).toEqual(["cancelada"])
    await expect(run((tx) => cancelBookingLinkAppointment(tx, ORG, link.token))).rejects.toMatchObject({ code: "BOOKING_NOT_CHANGEABLE" })
    await expect(run((tx) =>
      changeBookingLinkAppointment(tx, ORG, link.token, { startsAt: chosen.startsAt, dentistUserId: dentist }))).rejects.toMatchObject({ code: "BOOKING_NOT_CHANGEABLE" })
    await expect(run((tx) => listBookingLinkSlots(tx, ORG, link.token, range))).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
    const notes = (await run((tx) => getCaseBrief(tx, ORG, eva.conversationId))).known.map((item) => item.text).join(" ")
    expect(notes).toContain("Cambió su cita desde su enlace")
    expect(notes).toContain("Canceló desde su enlace")
  })
})

describe("reservar desde un enlace quien recién se contacta", () => {
  it("elige, deja sus datos esenciales y reserva; la ficha la crea el registro y queda señalado lo que falta", async () => {
    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "San Isidro", timezone: "America/Lima" }).returning({ id: branch.id })
    const dentist = "dentista-nuevo"
    await ownerDb.insert(user).values([{ id: dentist, name: "Dr. Mario Paz", email: "mario.paz@enlace.test", emailVerified: true }])
    await ownerDb.insert(member).values([{ id: `m-${dentist}`, userId: dentist, organizationId: ORG, role: "member", createdAt: new Date() }])
    await run((tx) => createChair(tx, ORG, { branchId: site!.id, name: "Sillón A" }))
    await run((tx) =>
      setProfessionalSchedule(tx, ORG, OWNER, {
        branchId: site!.id,
        dentistUserId: dentist,
        rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 13 * 60 })),
      }))
    // La clínica activa su registro de pacientes: define qué datos pide y su aviso de privacidad.
    const config = await run((tx) => getPatientRegistrationConfig(tx, ORG))
    // Además de lo obligatorio de siempre, esta clínica exige el sexo: el formulario corto no lo pide.
    const published = await run((tx) =>
      savePatientRegistrationConfig(tx, ORG, OWNER, {
        expectedVersion: config.version, enabled: true, fields: { ...config.fields, sex: "required" }, privacyNotice: "Tus datos se usan solo para tu atención.",
      }))

    const nuevo = await person("nuevo-enlace")
    const link = await run((tx) => createBookingLink(tx, ORG, { conversationId: nuevo.conversationId, branchId: site!.id }, { secretsKey: KEY }))
    expect(link).toMatchObject({ patientName: null, needsRegistration: true })
    const before = await run((tx) => getBookingLinkView(tx, ORG, link.token))
    expect(before).toMatchObject({ status: "abierto", booking: { needsRegistration: true }, patientFirstName: null })

    // Puede ver los horarios, pero no reservar sin sus datos.
    const day = new Date(Date.now() + 3 * 86_400_000)
    day.setUTCHours(5, 0, 0, 0)
    while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1)
    const range = { branchId: site!.id, from: day.toISOString(), to: new Date(day.getTime() + 86_400_000).toISOString() }
    const { slots } = await run((tx) => listBookingLinkSlots(tx, ORG, link.token, range))
    const chosen = slots[0]!
    const choice = { branchId: site!.id, startsAt: chosen.startsAt, dentistUserId: chosen.dentistUserId, ...(chosen.chairId ? { chairId: chosen.chairId } : {}) }
    await expect(run((tx) => reserveBookingLink(tx, ORG, link.token, choice, { secretsKey: KEY }))).rejects.toMatchObject({ code: "BOOKING_NEEDS_REGISTRATION" })
    expect(await ownerDb.select().from(appointment).where(eq(appointment.conversationId, nuevo.conversationId))).toEqual([])

    // La página pide lo esencial con el registro vigente de la clínica. Escribe por Telegram: no se le supone un celular.
    const form = await run((tx) => getBookingLinkRegistrationForm(tx, ORG, link.token))
    expect(form).toMatchObject({ phone: null, config: { version: published.version, privacyNotice: "Tus datos se usan solo para tu atención." } })
    const essentials = {
      demographics: { displayName: "Carla Núñez Prado", givenNames: "Carla", paternalSurname: "Núñez", maternalSurname: "Prado", docType: "DNI" as const, docNumber: "45678912", phone: "+51987654321" },
      respondent: "patient" as const,
      privacyAccepted: true,
    }
    const send = (answers: object, formVersion = published.version) =>
      run((tx) => registerFromBookingLink(tx, ORG, link.token, { submissionId: randomUUID(), formVersion, answers: answers as typeof essentials }))
    // Valen las reglas del registro: aviso aceptado, documento válido, versión vigente, y nada fuera de lo esencial.
    await expect(send({ ...essentials, privacyAccepted: false })).rejects.toMatchObject({ status: 400 })
    await expect(send({ ...essentials, demographics: { ...essentials.demographics, docNumber: "123" } })).rejects.toMatchObject({ status: 400 })
    await expect(send({ ...essentials, demographics: { ...essentials.demographics, phone: "" } })).rejects.toMatchObject({ status: 400 })
    await expect(send({ ...essentials, demographics: { ...essentials.demographics, occupation: "Abogada" } })).rejects.toMatchObject({ status: 400 })
    await expect(send(essentials, published.version + 1)).rejects.toMatchObject({ code: "FORM_CHANGED" })
    expect(await run((tx) => listPatientsByContact(tx, ORG, nuevo.contactId))).toEqual([])
    // Un rechazo no deja enlaces de registro a medias.
    expect(await ownerDb.select().from(patientRegistrationLink).where(eq(patientRegistrationLink.contactId, nuevo.contactId))).toEqual([])
    // El registro público de la clínica no acepta ese alcance sin el enlace de una conversación.
    await expect(run((tx) =>
      registerPatient(tx, ORG, { kind: "public", entryPoint: "qr", scope: "essentials" }, { submissionId: randomUUID(), formVersion: published.version, answers: essentials }))).rejects.toMatchObject({ status: 400 })

    // Sus datos entran por el registro de pacientes, que crea la ficha y la vincula a esta persona.
    expect(await send(essentials)).toEqual({ registered: true })
    const linked = await run((tx) => listPatientsByContact(tx, ORG, nuevo.contactId))
    expect(linked).toHaveLength(1)
    const registered = linked[0]!
    const [ficha] = await ownerDb.select().from(patient).where(eq(patient.id, registered.id))
    // Queda con lo esencial; lo demás vacío y la identidad por revisar, que es lo que ve recepción en la ficha.
    expect(ficha).toMatchObject({
      displayName: "Carla Núñez Prado", docType: "DNI", docNumber: "45678912", phone: "+51987654321",
      birthDate: null, sex: null, identityNeedsReview: true,
    })
    // Mismo consentimiento y misma procedencia que cualquier registro: versión del aviso, enlace consumido y conversación.
    const consents = await ownerDb.select().from(patientDataConsent).where(eq(patientDataConsent.patientId, registered.id))
    expect(consents.map((row) => [row.noticeVersion, row.noticeText, row.channel, row.grantedByName])).toEqual([
      [published.version, "Tus datos se usan solo para tu atención.", "formulario_publico", "Carla Núñez Prado"],
    ])
    const [provenance] = await ownerDb.select().from(patientRegistration).where(eq(patientRegistration.patientId, registered.id))
    expect(provenance).toMatchObject({ entryPoint: "conversation", respondent: "patient", conversationId: nuevo.conversationId, contextContactId: nuevo.contactId, formVersion: published.version })
    const links = await ownerDb.select().from(patientRegistrationLink).where(eq(patientRegistrationLink.contactId, nuevo.contactId))
    expect(links.map((row) => [row.id, row.createdBy, row.consumedAt !== null])).toEqual([[provenance!.linkId, null, true]])
    expect((await ownerDb.select().from(auditEvent).where(eq(auditEvent.entityId, registered.id))).map((row) => row.action)).toContain("patient.created")
    // Lo que la clínica exige y no se pidió queda dicho en el caso.
    const pendingNote = (await run((tx) => getCaseBrief(tx, ORG, nuevo.conversationId))).known.map((item) => item.text).join(" ")
    expect(pendingNote).toContain("Faltan datos para atenderla: confirmar apellidos y nombres, fecha de nacimiento, sexo.")

    // Ya es paciente: el mismo enlace reserva, y no vuelve a pedir datos.
    const after = await run((tx) => getBookingLinkView(tx, ORG, link.token))
    expect(after).toMatchObject({ booking: { needsRegistration: false }, firstName: "Carla", patientFirstName: null })
    await expect(run((tx) => getBookingLinkRegistrationForm(tx, ORG, link.token))).rejects.toMatchObject({ code: "BOOKING_ALREADY_PATIENT" })
    await expect(send(essentials)).rejects.toMatchObject({ code: "BOOKING_ALREADY_PATIENT" })
    const booked = await run((tx) => reserveBookingLink(tx, ORG, link.token, choice, { secretsKey: KEY }))
    expect(booked).toMatchObject({ startsAt: chosen.startsAt, branchName: "San Isidro", dentistName: "Dr. Mario Paz" })
    const rows = await ownerDb.select().from(appointment).where(eq(appointment.patientId, registered.id))
    expect(rows.map((row) => [row.status, row.source])).toEqual([["programada", "enlace"]])
  })

  it("propone el celular solo cuando la conversación es de WhatsApp", async () => {
    const quien = await person("wa-enlace")
    const link = await run((tx) => createBookingLink(tx, ORG, { conversationId: quien.conversationId }, { secretsKey: KEY }))
    expect((await run((tx) => getBookingLinkRegistrationForm(tx, ORG, link.token))).phone).toBeNull()
    // La misma conversación, ahora por WhatsApp: su identificador es el número.
    const [thread] = await ownerDb.select().from(conversation).where(eq(conversation.id, quien.conversationId))
    await ownerDb.update(channelConnection).set({ channel: "whatsapp" }).where(eq(channelConnection.id, thread!.channelConnectionId))
    await ownerDb.update(contactIdentity).set({ channel: "whatsapp", externalUserId: "51987111222" }).where(eq(contactIdentity.id, thread!.contactIdentityId!))
    expect((await run((tx) => getBookingLinkRegistrationForm(tx, ORG, link.token))).phone).toBe("+51987111222")
  })

  it("para otra persona: valen las reglas del registro sobre menores y quien escribe queda como responsable", async () => {
    const config = await run((tx) => getPatientRegistrationConfig(tx, ORG))
    const madre = await person("madre-enlace")
    const link = await run((tx) => createBookingLink(tx, ORG, { conversationId: madre.conversationId }, { secretsKey: KEY }))
    const answers = {
      demographics: { displayName: "Mateo Rojas Lima", givenNames: "Mateo", paternalSurname: "Rojas", maternalSurname: "Lima", docType: "DNI" as const, docNumber: "78123456", birthDate: "2018-03-10" },
      respondent: "representative" as const,
      representative: { displayName: "Rosa Lima", relationship: "guardian" as const, relationshipDetail: "", phone: "+51955111222", docType: "DNI" as const, docNumber: "41234567" },
      privacyAccepted: true,
    }
    const send = (value: object) =>
      run((tx) => registerFromBookingLink(tx, ORG, link.token, { submissionId: randomUUID(), formVersion: config.version, answers: value as typeof answers }))
    // Sin la fecha de nacimiento no se sabe si hace falta un representante; un menor lo exige con su documento.
    await expect(send({ ...answers, demographics: { ...answers.demographics, birthDate: undefined } })).rejects.toMatchObject({ status: 400 })
    await expect(send({ ...answers, representative: { displayName: "Rosa Lima", relationship: "guardian", relationshipDetail: "", phone: "+51955111222" } })).rejects.toMatchObject({ status: 400 })
    await expect(send({ ...answers, respondent: "patient", representative: undefined })).rejects.toMatchObject({ status: 400 })

    expect(await send(answers)).toEqual({ registered: true })
    const [child] = await run((tx) => listPatientsByContact(tx, ORG, madre.contactId))
    // La ficha es del menor, con su propia persona; quien escribe queda vinculada como tutora, no como paciente.
    expect(child).toMatchObject({ displayName: "Mateo Rojas Lima", relationship: "guardian" })
    const consents = await ownerDb.select().from(patientDataConsent).where(eq(patientDataConsent.patientId, child!.id))
    expect(consents.map((row) => row.grantedByName)).toEqual(["Rosa Lima"])
    expect((await run((tx) => getBookingLinkView(tx, ORG, link.token)))).toMatchObject({ booking: { needsRegistration: false }, patientFirstName: "Mateo" })
  })
})
