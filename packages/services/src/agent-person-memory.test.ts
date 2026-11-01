import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type Db, type InboundMessageJob, withOrgContext } from "@odentia/db"
import { agentPersonFact } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { automationConsent } from "@odentia/db/schema/automation"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { patient, patientDataConsent, patientRegistration, patientRegistrationLink } from "@odentia/db/schema/clinical"
import { agentConfig, channelConnection, contact, contactIdentity, conversation } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { auditEvent } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it, onTestFinished } from "vitest"
import {
  addPersonFact,
  formatPersonMemoryForPrompt,
  getPersonMemory,
  listPersonFacts,
  looksClinical,
  PERSON_FACT_LIMIT,
  removePersonFact,
} from "./agent-person-memory.js"
import { lastAgentActions } from "./agent-actions.js"
import { addAgentCaseNote } from "./agent-case.js"
import { setMessageChoice } from "./automation.js"
import { getCaseBrief, parseHandoffSaid } from "./agent-case-brief.js"
import { annotateHandoff, createHandoff, listHandoffs } from "./agent-operations.js"
import { createRoom } from "./appointments.js"
import { setProfessionalSchedule } from "./availability.js"
import {
  cancelBookingLinkAppointment,
  changeBookingLinkAppointment,
  createBookingLink,
  listBookingLinkProfessionals,
  listBookingLinkSlots,
  reserveBookingLink,
  getBookingLinkRegistrationForm,
  registerFromBookingLink,
} from "./booking-links.js"
import { getPersonalLinkView as getBookingLinkView, reservePersonalLink } from "./su-enlace.js"
import { createConnection } from "./connections.js"
import { createContact, getContact, updateContact } from "./contacts.js"
import { type IngestDeps, ingestInbound } from "./conversations.js"
import { getOrgLocale } from "./locale.js"
import { getPatientRegistrationConfig, registerPatient, savePatientRegistrationConfig } from "./patient-registration.js"
import { listPatientsByContact, nextPatientNumber, setPatientContact } from "./patients.js"
import { listPersonNotes } from "./people.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients, selectTestPatients } from "./test-patient.js"

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
    const professional = "dentista-ultima"
    await ownerDb.insert(user).values([{ id: professional, name: "Dra. Ana Torres", email: "ana.torres@ultima.test", emailVerified: true }])
    await ownerDb.insert(member).values([{ id: `m-${professional}`, userId: professional, organizationId: ORG, role: "clinician", createdAt: new Date() }])
    const room = await run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental U" }))
    const [created] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Rosa Díaz", givenNames: "Rosa", patientNumber: await run((tx) => nextPatientNumber(tx, ORG)) })
    await run((tx) => setPatientContact(tx, ORG, OWNER, created!.id, { contactId: rosa.contactId, relationship: "self", isPreferred: true }))
    const visit = (startsAt: Date, status: string) => ({
      organizationId: ORG, branchId: site!.id, patientId: created!.id, professionalUserId: professional, roomId: room.id,
      startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30, status,
      serviceName: "Endodoncia", reason: "Dolor de muela",
    })
    const past = new Date(Date.now() - 7 * 86_400_000)
    const future = new Date(Date.now() + 2 * 86_400_000)
    await ownerDb.insert(appointment).values([visit(past, "atendida"), visit(new Date(past.getTime() + 86_400_000), "cancelada")])
    const afterPast = (await run((tx) => getPersonMemory(tx, ORG, rosa.contactId, { lastTime: { appointments: true } }))).lastTime!
    expect(afterPast.appointment).toEqual({
      startsAt: past.toISOString(), status: "atendida", upcoming: false, branchName: "Surco", professionalName: "Dra. Ana Torres",
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
    // El enlace lo dio Sofi: está encendida. Apagada, queda solo la nota del caso.
    await ownerDb.insert(agentConfig).values({ organizationId: ORG, enabled: true }).onConflictDoUpdate({ target: agentConfig.organizationId, set: { enabled: true } })
    onTestFinished(async () => {
      await ownerDb.update(agentConfig).set({ enabled: false }).where(eq(agentConfig.organizationId, ORG))
    })
    const eva = await person("eva-enlace")
    // Aún no es paciente y la clínica no tiene activo el registro en línea: no hay con qué pedirle sus datos.
    await expect(run((tx) => createBookingLink(tx, ORG, { conversationId: eva.conversationId }, { secretsKey: KEY }))).rejects.toMatchObject({ code: "BOOKING_NEEDS_PATIENT" })

    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Miraflores", timezone: "America/Lima" }).returning({ id: branch.id })
    const professional = "dentista-enlace"
    await ownerDb.insert(user).values([{ id: professional, name: "Dra. Lucía Salas", email: "lucia.salas@enlace.test", emailVerified: true }])
    await ownerDb.insert(member).values([{ id: `m-${professional}`, userId: professional, organizationId: ORG, role: "clinician", createdAt: new Date() }])
    await run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental 1" }))
    await run((tx) =>
      setProfessionalSchedule(tx, ORG, OWNER, {
        branchId: site!.id,
        professionalUserId: professional,
        rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 13 * 60 })),
      }))
    const [created] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Eva María Rojas", givenNames: "Eva María", patientNumber: await run((tx) => nextPatientNumber(tx, ORG)) })
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
    expect(slots[0]).toMatchObject({ professionalUserId: professional, professionalName: "Dra. Lucía Salas" })
    // Otra organización, o un enlace mal escrito, no encuentran nada.
    await expect(run((tx) => getBookingLinkView(tx, OTHER, link.token), OTHER)).rejects.toMatchObject({ status: 404 })
    await expect(run((tx) => getBookingLinkView(tx, ORG, "no-es-un-enlace"))).rejects.toMatchObject({ status: 404 })

    const chosen = slots[0]!
    const booked = await run((tx) =>
      reserveBookingLink(tx, ORG, link.token, { branchId: site!.id, startsAt: chosen.startsAt, professionalUserId: chosen.professionalUserId, ...(chosen.roomId ? { roomId: chosen.roomId } : {}) }, { secretsKey: KEY }))
    expect(booked).toMatchObject({ startsAt: chosen.startsAt, branchName: "Miraflores", professionalName: "Dra. Lucía Salas" })
    const rows = await ownerDb.select().from(appointment).where(eq(appointment.patientId, created!.id))
    // La eligió la propia persona: nace confirmada, sin pedirle «Confirmar».
    expect(rows.map((row) => [row.status, row.source, row.createdBy, row.conversationId])).toEqual([["confirmada", "enlace", null, eva.conversationId]])
    // El enlace no reserva dos veces y la página muestra la cita; ese horario ya no se ofrece.
    const after = await run((tx) => listBookingLinkSlots(tx, ORG, link.token, range))
    expect(after.slots.map((slot) => slot.startsAt)).not.toContain(chosen.startsAt)
    await expect(run((tx) =>
      reserveBookingLink(tx, ORG, link.token, { branchId: site!.id, startsAt: slots[1]!.startsAt, professionalUserId: professional }))).rejects.toMatchObject({ code: "BOOKING_LINK_USED" })
    expect((await run((tx) => getBookingLinkView(tx, ORG, link.token))).appointment).toMatchObject({ startsAt: chosen.startsAt, canChange: true, cancelled: false })
    // Para cambiarla, «Con quién» marca a quien la tiene hoy.
    const who = await run((tx) => listBookingLinkProfessionals(tx, ORG, link.token, { branchId: site!.id }))
    expect(who.professionals).toEqual([expect.objectContaining({ id: professional, name: "Dra. Lucía Salas", current: true })])
    // El agente y quien tome el caso lo ven: queda anotado en el caso.
    const brief = await run((tx) => getCaseBrief(tx, ORG, eva.conversationId))
    expect(brief.known.map((item) => item.text).join(" ")).toContain("Reservó desde su enlace")
    // Lo hizo con el enlace que le dio Sofi: el hilo y la fila de la Bandeja lo dicen como lo que hizo Sofi.
    const done = (await run((tx) => lastAgentActions(tx, ORG, [eva.conversationId]))).get(eva.conversationId)
    expect(done).toMatchObject({ title: "reservó una cita", state: "hecho" })
    expect(done?.what).toMatch(/· desde su enlace$/)

    // Con la cita reservada, el mismo enlace la cambia de horario: es la misma cita, movida, con las reglas de la Agenda.
    const other = after.slots[0]!
    await expect(run((tx) => listBookingLinkSlots(tx, ORG, link.token, { ...range, branchId: "00000000-0000-4000-8000-000000000099" }))).rejects.toMatchObject({ status: 400 })
    const moved = await run((tx) =>
      changeBookingLinkAppointment(tx, ORG, link.token, { startsAt: other.startsAt, professionalUserId: other.professionalUserId }, { secretsKey: KEY }))
    expect(moved).toMatchObject({ startsAt: other.startsAt, canChange: true })
    const movedRows = await ownerDb.select().from(appointment).where(eq(appointment.patientId, created!.id))
    expect(movedRows.map((row) => [row.id, row.status, row.startsAt.toISOString()])).toEqual([[rows[0]!.id, "confirmada", other.startsAt]])
    // Otra organización no llega a la cita con ese enlace.
    await expect(run((tx) => cancelBookingLinkAppointment(tx, OTHER, link.token), OTHER)).rejects.toMatchObject({ status: 404 })

    // Y la cancela: queda cancelada con su motivo, el enlace ya no cambia nada y el caso lo recuerda.
    const cancelled = await run((tx) => cancelBookingLinkAppointment(tx, ORG, link.token, { secretsKey: KEY }))
    expect(cancelled).toMatchObject({ cancelled: true, canChange: false })
    expect((await ownerDb.select().from(appointment).where(eq(appointment.patientId, created!.id))).map((row) => row.status)).toEqual(["cancelada"])
    await expect(run((tx) => cancelBookingLinkAppointment(tx, ORG, link.token))).rejects.toMatchObject({ code: "BOOKING_NOT_CHANGEABLE" })
    await expect(run((tx) =>
      changeBookingLinkAppointment(tx, ORG, link.token, { startsAt: chosen.startsAt, professionalUserId: professional }))).rejects.toMatchObject({ code: "BOOKING_NOT_CHANGEABLE" })
    await expect(run((tx) => listBookingLinkSlots(tx, ORG, link.token, range))).rejects.toMatchObject({ code: "BOOKING_LINK_EXPIRED" })
    const notes = (await run((tx) => getCaseBrief(tx, ORG, eva.conversationId))).known.map((item) => item.text).join(" ")
    expect(notes).toContain("Cambió su cita desde su enlace")
    expect(notes).toContain("Canceló desde su enlace")
  })

  it("su enlace para completar sus datos no vuelve a abrir la reserva", async () => {
    const ines = await person("ines-enlace")
    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Barranco", timezone: "America/Lima" }).returning({ id: branch.id })
    const professional = "dentista-datos"
    await ownerDb.insert(user).values([{ id: professional, name: "Dra. Rosa Ibarra", email: "rosa.ibarra@enlace.test", emailVerified: true }])
    await ownerDb.insert(member).values([{ id: `m-${professional}`, userId: professional, organizationId: ORG, role: "clinician", createdAt: new Date() }])
    await run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental 1" }))
    await run((tx) =>
      setProfessionalSchedule(tx, ORG, OWNER, {
        branchId: site!.id,
        professionalUserId: professional,
        rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 13 * 60 })),
      }))
    const [created] = await insertTestPatients(ownerDb, { organizationId: ORG, displayName: "Inés Paredes", givenNames: "Inés", patientNumber: await run((tx) => nextPatientNumber(tx, ORG)) })
    await run((tx) => setPatientContact(tx, ORG, OWNER, created!.id, { contactId: ines.contactId, relationship: "self", isPreferred: true }))

    // Le llega su enlace para reservar y reserva con él.
    const sent = await run((tx) => createBookingLink(tx, ORG, { conversationId: ines.conversationId, branchId: site!.id }, { secretsKey: KEY }))
    const monday = upcomingMonday()
    const range = { branchId: site!.id, from: monday.toISOString(), to: new Date(monday.getTime() + 86_400_000).toISOString() }
    const { slots } = await run((tx) => listBookingLinkSlots(tx, ORG, sent.token, range))
    const chosen = slots[0]!
    await run((tx) =>
      reserveBookingLink(tx, ORG, sent.token, { branchId: site!.id, startsAt: chosen.startsAt, professionalUserId: chosen.professionalUserId, ...(chosen.roomId ? { roomId: chosen.roomId } : {}) }, { secretsKey: KEY }))

    // «Pegar su enlace» para que complete sus datos: es el mismo enlace y no le ofrece reservar otra vez.
    const pasted = await run((tx) => createBookingLink(tx, ORG, { conversationId: ines.conversationId, patientId: created!.id, booking: false }, { secretsKey: KEY }))
    expect(pasted.token).toBe(sent.token)
    const view = await run((tx) => getBookingLinkView(tx, ORG, pasted.token))
    expect(view.booking).toBeNull()
    expect(view.appointment).toMatchObject({ startsAt: chosen.startsAt })
    await expect(run((tx) =>
      reserveBookingLink(tx, ORG, pasted.token, { branchId: site!.id, startsAt: slots[1]!.startsAt, professionalUserId: professional }))).rejects.toMatchObject({ code: "BOOKING_LINK_USED" })
  })

  it("quien ya es paciente reserva y en el mismo paso deja lo que faltaba y lo que acepta; un enlace para sus datos ya no abre la reserva", async () => {
    // La clínica pide el sexo y tiene su aviso publicado.
    const config = await run((tx) => getPatientRegistrationConfig(tx, ORG))
    await run((tx) =>
      savePatientRegistrationConfig(tx, ORG, OWNER, {
        expectedVersion: config.version,
        enabled: true,
        fields: { ...config.fields, sex: "required" },
        privacyNotice: "Tus datos se usan solo para tu atención.",
      }))
    const lia = await person("lia-enlace")
    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Surco", timezone: "America/Lima" }).returning({ id: branch.id })
    const professional = "dentista-paciente"
    await ownerDb.insert(user).values([{ id: professional, name: "Dr. Iván Soto", email: "ivan.soto@enlace.test", emailVerified: true }])
    await ownerDb.insert(member).values([{ id: `m-${professional}`, userId: professional, organizationId: ORG, role: "clinician", createdAt: new Date() }])
    await run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental 1" }))
    await run((tx) =>
      setProfessionalSchedule(tx, ORG, OWNER, {
        branchId: site!.id,
        professionalUserId: professional,
        rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 13 * 60 })),
      }))
    // Registrada por teléfono: sin fecha, sin sexo y sin el aviso aceptado.
    const [created] = await insertTestPatients(ownerDb, {
      organizationId: ORG, displayName: "Lía Campos", givenNames: "Lía", familyName: "Campos", docType: "DNI", docNumber: "40987123",
      phone: "+51987000111", patientNumber: await run((tx) => nextPatientNumber(tx, ORG)),
    })
    await run((tx) => setPatientContact(tx, ORG, OWNER, created!.id, { contactId: lia.contactId, relationship: "self", isPreferred: true }))

    // Al reservar ve lo que ya sabemos, con el documento abreviado, lo que falta y lo pendiente.
    const sent = await run((tx) => createBookingLink(tx, ORG, { conversationId: lia.conversationId, branchId: site!.id }, { secretsKey: KEY }))
    const view = await run((tx) => getBookingLinkView(tx, ORG, sent.token))
    expect(view.you).toEqual({ name: "Lía Campos", givenNames: "Lía", familyName: "Campos", document: "DNI ••••7123", phone: "+51987000111" })
    expect(view.pending).toEqual({ privacy: true, promotions: true, promotionsOffer: false })
    expect(view.data?.missing.map((item) => item.key)).toEqual(expect.arrayContaining(["birthDate", "sex"]))

    // Un enlace para completar sus datos no se impone a ese mensaje: deja de ofrecer la reserva que no usó.
    await run((tx) => createBookingLink(tx, ORG, { conversationId: lia.conversationId, patientId: created!.id, booking: false }, { secretsKey: KEY }))
    expect((await run((tx) => getBookingLinkView(tx, ORG, sent.token))).booking).toBeNull()
    // Le vuelve a llegar la agenda y reserva: en el mismo paso guarda lo que faltaba y lo que acepta.
    await run((tx) => createBookingLink(tx, ORG, { conversationId: lia.conversationId, branchId: site!.id }, { secretsKey: KEY }))
    const monday = upcomingMonday()
    const range = { branchId: site!.id, from: monday.toISOString(), to: new Date(monday.getTime() + 86_400_000).toISOString() }
    const { slots } = await run((tx) => listBookingLinkSlots(tx, ORG, sent.token, range))
    const chosen = slots[0]!
    const booked = await run((tx) =>
      reservePersonalLink(tx, ORG, sent.token, {
        branchId: site!.id, startsAt: chosen.startsAt, professionalUserId: chosen.professionalUserId, ...(chosen.roomId ? { roomId: chosen.roomId } : {}),
        // El celular no faltaba: lo que no falta no se toca aunque venga.
        you: { data: { birthDate: "1990-02-02", sex: "F", phone: "+51900000000" }, privacyAccepted: true, acceptsPromotions: false },
      }, { secretsKey: KEY }))
    expect(booked).toMatchObject({ startsAt: chosen.startsAt })
    const [saved] = await selectTestPatients(ownerDb).where(eq(patient.id, created!.id))
    expect(saved).toMatchObject({ birthDate: "1990-02-02", sex: "F", phone: "+51987000111" })
    const rows = await ownerDb.select().from(appointment).where(eq(appointment.patientId, created!.id))
    expect(rows.map((row) => [row.status, row.source])).toEqual([["confirmada", "enlace"]])
    const consents = await ownerDb.select().from(patientDataConsent).where(eq(patientDataConsent.patientId, created!.id))
    expect(consents.map((row) => [row.channel, row.purposes, row.grantedByContactId])).toEqual([["formulario_publico", ["atencion", "recordatorios"], lia.contactId]])
    const permissions = await ownerDb.select().from(automationConsent).where(eq(automationConsent.contactId, lia.contactId))
    expect(permissions.map((row) => [row.purpose, row.status === "granted", row.source]).sort()).toEqual([
      ["novedades", false, "enlace"],
      ["recordatorio", true, "enlace"],
    ])
    // Ya no queda nada pendiente: no se le vuelve a preguntar; como dijo que no, solo se le ofrece la casilla.
    expect((await run((tx) => getBookingLinkView(tx, ORG, sent.token))).pending).toEqual({ privacy: false, promotions: false, promotionsOffer: true })
  })

  it("quien ve en su enlace un nombre que no es el suyo lo corrige con su documento entero, y quien dijo que no a novedades puede marcar la casilla", async () => {
    const dar = await person("dar-enlace")
    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Magdalena", timezone: "America/Lima" }).returning({ id: branch.id })
    const professional = "dentista-nombre"
    await ownerDb.insert(user).values([{ id: professional, name: "Dra. Milagros Díaz", email: "milagros.diaz@enlace.test", emailVerified: true }])
    await ownerDb.insert(member).values([{ id: `m-${professional}`, userId: professional, organizationId: ORG, role: "clinician", createdAt: new Date() }])
    await run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental M" }))
    await run((tx) =>
      setProfessionalSchedule(tx, ORG, OWNER, {
        branchId: site!.id,
        professionalUserId: professional,
        rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 13 * 60 })),
      }))
    // Una ficha con el nombre equivocado (la de una prueba) y su documento; ya dijo que no a novedades.
    const [created] = await insertTestPatients(ownerDb, {
      organizationId: ORG, displayName: "Paciente Prueba WhatsApp", givenNames: "Paciente", familyName: "Prueba WhatsApp", docType: "DNI", docNumber: "44044243",
      birthDate: "1986-03-21", sex: "M", phone: "+51993029296", patientNumber: await run((tx) => nextPatientNumber(tx, ORG)),
    })
    await run((tx) => setPatientContact(tx, ORG, OWNER, created!.id, { contactId: dar.contactId, relationship: "self", isPreferred: true }))
    await ownerDb.insert(automationConsent).values({ organizationId: ORG, contactId: dar.contactId, purpose: "novedades", status: "revoked", source: "enlace" })

    const sent = await run((tx) => createBookingLink(tx, ORG, { conversationId: dar.conversationId, branchId: site!.id }, { secretsKey: KEY }))
    const view = await run((tx) => getBookingLinkView(tx, ORG, sent.token))
    expect(view.you).toMatchObject({ name: "Paciente Prueba WhatsApp", givenNames: "Paciente", familyName: "Prueba WhatsApp", document: "DNI ••••4243" })
    expect(view.pending).toMatchObject({ promotions: false, promotionsOffer: true })

    const monday = upcomingMonday()
    const range = { branchId: site!.id, from: monday.toISOString(), to: new Date(monday.getTime() + 86_400_000).toISOString() }
    const { slots } = await run((tx) => listBookingLinkSlots(tx, ORG, sent.token, range))
    const chosen = slots[0]!
    const where = { branchId: site!.id, startsAt: chosen.startsAt, professionalUserId: chosen.professionalUserId, ...(chosen.roomId ? { roomId: chosen.roomId } : {}) }
    const name = { givenNames: "Darvin", familyName: "Cotrina" }
    // El enlace prueba que tiene su chat, no quién es: con otro documento no se cambia nada ni se reserva.
    await expect(run((tx) =>
      reservePersonalLink(tx, ORG, sent.token, { ...where, you: { data: {}, name: { ...name, docNumber: "44044244" } } }, { secretsKey: KEY }))).rejects.toMatchObject({ code: "LINK_DATA_INVALID" })
    expect(await ownerDb.select().from(appointment).where(eq(appointment.patientId, created!.id))).toEqual([])

    // Con su documento (escrito con puntos) queda su nombre, el de antes en sus notas, y su sí a novedades.
    await run((tx) =>
      reservePersonalLink(tx, ORG, sent.token, { ...where, you: { data: {}, name: { ...name, docNumber: "44.044.243" }, acceptsPromotions: true } }, { secretsKey: KEY }))
    const [saved] = await selectTestPatients(ownerDb).where(eq(patient.id, created!.id))
    expect(saved).toMatchObject({ displayName: "Darvin Cotrina", givenNames: "Darvin", familyName: "Cotrina", docNumber: "44044243" })
    expect((await run((tx) => listPersonNotes(tx, ORG, dar.contactId))).map((note) => note.body)).toContain(
      "Corrigió su nombre desde su enlace: antes figuraba como Paciente Prueba WhatsApp.",
    )
    const permissions = await ownerDb.select().from(automationConsent).where(eq(automationConsent.contactId, dar.contactId))
    expect(permissions.find((row) => row.purpose === "novedades")).toMatchObject({ status: "granted" })
  })
})

describe("reservar desde un enlace quien recién se contacta", () => {
  it("elige, deja sus datos esenciales y reserva; la ficha la crea el registro y queda señalado lo que falta", async () => {
    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "San Isidro", timezone: "America/Lima" }).returning({ id: branch.id })
    const professional = "dentista-nuevo"
    await ownerDb.insert(user).values([{ id: professional, name: "Dr. Mario Paz", email: "mario.paz@enlace.test", emailVerified: true }])
    await ownerDb.insert(member).values([{ id: `m-${professional}`, userId: professional, organizationId: ORG, role: "clinician", createdAt: new Date() }])
    await run((tx) => createRoom(tx, ORG, { branchId: site!.id, name: "Unidad dental A" }))
    await run((tx) =>
      setProfessionalSchedule(tx, ORG, OWNER, {
        branchId: site!.id,
        professionalUserId: professional,
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
    const choice = { branchId: site!.id, startsAt: chosen.startsAt, professionalUserId: chosen.professionalUserId, ...(chosen.roomId ? { roomId: chosen.roomId } : {}) }
    await expect(run((tx) => reserveBookingLink(tx, ORG, link.token, choice, { secretsKey: KEY }))).rejects.toMatchObject({ code: "BOOKING_NEEDS_REGISTRATION" })
    expect(await ownerDb.select().from(appointment).where(eq(appointment.conversationId, nuevo.conversationId))).toEqual([])

    // La página pide lo esencial con el registro vigente de la clínica. Escribe por Telegram: no se le supone un celular.
    const form = await run((tx) => getBookingLinkRegistrationForm(tx, ORG, link.token))
    expect(form).toMatchObject({ phone: null, config: { version: published.version, privacyNotice: "Tus datos se usan solo para tu atención." } })
    // Lo que ya sabemos viene escrito (aquí, el nombre de su perfil) y nunca respondió lo de promociones.
    expect(form.asksPromotions).toBe(true)
    expect(form.known.from === null || form.known.from === "perfil").toBe(true)
    // Al reservar se pide todo lo que la clínica exige y este paso sabe pedir: aquí, la fecha y el sexo.
    const essentials = {
      demographics: {
        displayName: "Carla Núñez Prado", givenNames: "Carla", familyName: "Núñez Prado", docType: "DNI" as const, docNumber: "45678912",
        phone: "+51987654321", birthDate: "1990-05-14", sex: "F" as const,
      },
      respondent: "patient" as const,
      privacyAccepted: true,
      // Se le dijo que le escribirán por WhatsApp sobre su cita y respondió que sí a promociones.
      acceptsReminders: true,
      acceptsMessages: true,
    }
    const send = (answers: object, formVersion = published.version) =>
      run((tx) => registerFromBookingLink(tx, ORG, link.token, { submissionId: randomUUID(), formVersion, answers: answers as typeof essentials }))
    // Valen las reglas del registro: aviso aceptado, documento válido, versión vigente, y nada fuera de lo esencial.
    await expect(send({ ...essentials, privacyAccepted: false })).rejects.toMatchObject({ status: 400 })
    await expect(send({ ...essentials, demographics: { ...essentials.demographics, docNumber: "123" } })).rejects.toMatchObject({ status: 400 })
    await expect(send({ ...essentials, demographics: { ...essentials.demographics, phone: "" } })).rejects.toMatchObject({ status: 400 })
    await expect(send({ ...essentials, demographics: { ...essentials.demographics, occupation: "Abogada" } })).rejects.toMatchObject({ status: 400 })
    // Sin la fecha de nacimiento o sin lo que la clínica marca obligatorio, no se reserva a medias.
    await expect(send({ ...essentials, demographics: { ...essentials.demographics, birthDate: null } })).rejects.toMatchObject({ status: 400 })
    await expect(send({ ...essentials, demographics: { ...essentials.demographics, sex: null } })).rejects.toMatchObject({ status: 400 })
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
    const [ficha] = await selectTestPatients(ownerDb).where(eq(patient.id, registered.id))
    // Queda con lo esencial y lo demás vacío; los apellidos llegan enteros, sin nada que revisar.
    expect(ficha).toMatchObject({
      displayName: "Carla Núñez Prado", docType: "DNI", docNumber: "45678912", phone: "+51987654321",
      birthDate: "1990-05-14", sex: "F", identityNeedsReview: false,
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
    // La fecha y el sexo se pidieron al reservar: solo queda confirmar su nombre.
    expect(pendingNote).toContain("Faltan datos para atenderla: confirmar apellidos y nombres.")

    // Ya es paciente: el mismo enlace reserva, y no vuelve a pedir datos.
    const after = await run((tx) => getBookingLinkView(tx, ORG, link.token))
    expect(after).toMatchObject({ booking: { needsRegistration: false }, firstName: "Carla", patientFirstName: null })
    await expect(run((tx) => getBookingLinkRegistrationForm(tx, ORG, link.token))).rejects.toMatchObject({ code: "BOOKING_ALREADY_PATIENT" })
    await expect(send(essentials)).rejects.toMatchObject({ code: "BOOKING_ALREADY_PATIENT" })
    const booked = await run((tx) => reserveBookingLink(tx, ORG, link.token, choice, { secretsKey: KEY }))
    expect(booked).toMatchObject({ startsAt: chosen.startsAt, branchName: "San Isidro", professionalName: "Dr. Mario Paz" })
    const rows = await ownerDb.select().from(appointment).where(eq(appointment.patientId, registered.id))
    expect(rows.map((row) => [row.status, row.source])).toEqual([["confirmada", "enlace"]])
    // Quedó guardado lo que se le dijo y lo que respondió: sus recordatorios y promociones, con su origen.
    const permissions = await ownerDb.select().from(automationConsent).where(eq(automationConsent.contactId, nuevo.contactId))
    expect(permissions.map((row) => [row.purpose, row.status, row.source]).sort()).toEqual([
      ["novedades", "granted", "registro"],
      ["recordatorio", "granted", "registro"],
    ])
  })

  it("registrarse por el enlace no pisa lo que ya respondió: quien no quiere ningún mensaje sigue igual", async () => {
    const config = await run((tx) => getPatientRegistrationConfig(tx, ORG))
    const nadie = await person("nadie-enlace")
    // Le dijo en persona a recepción que no quiere ningún mensaje.
    await run((tx) => setMessageChoice(tx, ORG, OWNER, nadie.contactId, { choice: "ninguno", receive: false, source: "presencial" }))
    const link = await run((tx) => createBookingLink(tx, ORG, { conversationId: nadie.conversationId }, { secretsKey: KEY }))
    const answers = {
      demographics: {
        displayName: "Nora Díaz Paz", givenNames: "Nora", familyName: "Díaz Paz", docType: "DNI" as const, docNumber: "40765123",
        phone: "+51987777001", birthDate: "1985-01-20", sex: "F" as const,
      },
      respondent: "patient" as const,
      privacyAccepted: true,
      acceptsReminders: true,
    }
    expect(await run((tx) => registerFromBookingLink(tx, ORG, link.token, { submissionId: randomUUID(), formVersion: config.version, answers }))).toEqual({ registered: true })
    const permissions = await ownerDb.select().from(automationConsent).where(eq(automationConsent.contactId, nadie.contactId))
    expect(permissions.find((row) => row.purpose === "recordatorio")).toMatchObject({ status: "revoked", source: "presencial" })
  })

  it("quien estaba archivada y se registra desde su enlace sale sola del archivo", async () => {
    const config = await run((tx) => getPatientRegistrationConfig(tx, ORG))
    const archivada = await person("archivada-enlace")
    const link = await run((tx) => createBookingLink(tx, ORG, { conversationId: archivada.conversationId }, { secretsKey: KEY }))
    await run((tx) => updateContact(tx, ORG, archivada.contactId, { isActive: false }, { userId: OWNER }))
    const answers = {
      demographics: {
        displayName: "Elsa Ríos Vera", givenNames: "Elsa", familyName: "Ríos Vera", docType: "DNI" as const, docNumber: "40765124",
        phone: "+51987777002", birthDate: "1979-06-11", sex: "F" as const,
      },
      respondent: "patient" as const,
      privacyAccepted: true,
      acceptsReminders: true,
    }
    expect(await run((tx) => registerFromBookingLink(tx, ORG, link.token, { submissionId: randomUUID(), formVersion: config.version, answers }))).toEqual({ registered: true })
    expect((await run((tx) => getContact(tx, ORG, archivada.contactId))).contact).toMatchObject({ isActive: true })
    expect(await run((tx) => listPatientsByContact(tx, ORG, archivada.contactId))).toHaveLength(1)
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
      demographics: { displayName: "Mateo Rojas Lima", givenNames: "Mateo", familyName: "Rojas Lima", docType: "DNI" as const, docNumber: "78123456", birthDate: "2018-03-10", sex: "M" as const },
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

  it("quien ya es paciente pide cita para su hijo nuevo: el enlace para alguien nuevo lo registra a él y no se une a ella", async () => {
    const config = await run((tx) => getPatientRegistrationConfig(tx, ORG))
    const madre = await person("madre-ya-paciente")
    const own = await run((tx) => createBookingLink(tx, ORG, { conversationId: madre.conversationId }, { secretsKey: KEY }))
    const send = (token: string, answers: object) =>
      run((tx) => registerFromBookingLink(tx, ORG, token, { submissionId: randomUUID(), formVersion: config.version, answers: answers as never }))
    await send(own.token, {
      demographics: { displayName: "Inés Paredes Ríos", givenNames: "Inés", familyName: "Paredes Ríos", docType: "DNI", docNumber: "40765127", phone: "+51987777004", birthDate: "1987-02-14", sex: "F" },
      respondent: "patient",
      privacyAccepted: true,
    })
    const [herself] = await run((tx) => listPatientsByContact(tx, ORG, madre.contactId))
    // Su enlace de siempre es el de ella; el de alguien nuevo no se une a su ficha.
    const forChild = await run((tx) => createBookingLink(tx, ORG, { conversationId: madre.conversationId, newPerson: true }, { secretsKey: KEY }))
    expect(forChild).toMatchObject({ needsRegistration: true, forName: null })
    expect((await run((tx) => getBookingLinkRegistrationForm(tx, ORG, forChild.token))).ownRecord).toBe(true)
    expect(await run((tx) => getBookingLinkView(tx, ORG, forChild.token))).toMatchObject({ booking: { needsRegistration: true } })
    // Ella ya tiene su registro: «Para mí» no la registra otra vez.
    await expect(send(forChild.token, {
      demographics: { displayName: "Inés Paredes Ríos", givenNames: "Inés", familyName: "Paredes Ríos", docType: "DNI", docNumber: "40765127", phone: "+51987777004", birthDate: "1987-02-14", sex: "F" },
      respondent: "patient",
      privacyAccepted: true,
    })).rejects.toMatchObject({ code: "ALREADY_REGISTERED" })
    expect(await send(forChild.token, {
      demographics: { displayName: "Tomás Vega Paredes", givenNames: "Tomás", familyName: "Vega Paredes", docType: "DNI", docNumber: "78123457", birthDate: "2019-05-02", sex: "M" },
      respondent: "representative",
      representative: { displayName: "Inés Paredes Ríos", relationship: "guardian", relationshipDetail: "", phone: "+51987777004", docType: "DNI", docNumber: "40765127" },
      privacyAccepted: true,
    })).toEqual({ registered: true })
    const patients = await run((tx) => listPatientsByContact(tx, ORG, madre.contactId))
    const child = patients.find((item) => item.relationship === "guardian")
    expect(child).toMatchObject({ displayName: "Tomás Vega Paredes" })
    const [row] = await ownerDb.select().from(appointmentBookingLink).where(eq(appointmentBookingLink.id, forChild.linkId))
    expect(row).toMatchObject({ patientId: child!.id, newPerson: true })
    // Su propio enlace sigue siendo de ella.
    const [mine] = await ownerDb.select().from(appointmentBookingLink).where(eq(appointmentBookingLink.id, own.linkId))
    expect(mine?.patientId).toBe(herself!.id)
  })

  it("quien se registra queda con el nombre que escribió, aunque ya tuviera otro guardado", async () => {
    const config = await run((tx) => getPatientRegistrationConfig(tx, ORG))
    const quien = await person("renombra-enlace")
    // Antes de registrarse, Sofi (o el equipo) le guardó un nombre: ya no es el del canal.
    await run((tx) =>
      updateContact(tx, ORG, quien.contactId, { givenNames: "Paciente", familyName: "Prueba WhatsApp" }, { userId: null, origin: "agent" }))
    const link = await run((tx) => createBookingLink(tx, ORG, { conversationId: quien.conversationId }, { secretsKey: KEY }))
    const answers = {
      demographics: { displayName: "Darvin Willy Cotrina Cervera", givenNames: "Darvin Willy", familyName: "Cotrina Cervera", docType: "DNI" as const, docNumber: "46781234", phone: "+51987333444", birthDate: "1988-07-21", sex: "M" as const },
      respondent: "patient" as const,
      privacyAccepted: true,
    }
    expect(await run((tx) =>
      registerFromBookingLink(tx, ORG, link.token, { submissionId: randomUUID(), formVersion: config.version, answers }))).toEqual({ registered: true })
    // La Bandeja y su ficha lo nombran como se registró; el nombre de antes queda en sus notas.
    const { contact: after } = await run((tx) => getContact(tx, ORG, quien.contactId))
    expect(after.displayName).toBe("Darvin Willy Cotrina Cervera")
    const [ficha] = await run((tx) => listPatientsByContact(tx, ORG, quien.contactId))
    expect(ficha).toMatchObject({ displayName: "Darvin Willy Cotrina Cervera", relationship: "self" })
    expect((await run((tx) => getBookingLinkView(tx, ORG, link.token)))).toMatchObject({ firstName: "Darvin" })
    expect((await run((tx) => listPersonNotes(tx, ORG, quien.contactId))).map((note) => note.body)).toContain(
      "Se registró como Darvin Willy Cotrina Cervera; antes figuraba como Paciente Prueba WhatsApp.")
  })

  it("con un documento guardado que no es el que escribió, conserva su nombre y lo escrito queda en sus notas", async () => {
    const config = await run((tx) => getPatientRegistrationConfig(tx, ORG))
    const quien = await person("documento-enlace")
    await run((tx) =>
      updateContact(tx, ORG, quien.contactId, { givenNames: "Lucía", familyName: "Paz Soto", docType: "DNI", docNumber: "41239876" }, { userId: OWNER }))
    const link = await run((tx) => createBookingLink(tx, ORG, { conversationId: quien.conversationId }, { secretsKey: KEY }))
    const answers = {
      demographics: { displayName: "Ana Ríos Vega", givenNames: "Ana", familyName: "Ríos Vega", docType: "DNI" as const, docNumber: "47651234", phone: "+51987555666", birthDate: "1992-11-03", sex: "F" as const },
      respondent: "patient" as const,
      privacyAccepted: true,
    }
    expect(await run((tx) =>
      registerFromBookingLink(tx, ORG, link.token, { submissionId: randomUUID(), formVersion: config.version, answers }))).toEqual({ registered: true })
    expect((await run((tx) => getContact(tx, ORG, quien.contactId))).contact).toMatchObject({ displayName: "Lucía Paz Soto", docNumber: "41239876" })
    expect((await run((tx) => listPersonNotes(tx, ORG, quien.contactId))).map((note) => note.body)).toContain(
      "En el registro escribió otros datos, que no se guardaron: documento 47651234, nombre Ana Ríos Vega. Revisa cuáles valen.")
  })

  it("con solo una parte de su nombre: completarla no deja nota, otro nombre sí, y con otro documento no se mezcla", async () => {
    const config = await run((tx) => getPatientRegistrationConfig(tx, ORG))
    const register = async (who: { contactId: string; conversationId: string }, givenNames: string, familyName: string, docNumber: string) => {
      const link = await run((tx) => createBookingLink(tx, ORG, { conversationId: who.conversationId }, { secretsKey: KEY }))
      const demographics = {
        displayName: `${givenNames} ${familyName}`, givenNames, familyName, docType: "DNI" as const, docNumber,
        phone: `+5198755${docNumber.slice(-4)}`, birthDate: "1992-11-03", sex: "F" as const,
      }
      expect(await run((tx) =>
        registerFromBookingLink(tx, ORG, link.token, { submissionId: randomUUID(), formVersion: config.version, answers: { demographics, respondent: "patient" as const, privacyAccepted: true } }))).toEqual({ registered: true })
      const [row] = await ownerDb.select().from(contact).where(eq(contact.id, who.contactId))
      return {
        person: row!,
        notes: (await run((tx) => listPersonNotes(tx, ORG, who.contactId))).map((note) => note.body),
      }
    }
    const agent = { userId: null, origin: "agent" as const }

    const carla = await person("parte-carla")
    // Como lo escribió en el chat: «carla» y «Carla» son el mismo nombre.
    await run((tx) => updateContact(tx, ORG, carla.contactId, { givenNames: "carla" }, agent))
    const completed = await register(carla, "Carla", "Quispe", "47651235")
    expect(completed.person).toMatchObject({ displayName: "Carla Quispe", givenNames: "Carla", familyName: "Quispe" })
    expect(completed.notes.join(" ")).not.toContain("antes figuraba")

    const rojas = await person("parte-rojas")
    await run((tx) => updateContact(tx, ORG, rojas.contactId, { familyName: "Rojas" }, agent))
    const renamed = await register(rojas, "Ana", "Vega", "47651236")
    expect(renamed.person).toMatchObject({ displayName: "Ana Vega", givenNames: "Ana", familyName: "Vega" })
    expect(renamed.notes).toContain("Se registró como Ana Vega; antes figuraba como Rojas.")

    const lucia = await person("parte-lucia")
    await run((tx) =>
      updateContact(tx, ORG, lucia.contactId, { givenNames: "Lucía", docType: "DNI", docNumber: "41239877" }, { userId: OWNER }))
    const kept = await register(lucia, "Ana", "Ríos Vega", "47651237")
    expect(kept.person).toMatchObject({ displayName: "Lucía", givenNames: "Lucía", familyName: null, docNumber: "41239877" })
    expect(kept.notes).toContain(
      "En el registro escribió otros datos, que no se guardaron: documento 47651237, nombre Ana Ríos Vega. Revisa cuáles valen.")

    // Sin nombres separados tampoco: su documento no queda bajo el nombre de otra.
    const perfil = await person("parte-perfil")
    await run((tx) =>
      updateContact(tx, ORG, perfil.contactId, { docType: "DNI", docNumber: "41239878" }, { userId: OWNER }))
    const profileKept = await register(perfil, "Ana", "Ríos Vega", "47651238")
    expect(profileKept.person).toMatchObject({ displayName: "parte-perfil", givenNames: null, familyName: null, docNumber: "41239878" })
  })
})
