import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type Db, type InboundMessageJob, withOrgContext } from "@odentia/db"
import { agentKnowledgeEntry, agentKnowledgeGap, agentLesson } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { createConnection } from "./connections.js"
import { formatOrgMoney } from "./locale.js"
import { type IngestDeps, ingestInbound, sendOutbound } from "./conversations.js"
import {
  answerKnowledgeGaps,
  type ClinicInfoSnapshot,
  createKnowledgeEntry,
  discardKnowledgeGaps,
  formatKnowledgeForPrompt,
  getClinicInfoSnapshot,
  getKnowledgeBasics,
  getKnowledgeDataSources,
  getKnowledgeEntry,
  KNOWLEDGE_BASICS,
  type KnowledgeEntryItem,
  knowledgeFitsPrompt,
  listActiveKnowledge,
  listKnowledgeEntries,
  listKnowledgeGaps,
  listKnowledgePage,
  listKnowledgeRevisions,
  recordKnowledgeGap,
  scoreKnowledgeMatch,
  searchPublishedKnowledge,
  setKnowledgeStatus,
  updateKnowledgeEntry,
} from "./knowledge.js"
import { createPaymentMethod, updatePaymentMethod } from "./payment-methods.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Conocimiento del agente: vigencia, búsqueda, lo básico de una clínica y lo que no supo responder. */
setupTestDb()
const ORG = "org_a"
const OTHER = "org_b"
const OWNER = "know-owner"
const KEY = secretsKeyFromEnv("ab".repeat(32))

beforeAll(async () => {
  await ownerDb.insert(user).values([{ id: OWNER, name: "Dueña", email: "owner@know.test", emailVerified: true }])
  await ownerDb.insert(member).values([
    { id: `m-${OWNER}`, userId: OWNER, organizationId: ORG, role: "owner", createdAt: new Date() },
  ])
})

function run<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return withOrgContext(appDb, ORG, fn)
}

async function publish(input: Parameters<typeof createKnowledgeEntry>[3]): Promise<KnowledgeEntryItem> {
  const created = await run((tx) => createKnowledgeEntry(tx, ORG, OWNER, input))
  return run((tx) => setKnowledgeStatus(tx, ORG, OWNER, created.id, "publicada"))
}

const day = (offset: number): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date(Date.now() + offset * 86_400_000))

const stubAdapter: ChannelAdapter = {
  provider: "telegram_bot_api",
  capabilities: { templates: false, media: true, interactive: false, readReceipts: false, edit: true },
  verifyWebhook: () => true,
  parseWebhook: () => ({ messages: [], statuses: [] }),
  sendMessage: async () => ({ externalId: "stub-1" }),
  validateConnection: async () => ({ externalId: "bot-1", displayName: "Bot" }),
}
const storageStub: Storage = {
  putAvatar: async () => { throw new Error("no usado") },
  deleteByUrl: async () => {},
  putAttachment: async () => { throw new Error("no usado") },
  attachmentUrl: async (key) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => { throw new Error("no usado") },
  putPatientAvatar: async () => { throw new Error("no usado") },
}
const deps: IngestDeps = { storage: storageStub, fetch, secretsKey: KEY }

let connId: string
async function openConversation(sender: string): Promise<string> {
  connId ??= await run((tx) =>
    createConnection(tx, ORG, KEY,
      { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } },
      { fetch, validateExternal: false }).then((c) => c.id))
  const event: NormalizedInbound = {
    externalEventId: `evt-${sender}`, externalMessageId: `evt-${sender}`,
    externalThreadId: `tg:${sender}`, senderExternalId: `tg:${sender}`, senderDisplayName: sender,
    content: { type: "text", text: "Hola" }, sentAt: new Date().toISOString(),
  }
  const job: InboundMessageJob = { orgId: ORG, connectionId: connId, event }
  return (await run((tx) => ingestInbound(tx, job, stubAdapter, deps))).conversationId
}

describe("puntuación de una respuesta frente a una pregunta", () => {
  const entry = {
    title: "¿Qué medios de pago aceptan?",
    body: "Aceptamos efectivo, tarjeta, transferencia, Yape y Plin.",
    askForms: ["¿Puedo pagar con Yape?"],
  }
  it("el título exacto y la forma de preguntar ganan a cualquier parecido", () => {
    expect(scoreKnowledgeMatch("¿qué medios de pago aceptan?", entry)).toBe(1000)
    expect(scoreKnowledgeMatch("puedo pagar con yape", entry)).toBe(900)
  })
  it("encuentra por palabras significativas, sin tildes ni plurales exactos", () => {
    expect(scoreKnowledgeMatch("hola, ¿aceptan tarjetas?", entry)).toBeGreaterThan(0)
    expect(scoreKnowledgeMatch("formas de pago", entry)).toBeGreaterThan(0)
  })
  it("una pregunta de otro tema no coincide", () => {
    expect(scoreKnowledgeMatch("¿atienden a niños pequeños?", entry)).toBe(0)
    expect(scoreKnowledgeMatch("hola, buenas tardes", entry)).toBe(0)
  })
})

it("cada importe se presenta con su moneda", () => {
  expect(formatOrgMoney(15000, "PEN", { locale: "es-PE" })).toMatch(/^S\/\s150\.00$/)
  expect(formatOrgMoney(120000, "CLP", { locale: "es-CL" })).toMatch(/120\.000/)
})

it("solo lo publicado y dentro de su vigencia llega al agente", async () => {
  const always = await publish({ kind: "faq", title: "Vigencia: siempre", body: "Respuesta sin fechas." })
  const expired = await publish({ kind: "faq", title: "Vigencia: promoción de ayer", body: "Promoción vencida.", validUntil: day(-1) })
  const future = await publish({ kind: "faq", title: "Vigencia: campaña futura", body: "Empieza la próxima semana.", validFrom: day(7) })
  const today = await publish({ kind: "faq", title: "Vigencia: solo hoy", body: "Vale hoy.", validFrom: day(0), validUntil: day(0) })
  const draft = await run((tx) => createKnowledgeEntry(tx, ORG, OWNER, { kind: "faq", title: "Vigencia: borrador", body: "Sin publicar." }))
  expect([always.state, expired.state, future.state, today.state, draft.state]).toEqual([
    "vigente", "vencida", "programada", "vigente", "borrador",
  ])
  const active = (await run((tx) => listActiveKnowledge(tx, ORG))).map((entry) => entry.title)
  expect(active).toEqual(expect.arrayContaining(["Vigencia: siempre", "Vigencia: solo hoy"]))
  expect(active).not.toContain("Vigencia: promoción de ayer")
  expect(active).not.toContain("Vigencia: campaña futura")
  expect(active).not.toContain("Vigencia: borrador")
  // La búsqueda del agente tampoco la encuentra, ni por su título exacto.
  expect(await run((tx) => searchPublishedKnowledge(tx, ORG, "Vigencia: promoción de ayer"))).toEqual([])
  // En la administración sigue a la vista, con su estado.
  const listed = await run((tx) => listKnowledgeEntries(tx, ORG, { q: "Vigencia:" }))
  expect(listed.find((entry) => entry.id === expired.id)?.state).toBe("vencida")
  // Ampliar la vigencia la devuelve al agente sin cambiar lo que dice ni su versión.
  const extended = await run((tx) => updateKnowledgeEntry(tx, ORG, OWNER, expired.id, { validUntil: day(3) }))
  expect(extended).toMatchObject({ state: "vigente", version: 1 })
  expect(await run((tx) => listKnowledgeRevisions(tx, ORG, expired.id))).toHaveLength(1)
})

it("valida la vigencia, las formas de preguntar y la clave básica", async () => {
  const base = { kind: "faq", title: "Validación", body: "Texto." }
  await expect(run((tx) => createKnowledgeEntry(tx, ORG, OWNER, { ...base, validFrom: day(2), validUntil: day(1) })))
    .rejects.toMatchObject({ code: "VALIDATION" })
  await expect(run((tx) => createKnowledgeEntry(tx, ORG, OWNER, { ...base, validFrom: "mañana" })))
    .rejects.toMatchObject({ code: "VALIDATION" })
  await expect(run((tx) => createKnowledgeEntry(tx, ORG, OWNER, { ...base, basicKey: "inventada" })))
    .rejects.toMatchObject({ code: "VALIDATION" })
  await expect(run((tx) => createKnowledgeEntry(tx, ORG, OWNER, { ...base, askForms: ["x".repeat(121)] })))
    .rejects.toMatchObject({ code: "VALIDATION" })
  // Repetidas, vacías o iguales al título no se guardan.
  const created = await run((tx) => createKnowledgeEntry(tx, ORG, OWNER, {
    ...base, askForms: ["¿Y los sábados?", "  ¿y los sabados?  ", "", "validación"],
  }))
  expect(created.askForms).toEqual(["¿Y los sábados?"])
  // Cambiar el texto sí versiona.
  const edited = await run((tx) => updateKnowledgeEntry(tx, ORG, OWNER, created.id, { body: "Texto nuevo." }))
  expect(edited.version).toBe(2)
  expect(await run((tx) => listKnowledgeRevisions(tx, ORG, created.id))).toHaveLength(2)
})

it("la búsqueda encuentra por cómo pregunta la gente y pone primero el título exacto", async () => {
  await publish({ kind: "faq", title: "Búsqueda: medios de pago", body: "Aceptamos efectivo, tarjeta y transferencia.", askForms: ["¿Puedo pagar con Yape?"] })
  await publish({ kind: "faq", title: "Búsqueda: atención a menores", body: "Atendemos niños desde los 3 años." })
  const byForm = await run((tx) => searchPublishedKnowledge(tx, ORG, "puedo pagar con yape"))
  expect(byForm[0]?.title).toBe("Búsqueda: medios de pago")
  const byWords = await run((tx) => searchPublishedKnowledge(tx, ORG, "¿atienden a un niño de 5 años?"))
  expect(byWords.map((entry) => entry.title)).toContain("Búsqueda: atención a menores")
  const exact = await run((tx) => searchPublishedKnowledge(tx, ORG, "búsqueda: atención a menores"))
  expect(exact[0]?.title).toBe("Búsqueda: atención a menores")
  expect(await run((tx) => searchPublishedKnowledge(tx, ORG, "estacionamiento para camiones"))).toEqual([])
})

describe("bloque de conocimiento del prompt", () => {
  const snapshot: ClinicInfoSnapshot = {
    clinicName: "Clínica Sonríe",
    timezone: "America/Lima",
    locale: "es-PE",
    paymentMethods: [],
    refusedPaymentMethods: [],
    promotions: [],
    branches: [{ id: "b1", name: "Sede Centro", address: "Av. Larco 123", phone: null, timezone: null }],
  }
  const entry = (n: number, body: string, branchName: string | null = null): KnowledgeEntryItem => ({
    id: `e${n}`, kind: "faq", title: `Tema ${n}`, body, branchId: branchName ? "b1" : null, branchName,
    status: "publicada", state: "vigente", validFrom: null, validUntil: null, askForms: [], basicKey: null,
    version: 1, createdBy: null, createdAt: "", updatedAt: "",
  })

  it("lleva todas las respuestas vigentes, no solo diez, y los servicios solo como los dice «Informar»", () => {
    const entries = Array.from({ length: 25 }, (_, i) => entry(i + 1, `Respuesta breve ${i + 1}.`))
    expect(knowledgeFitsPrompt(entries)).toBe(true)
    const block = formatKnowledgeForPrompt(snapshot, [...entries, { ...entry(99, "No debe salir."), state: "vencida" }], undefined, [
      "Servicios y cómo decir su precio (cada importe con su moneda):",
      "- Limpieza (id s1), 45 min: S/ 150.00",
    ])
    for (let i = 1; i <= 25; i++) expect(block).toContain(`- Tema ${i}: Respuesta breve ${i}.`)
    expect(block).not.toContain("Tema 99")
    expect(block).toContain("- Limpieza (id s1), 45 min: S/ 150.00")
    // No hay otra lista de servicios con su tarifa cruda: sin las líneas de «Informar», ninguno.
    expect(formatKnowledgeForPrompt(snapshot, [])).not.toContain("Servicios")
  })

  it("con «Informar» apagado no habla de medios de pago", () => {
    const withMethods: ClinicInfoSnapshot = { ...snapshot, paymentMethods: [{ id: "m1", name: "Efectivo", typeCode: "10" }] }
    const off = formatKnowledgeForPrompt(withMethods, [], undefined, [], { informs: false })
    expect(off).not.toContain("Efectivo")
    expect(off).not.toContain("medios de pago")
    expect(formatKnowledgeForPrompt(withMethods, [])).toContain("Efectivo")
  })

  it("lleva los medios de pago activos en una sola línea, y que no se registraron si no hay ninguno", () => {
    // Sin medios activos no se afirma ninguno, y se dice que no se registraron.
    expect(formatKnowledgeForPrompt(snapshot, [])).not.toContain("Medios de pago")
    expect(formatKnowledgeForPrompt(snapshot, [])).toContain("La clínica no registró sus medios de pago")
    const withMethods: ClinicInfoSnapshot = {
      ...snapshot,
      paymentMethods: [
        { id: "m1", name: "Efectivo", typeCode: "10" },
        { id: "m2", name: "Tarjeta", typeCode: "48" },
        { id: "m3", name: "Yape", typeCode: "68" },
      ],
    }
    const lines = formatKnowledgeForPrompt(withMethods, []).split("\n")
    expect(lines.filter((line) => line.includes("Medios de pago"))).toEqual([
      "Medios de pago que acepta la clínica (lista completa; ningún otro): Efectivo, Tarjeta, Yape.",
    ])
    // También con el índice: es un dato del sistema, no una respuesta oficial.
    expect(formatKnowledgeForPrompt(withMethods, [entry(1, "Respuesta.")], "indice")).toContain("Efectivo, Tarjeta, Yape.")
    // Lo desactivado se dice como no aceptado, para que no se ofrezca.
    expect(formatKnowledgeForPrompt({ ...withMethods, refusedPaymentMethods: ["Transferencia"] }, [])).toContain(
      "La clínica NO acepta: Transferencia.",
    )
  })

  it("cuando no caben todas va el índice, y una respuesta de sede lo dice", () => {
    const entries = Array.from({ length: 60 }, (_, i) => entry(i + 1, `${"Explicación larga. ".repeat(40)}${i + 1}`))
    entries[0] = entry(1, "Solo en esta sede hay estacionamiento.", "Sede Centro")
    expect(knowledgeFitsPrompt(entries)).toBe(false)
    const block = formatKnowledgeForPrompt(snapshot, entries)
    expect(block).toContain("Índice de las 60 respuestas oficiales")
    expect(block).toContain("- Tema 1 (solo sede Sede Centro) — Solo en esta sede hay estacionamiento.")
    expect(block).toContain("- Tema 60 — Explicación larga.")
    expect(block).not.toContain("(recortada)")
    // El modo lo puede fijar la organización: con modelo de decisión siempre va el índice.
    expect(formatKnowledgeForPrompt(snapshot, entries.slice(0, 3), "indice")).toContain("Índice de las 3 respuestas oficiales")
  })
})

it("lo que solo tú sabes cuenta lo cubierto por respuestas vigentes; lo que está en los datos no se pregunta (ADR 0120)", async () => {
  const before = await run((tx) => getKnowledgeBasics(tx, ORG))
  expect(before.total).toBe(KNOWLEDGE_BASICS.length)
  expect(before.total).toBe(8)
  // Horario, medios de pago o cómo cambiar una cita salen de los datos: no son preguntas que escribir.
  for (const key of ["horario", "medios_pago", "cambiar_cita", "dolor"]) expect(before.items.some((item) => item.key === key)).toBe(false)
  const parking = before.items.find((item) => item.key === "estacionamiento")
  expect(parking).toMatchObject({ covered: false, label: "Estacionamiento", entryId: null })
  const entry = await publish({ kind: "faq", title: "Estacionamiento", body: "Hay cuatro plazas para pacientes.", basicKey: "estacionamiento" })
  const after = await run((tx) => getKnowledgeBasics(tx, ORG))
  expect(after.covered).toBe(before.covered + 1)
  expect(after.items.find((item) => item.key === "estacionamiento")).toMatchObject({ covered: true, entryId: entry.id })
  // Vencida deja de contar.
  await run((tx) => updateKnowledgeEntry(tx, ORG, OWNER, entry.id, { validUntil: day(-1) }))
  expect((await run((tx) => getKnowledgeBasics(tx, ORG))).covered).toBe(before.covered)
  // Una clave que ya no está en la lista no se pone en una respuesta nueva…
  await expect(publish({ kind: "faq", title: "Horario", body: "De 9 a 18.", basicKey: "horario" })).rejects.toMatchObject({ code: "VALIDATION" })
  // …pero la que ya la tenía se sigue editando sin perderla.
  await ownerDb.update(agentKnowledgeEntry).set({ basicKey: "horario" }).where(eq(agentKnowledgeEntry.id, entry.id))
  const edited = await run((tx) => updateKnowledgeEntry(tx, ORG, OWNER, entry.id, { body: "Hay seis plazas.", basicKey: "horario" }))
  expect(edited.basicKey).toBe("horario")
})

it("los medios de pago llegan al agente desde caja, sin escribirlos", async () => {
  const method = await run((tx) => createPaymentMethod(tx, ORG, OWNER, { name: "Transferencia básicos", typeCode: "30" }))
  const snapshot = await run((tx) => getClinicInfoSnapshot(tx, ORG))
  expect(formatKnowledgeForPrompt(snapshot, [])).toContain("Transferencia básicos")
  // Apagado en caja, deja de decirse al agente sin editar ningún texto.
  await run((tx) => updatePaymentMethod(tx, ORG, OWNER, method.id, { isActive: false }))
  const after = await run((tx) => getClinicInfoSnapshot(tx, ORG))
  expect(formatKnowledgeForPrompt(after, [])).not.toContain("Transferencia básicos")
})

it("la lista dice qué respuesta tiene un cambio por aprobar y cuál salió de una corrección", async () => {
  const plain = await publish({ kind: "faq", title: "Wifi para pacientes", body: "Sí, pide la clave en recepción." })
  const changing = await publish({ kind: "faq", title: "Atención a bebés", body: "Desde los tres años." })
  const learned = await publish({ kind: "faq", title: "Sala de espera", body: "Tiene juegos para niños." })
  const lesson = { organizationId: ORG, kind: "respuesta_oficial" as const, scope: "clinica", proposedBy: OWNER }
  const [proposed] = await ownerDb.insert(agentLesson).values([
    { ...lesson, title: "Atención a bebés", body: "Desde el primer diente.", status: "propuesta", knowledgeEntryId: changing.id },
    { ...lesson, title: "Sala de espera", body: "Tiene juegos para niños.", status: "activa", knowledgeEntryId: learned.id, uses: 4 },
    { ...lesson, title: "Sala de espera", body: "Tiene juegos.", status: "activa", knowledgeEntryId: learned.id, uses: 5 },
    // Ni lo descartado ni lo retirado dicen nada de la respuesta.
    { ...lesson, title: "Wifi", body: "No hay.", status: "descartada", knowledgeEntryId: plain.id },
    { ...lesson, title: "Wifi", body: "No hay.", status: "retirada", knowledgeEntryId: plain.id, uses: 2 },
  ]).returning({ id: agentLesson.id })
  const listed = await run((tx) => listKnowledgeEntries(tx, ORG, { limit: 100 }))
  const byId = (id: string) => listed.find((entry) => entry.id === id)
  expect(byId(plain.id)).toMatchObject({ pendingLessonId: null, learned: null })
  expect(byId(changing.id)).toMatchObject({ pendingLessonId: proposed!.id, learned: null })
  expect(byId(learned.id)).toMatchObject({ pendingLessonId: null, learned: { uses: 9 } })
})

it("lo que toma de tus datos cuenta los precios que el agente puede decir y las sedes activas", async () => {
  const before = await run((tx) => getKnowledgeDataSources(tx, ORG))
  await ownerDb.insert(serviceCatalog).values([
    // «Solo con evaluación»: tiene tarifa, pero el agente no la dice; no cuenta como precio.
    { organizationId: ORG, name: "Implante Fuentes", source: "custom", priceCents: 300000, currency: "PEN", priceDisclosure: "evaluacion" },
  ])
  const onlyEvaluation = await run((tx) => getKnowledgeDataSources(tx, ORG))
  expect(onlyEvaluation.pricedServices).toBe(before.pricedServices)
  await ownerDb.insert(serviceCatalog).values([
    { organizationId: ORG, name: "Limpieza Fuentes", source: "custom", priceCents: 9000, currency: "PEN", priceDisclosure: "exacto" },
    { organizationId: ORG, name: "Evaluación Fuentes", source: "custom", priceCents: 0, currency: "PEN" },
    { organizationId: ORG, name: "Retirado Fuentes", source: "custom", priceCents: 5000, currency: "PEN", isActive: false },
  ])
  await ownerDb.insert(branch).values([
    { organizationId: ORG, name: "Sede Fuentes", timezone: "America/Lima" },
    { organizationId: ORG, name: "Sede Cerrada Fuentes", timezone: "America/Lima", isActive: false },
    { organizationId: OTHER, name: "Sede Ajena Fuentes", timezone: "America/Lima" },
  ])
  expect(await run((tx) => getKnowledgeDataSources(tx, ORG))).toEqual({
    pricedServices: before.pricedServices + 1,
    services: before.services + 3,
    branches: before.branches + 1,
  })
})

it("lo que no supo responder se agrupa, muestra lo que respondió el equipo y se cierra con una respuesta oficial", async () => {
  const first = await openConversation("gap-1")
  const second = await openConversation("gap-2")
  const question = "¿Tienen estacionamiento para bicicletas?"
  const one = await run((tx) => recordKnowledgeGap(tx, ORG, { conversationId: first, question, query: "estacionamiento bicicletas" }))
  expect(one).toBeTruthy()
  // La misma pregunta en el mismo hilo no se repite; en otro hilo suma.
  expect(await run((tx) => recordKnowledgeGap(tx, ORG, { conversationId: first, question: "¿tienen estacionamiento para bicicletas?", query: "bicis" }))).toBeNull()
  await run((tx) => recordKnowledgeGap(tx, ORG, { conversationId: second, question, query: "bicicletas" }))
  const other = await run((tx) => recordKnowledgeGap(tx, ORG, { conversationId: second, question: "¿Venden cepillos?", query: "cepillos" }))
  // Una persona del equipo responde después en el primer hilo.
  await run((tx) => sendOutbound(tx, ORG, {
    conversationId: first, senderKind: "user", senderUserId: OWNER,
    content: { type: "text", text: "Sí, hay un bicicletero en la entrada." },
  }))
  const open = await run((tx) => listKnowledgeGaps(tx, ORG))
  const group = open.find((item) => item.question === question)
  expect(group).toMatchObject({ count: 2, weekCount: 2, teamAnswer: "Sí, hay un bicicletero en la entrada.", status: "abierta" })
  // «Esta semana» cuenta solo los últimos siete días; el total sigue contando todo.
  await ownerDb.update(agentKnowledgeGap).set({ createdAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(agentKnowledgeGap.id, one!))
  expect((await run((tx) => listKnowledgeGaps(tx, ORG))).find((item) => item.question === question)).toMatchObject({ count: 2, weekCount: 1 })
  expect(open.find((item) => item.question === "¿Venden cepillos?")).toMatchObject({ count: 1, teamAnswer: null })

  // Guardar como respuesta oficial: queda publicada y recuerda cómo se preguntó.
  const answered = await run((tx) => answerKnowledgeGaps(tx, ORG, OWNER, group!.ids, {
    title: "Estacionamiento para bicicletas", body: "Sí, hay un bicicletero en la entrada.",
  }))
  expect(answered).toMatchObject({ status: "publicada", state: "vigente", askForms: [question] })
  expect((await run((tx) => searchPublishedKnowledge(tx, ORG, "tienen estacionamiento para bicicletas")))[0]?.id).toBe(answered.id)
  expect((await run((tx) => listKnowledgeGaps(tx, ORG))).map((item) => item.question)).not.toContain(question)
  expect((await run((tx) => listKnowledgeGaps(tx, ORG, { status: "resuelta" }))).find((item) => item.question === question)?.count).toBe(2)
  // Ya cerradas no se cierran dos veces.
  await expect(run((tx) => answerKnowledgeGaps(tx, ORG, OWNER, group!.ids, { entryId: answered.id }))).rejects.toMatchObject({ code: "NOT_FOUND" })

  // Enlazar a una respuesta que ya existía suma la forma de preguntar; descartar no crea nada.
  const third = await openConversation("gap-3")
  const again = await run((tx) => recordKnowledgeGap(tx, ORG, { conversationId: third, question: "¿Dónde dejo mi bici?", query: "bici" }))
  const linked = await run((tx) => answerKnowledgeGaps(tx, ORG, OWNER, [again!], { entryId: answered.id }))
  expect(linked.askForms).toEqual([question, "¿Dónde dejo mi bici?"])
  expect(linked.version).toBe(1)
  await run((tx) => discardKnowledgeGaps(tx, ORG, OWNER, [other!]))
  expect((await run((tx) => listKnowledgeGaps(tx, ORG))).map((item) => item.question)).not.toContain("¿Venden cepillos?")
  const [discarded] = await run((tx) => tx.select().from(agentKnowledgeGap).where(eq(agentKnowledgeGap.id, other!)))
  expect(discarded).toMatchObject({ status: "descartada", resolvedBy: OWNER, resolvedEntryId: null })

  // Aislado por organización y sin borrado.
  expect([...(await withOrgContext(appDb, OTHER, (tx) => tx.execute(sql`select id from agent_knowledge_gap`)))]).toEqual([])
  await expect(run((tx) => tx.delete(agentKnowledgeGap).where(eq(agentKnowledgeGap.id, other!)))).rejects.toThrow()
  await expect(withOrgContext(appDb, OTHER, (tx) => getKnowledgeEntry(tx, OTHER, answered.id))).rejects.toMatchObject({ code: "NOT_FOUND" })
  expect((await run((tx) => tx.select({ id: agentKnowledgeEntry.id }).from(agentKnowledgeEntry).where(eq(agentKnowledgeEntry.id, answered.id)))).length).toBe(1)
})

it("Conocimiento pagina: la respuesta 101 también se abre, y la búsqueda va al servidor", async () => {
  const orgId = `pagina-${Date.now()}`
  await insertOrg(ownerDb, orgId, orgId)
  await ownerDb.insert(agentKnowledgeEntry).values(
    Array.from({ length: 105 }, (_, index) => ({
      organizationId: orgId, kind: "faq", title: `Pregunta ${index}`, body: index === 3 ? "Hay estacionamiento." : "Respuesta.",
      status: "publicada", createdBy: OWNER, updatedAt: new Date(Date.now() - index * 60_000),
    })),
  )
  const page = (input: Parameters<typeof listKnowledgePage>[2]) => withOrgContext(appDb, orgId, (tx) => listKnowledgePage(tx, orgId, input))
  const first = await page({ limit: 100 })
  expect(first.items).toHaveLength(100)
  expect(first.total).toBe(105)
  expect(first.nextCursor).not.toBeNull()
  const second = await page({ limit: 100, cursor: first.nextCursor! })
  expect(second.items.map((entry) => entry.title)).toEqual(["Pregunta 100", "Pregunta 101", "Pregunta 102", "Pregunta 103", "Pregunta 104"])
  expect(second.nextCursor).toBeNull()
  // Ninguna se repite ni se pierde entre páginas.
  expect(new Set([...first.items, ...second.items].map((entry) => entry.id)).size).toBe(105)
  const found = await page({ q: "estacionamiento" })
  expect(found).toMatchObject({ total: 1, nextCursor: null })
  expect(found.items.map((entry) => entry.title)).toEqual(["Pregunta 3"])
  await expect(page({ cursor: "roto" })).rejects.toMatchObject({ code: "VALIDATION" })
})
