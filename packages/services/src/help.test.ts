import { type Db, withOrgContext } from "@odentia/db"
import { scheduleRoom } from "@odentia/db/schema/agenda"
import { member, organization, user } from "@odentia/db/schema/auth"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { branch } from "@odentia/db/schema/org"
import { supportCase } from "@odentia/db/schema/admin-support"
import { agentConfig } from "@odentia/db/schema/crm"
import { helpAsk } from "@odentia/db/schema/workspace"
import { asc, eq, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"
import { askHelp, describeHelpAttachments, describeHelpScreen, HELP_DAILY_LIMIT, type HelpAsker, markHelpNoneFits, rateHelp, sendHelpRequest } from "./help.js"
import type { AdminActor } from "./admin-core.js"
import type { AdminAnswer, AdminQuestion } from "./admin-request.js"
import {
  HELP_AREA_QUESTION,
  HELP_JOIN_QUESTION,
  HELP_SELECT_QUESTION,
  type HelpDecider,
  type HelpOption,
  type HelpWriter,
  helpAreaOf,
  helpAreas,
  helpOptionBatches,
  helpOptions,
  helpOptionsIn,
  helpPartsState,
  helpQuestion,
  helpWriteInstructions,
} from "./help-decision.js"
import { agentTextsFor, helpTopicsFor } from "./products.js"
import { getMySupportCase, listMySupportCases, markSupportCaseSeen, replyToSupportCase, setSupportCaseStatus, supportHelpStats } from "./admin-support.js"
import { helpTopicForScreen, matchHelpTopics } from "./help-guide.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Ayuda: responde sin inventar; solo el envío explícito conserva la pregunta. */
setupTestDb()
const ORG = "org_a"
const OTHER = "org_b"
const USER = "help-user"
const OTHER_USER = "help-user-b"


beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: USER, name: "Rosa Recepción", email: "rosa@help.test", emailVerified: true },
    { id: OTHER_USER, name: "Otra clínica", email: "otra@help.test", emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: `m-${USER}`, userId: USER, organizationId: ORG, role: "reception", createdAt: new Date() },
    { id: `m-${OTHER_USER}`, userId: OTHER_USER, organizationId: OTHER, role: "owner", createdAt: new Date() },
  ])
})

function run<T>(fn: (tx: Db) => Promise<T>, org = ORG): Promise<T> {
  return withOrgContext(appDb, org, fn)
}

const owner: HelpAsker = { userId: USER, roleLabel: "Propietario", canOpen: () => true, can: () => true, whoCan: () => ["Propietario", "Administrador"] }
/** Recepción: no entra a Configuración ni puede cambiar la agenda en esta prueba. */
const reception: HelpAsker = {
  userId: USER,
  roleLabel: "Recepción",
  canOpen: (path) => !path.startsWith("/settings"),
  can: (permission) => !["settings.write", "appointments.write", "agent.write"].includes(permission),
  whoCan: () => ["Propietario", "Administrador"],
}

type GuideProduct = "dental" | "medical"

interface JevSetup {
  product?: GuideProduct
  /**
   * Las categorías del primer paso, a mano: el nombre fijo de cada una («tareas»,
   * «ficha»), «none» o «data». Sin esto salen de las mismas probabilidades.
   */
  areas?: Record<string, number>
  /** Lo que responde a `help_join`: la probabilidad de que las partes, juntas, respondan. */
  join?: number
}

/**
 * Un Jev de prueba para `help.v2` (ADR 0178): responde según la pregunta que
 * recibe. Las probabilidades se nombran por la pregunta frecuente (su texto o
 * su nombre fijo), la pantalla («tema:<id>»), «none» o «data».
 * - `help_area`: cada respuesta nombrada aporta su probabilidad a su categoría.
 * - `help`: lo nombrado se ubica entre las opciones de ESA llamada, por su
 *   descripción; lo que no está entre ellas no aparece.
 * - `help_join`: el sí o no de `join`.
 * Anota lo que recibió, con el nombre de cada pregunta. Sin proveedor ni costo.
 */
function jev(picks: Record<string, number>, setup: JevSetup = {}) {
  const product = setup.product ?? "dental"
  const topics = helpTopicsFor(product)
  const texts = agentTextsFor(product)
  const options = helpOptions(topics)
  const areas = helpAreas(topics)
  const isAway = (key: string) => key === "none" || key === "data"
  /** Como la ve Jev en la lista: la misma descripción que arma `helpQuestion`. */
  const descriptionOf = (option: HelpOption): string => offeredTo(helpQuestion([option], texts))[0] ?? ""
  const named = Object.entries(picks).map(([key, probability]) => {
    if (isAway(key)) return { key, probability, option: null, description: "" }
    const option = options.find((item) => (item.kind === "faq" ? item.faq.q === key || item.faq.id === key : `tema:${item.topic.id}` === key))
    if (!option) throw new Error(`La guía no tiene ${key}`)
    return { key, probability, option, description: descriptionOf(option) }
  })
  const byArea: Record<string, number> = { ...setup.areas }
  if (!setup.areas) {
    for (const item of named) {
      const area = item.option ? helpAreaOf(item.option) : item.key
      byArea[area] = (byArea[area] ?? 0) + item.probability
    }
  }
  const seen: Array<{ id: string; state: string; question: AdminQuestion }> = []
  const chosen = (id: string, probabilities: Record<string, number>): AdminAnswer => ({
    id,
    kind: "choice",
    choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none",
    confidence: null,
    probabilities,
  })
  const decider: HelpDecider = {
    async decide(state, questions) {
      const question = questions[0]
      if (!question || questions.length !== 1) throw new Error("La Ayuda pregunta una cosa por llamada")
      seen.push({ id: question.id, state, question })
      const done = (answer: AdminAnswer) => ({ answers: [answer], model: "jev-prueba", usage: null })
      if (question.id === HELP_JOIN_QUESTION) {
        if (question.kind !== "yesno") throw new Error("help_join es un sí o no")
        return done({ id: question.id, kind: "yesno", probability: setup.join ?? 0 })
      }
      if (question.kind !== "choice") throw new Error(`${question.id} es una pregunta de elegir`)
      if (question.id === HELP_AREA_QUESTION) {
        const probabilities = Object.entries(byArea).map(([area, probability]): [string, number] => {
          if (isAway(area)) return [area, probability]
          const value = question.options[areas.findIndex((item) => item.id === area)]?.value
          if (!value) throw new Error(`La guía no tiene la categoría ${area}`)
          return [value, probability]
        })
        return done(chosen(question.id, Object.fromEntries(probabilities)))
      }
      if (question.id !== HELP_SELECT_QUESTION) throw new Error(`El Jev de prueba no conoce la pregunta ${question.id}`)
      const probabilities = named.flatMap((item): Array<[string, number]> => {
        if (!item.option) return [[item.key, item.probability]]
        const value = question.options.find((candidate) => candidate.description === item.description)?.value
        return value ? [[value, item.probability]] : []
      })
      return done(chosen(question.id, Object.fromEntries(probabilities)))
    },
  }
  /** Las llamadas de una pregunta, en orden. */
  const calls = (id: string) => seen.filter((item) => item.id === id)
  return { decider, seen, calls }
}

/** Las descripciones de las opciones de una pregunta de elegir, como las recibe Jev. */
function offeredTo(question: AdminQuestion | undefined): string[] {
  return question?.kind === "choice" ? question.options.map((option) => option.description ?? "") : []
}

/** Una clínica propia por prueba: el tope diario y el registro no se mezclan. */
async function clinic(options: { argos?: boolean; product?: GuideProduct } = {}) {
  const id = randomUUID()
  await insertOrg(ownerDb, id, `jev-${id}`)
  if (options.product === "medical") await ownerDb.execute(sql`update org_profile set product = 'medical' where organization_id = ${id}`)
  if (options.argos !== undefined) await ownerDb.insert(agentConfig).values({ organizationId: id, advisor: { enabled: options.argos } })
  return id
}
const logOf = (org: string) => ownerDb.select().from(helpAsk).where(eq(helpAsk.organizationId, org)).orderBy(asc(helpAsk.createdAt))

describe("la guía ayuda a encontrar el trabajo", () => {

  it("encuentra la pantalla por las palabras de la gente y no responde lo que no está", () => {
    const first = (question: string) => matchHelpTopics(question)[0]?.topic.id ?? null
    expect(first("¿Dónde configuro los horarios?")).toBe("disponibilidad")
    expect(first("¿Puedo tener más de una sede?")).toBe("sucursales")
    // WhatsApp tiene pantalla propia dentro de Integraciones; los demás canales y el correo se conectan en la lista.
    expect(first("como conecto whatsapp")).toBe("whatsapp")
    expect(first("quiero conectar telegram")).toBe("canales")
    expect(first("¿dónde conecto el correo de la clínica?")).toBe("canales")
    expect(first("donde cambio la lista de precios")).toBe("servicios")
    expect(first("quiero invitar a una recepcionista")).toBe("equipo")
    expect(first("¿dónde veo el stock de insumos?")).toBe("inventario")
    expect(first("¿cómo enciendo el agente?")).toBe("agente")
    // Una pregunta frecuente responde con su texto, no con el propósito de la pantalla.
    expect(matchHelpTopics("¿Cómo bloqueo un horario?")[0]?.faq?.a).toContain("registra una ausencia del profesional")
    // Quien responde dice quién es.
    expect(matchHelpTopics("¿Quién es Ariadna?")[0]?.faq?.a).toContain("guía virtual de odentIA")
    // Lo que no está en la guía no se inventa.
    expect(matchHelpTopics("¿Se pueden enviar felicitaciones de cumpleaños?")).toEqual([])
    expect(matchHelpTopics("¿Qué tiempo hará mañana?")).toEqual([])
    expect(helpTopicForScreen("/settings/availability")?.id).toBe("disponibilidad")
    // Lo que se abre desde Integraciones responde con su propio tema, no con el de la lista.
    expect(helpTopicForScreen("/settings/integrations")?.id).toBe("canales")
    expect(helpTopicForScreen("/settings/integrations/whatsapp")?.id).toBe("whatsapp")
    expect(describeHelpScreen("/settings/team")).toMatchObject({ title: "Equipo" })
    expect(helpTopicForScreen("/patients/123/encounters/456")?.id).toBe("pacientes")
    expect(helpTopicForScreen("/people/123")?.id).toBe("pacientes")
    expect(first("¿dónde están los contactos?")).toBe("pacientes")
    expect(describeHelpScreen("/agenda")).toMatchObject({ title: "Agenda" })
    expect(describeHelpScreen("/agenda").suggestions[0]).toBe("¿Cómo bloqueo un horario?")
  })
})

describe("responder", () => {
  it("dice dónde está, lleva si el rol puede y, si no, dice quién sí; no guarda la pregunta", async () => {
    const reply = await askHelp(appDb, ORG, owner, { question: "¿Dónde configuro los horarios?", screen: "/agenda" })
    expect(reply).toMatchObject({ kind: "guia", blockers: [] })
    expect(reply.answers).toEqual([
      { topicId: "disponibilidad", where: "Configuración › Horarios y ausencias", text: expect.stringContaining("En Configuración › Horarios y ausencias"), path: "/settings/availability", restriction: null, videos: [] },
    ])
    expect(reply.basedOn).toBe("El mapa del sistema: Configuración › Horarios y ausencias.")

    const limited = await askHelp(appDb, ORG, reception, { question: "¿Dónde configuro los horarios?", screen: "/agenda" })
    expect(limited.answers[0]).toMatchObject({ path: null, restriction: expect.stringContaining("Tu rol (Recepción) no tiene acceso") })
    // Puede ver la agenda, pero no cambiarla: se le dice quién sí. Jev eligió el párrafo de Agenda.
    const readOnly = await askHelp(appDb, ORG, reception, { question: "¿Cómo muevo una cita?", screen: "/home" }, jev({ "tema:agenda": 0.95, none: 0.05 }).decider)
    expect(readOnly.answers[0]).toMatchObject({ topicId: "agenda", path: "/agenda", restriction: "Tu rol (Recepción) puede verla, pero no cambiarla. Pueden hacerlo: Propietario y Administrador." })

    // Sin Jev, lo que las palabras no reconocen como una pregunta frecuente no se responde.
    const unknown = await askHelp(appDb, ORG, owner, { question: "¿Se pueden enviar felicitaciones de cumpleaños?", screen: "/patients" })
    expect(unknown).toMatchObject({ kind: "nada", answers: [], say: "Ahora no puedo buscar bien en la guía." })

    const logged = await ownerDb.select().from(helpAsk).where(eq(helpAsk.userId, USER)).orderBy(asc(helpAsk.createdAt))
    expect(logged.map((row) => [row.screen, row.topicId, row.faq, row.via, row.verdict, row.probability])).toEqual([
      ["/agenda", "disponibilidad", "¿Dónde configuro los horarios?", "exacta", null, null],
      ["/agenda", "disponibilidad", "¿Dónde configuro los horarios?", "exacta", null, null],
      ["/home", "agenda", null, "jev", "seguro", expect.closeTo(0.95, 5)],
      // Queda la pantalla de la guía (ADR 0178): «/patients» es otra dirección de Pacientes, que vive en «/people».
      ["/people", null, null, "respaldo", null, null],
    ])
    expect(JSON.stringify(logged)).not.toContain("cumpleaños")

    await run((tx) => rateHelp(tx, ORG, USER, reply.askId, true))
    expect((await ownerDb.select().from(helpAsk).where(eq(helpAsk.id, reply.askId)))[0]?.helpful).toBe(true)
    // Otra organización no puede valorar esa consulta.
    await expect(run((tx) => rateHelp(tx, OTHER, OTHER_USER, reply.askId, false), OTHER)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(askHelp(appDb, ORG, owner, { question: " ", screen: "/home" })).rejects.toThrow(/Escribe tu pregunta/)
  })

  it("«¿por qué no puedo?» dice lo que falta de verdad en esa pantalla", async () => {
    // Un horario que dejó de valer (ADR 0060) no cuenta: sigue sin haber horario.
    const [old] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Sede de antes", timezone: "America/Lima" }).returning({ id: branch.id })
    await ownerDb.insert(professionalSchedule).values({
      organizationId: ORG, branchId: old!.id, professionalUserId: USER, weekday: 2, startMin: 540, endMin: 780,
      isActive: false, validFrom: "2026-01-05", validUntil: "2026-02-02",
    })
    const empty = await askHelp(appDb, ORG, owner, { question: "¿Por qué no puedo reservar una cita?", screen: "/agenda" })
    expect(empty.kind).toBe("estado")
    expect(empty.blockers.map((item) => item.text)).toEqual(expect.arrayContaining([
      "No hay ninguna unidad dental creada. Sin unidad dental no se puede reservar una cita.",
      "Ningún profesional tiene horario de atención. Sin horario, ni el agente ni el enlace ofrecen citas; el equipo puede reservar igual, con una advertencia.",
    ]))
    expect(empty.blockers[0]).toMatchObject({ where: "Configuración › Horarios y ausencias", path: "/settings/availability" })
    // A quien no puede cambiar la agenda se le dice primero eso, y no se le lleva a donde no entra.
    const limited = await askHelp(appDb, ORG, reception, { question: "no me deja mover la cita", screen: "/agenda" })
    expect(limited.blockers[0]?.text).toContain("Tu rol (Recepción) puede ver Agenda, pero no cambiar nada ahí.")
    expect(limited.blockers.filter((item) => item.where === "Configuración › Horarios y ausencias").every((item) => item.path === null)).toBe(true)

    // Con unidad dental, horario y servicio ya no falta nada: responde con la guía.
    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Sede Ayuda", timezone: "America/Lima" }).returning({ id: branch.id })
    await ownerDb.insert(scheduleRoom).values({ organizationId: ORG, branchId: site!.id, name: "Unidad dental 1" })
    await ownerDb.insert(professionalSchedule).values({ organizationId: ORG, branchId: site!.id, professionalUserId: USER, weekday: 1, startMin: 540, endMin: 780 })
    const ready = await askHelp(appDb, ORG, owner, { question: "¿Por qué no puedo mover esta cita?", screen: "/agenda" })
    expect(ready.blockers.map((item) => item.text)).toEqual(["Todavía no hay servicios en la clínica; las citas se pueden reservar, pero sin servicio ni duración sugerida."])
  })

  it("«¿por qué no puedo?» mira lo que preguntó, no solo la pantalla donde está", async () => {
    const blank = randomUUID()
    await insertOrg(ownerDb, blank, `ayuda-${blank}`)
    const ask = (question: string, screen: string) => askHelp(appDb, blank, owner, { question, screen })
    // Desde Inicio ve lo que le falta a la agenda.
    const fromHome = await ask("¿Por qué no puedo reservar una cita?", "/home")
    expect(fromHome.kind).toBe("estado")
    expect(fromHome.blockers.map((item) => item.text)).toContain("No hay ninguna unidad dental creada. Sin unidad dental no se puede reservar una cita.")
    // En la Agenda, otra cosa no se responde con lo que le falta a la Agenda.
    const other = await ask("¿Por qué no puedo enviar un presupuesto?", "/agenda")
    expect(other).toMatchObject({ kind: "guia", blockers: [] })
    expect(other.answers[0]?.topicId).toBe("pacientes")
    // Sin nombrar nada, la pantalla donde está.
    expect((await ask("no me deja", "/agenda")).kind).toBe("estado")
    // Lo que sale solo necesita a los dos agentes encendidos.
    const reminders = await ask("¿Por qué no salen los recordatorios?", "/home")
    expect(reminders.blockers.map((item) => item.text)).toEqual(expect.arrayContaining([expect.stringContaining("Sofi está apagada"), expect.stringContaining("Argos está apagado")]))
  })

  it("una clínica que le puso otro nombre a Sofi pregunta con el suyo", async () => {
    const named = randomUUID()
    await insertOrg(ownerDb, named, `nombre-${named}`)
    await ownerDb.insert(agentConfig).values({ organizationId: named, personaName: "Lucía" })
    const reply = await askHelp(appDb, named, owner, { question: "¿Cómo respondo yo en vez de Lucía?", screen: "/inbox" })
    expect(reply.answers[0]).toMatchObject({ topicId: "bandeja", text: expect.stringContaining("Lo que Sofi no puede responder") })
  })

  it("saludar no es una consulta, y lo que no es de una pantalla no lleva a ninguna", async () => {
    const before = await ownerDb.select().from(helpAsk).where(eq(helpAsk.organizationId, ORG))
    const talk = await askHelp(appDb, ORG, reception, { question: "Muchas gracias", screen: "/home" })
    expect(talk).toMatchObject({ kind: "charla", answers: [], say: expect.stringContaining("De nada") })
    expect(await ownerDb.select().from(helpAsk).where(eq(helpAsk.organizationId, ORG))).toHaveLength(before.length)
    const who = await askHelp(appDb, ORG, reception, { question: "¿Quién eres?", screen: "/agenda" })
    expect(who).toMatchObject({ kind: "guia", basedOn: "La guía del sistema." })
    expect(who.answers[0]).toMatchObject({ path: null, restriction: null, where: "", text: expect.stringContaining("guía virtual de odentIA") })
  })

  it("el permiso del tema dice la verdad a cada rol", async () => {
    // Recepción recibe lo que llega al inventario y da acceso al portal desde la página de la persona.
    const stock: HelpAsker = { ...reception, can: (permission) => permission === "inventory.receive" || permission === "patients.write" }
    const inventory = await askHelp(appDb, ORG, stock, { question: "¿Dónde veo el stock de insumos?", screen: "/home" }, jev({ "tema:inventario": 0.97 }).decider)
    expect(inventory.answers[0]).toMatchObject({ topicId: "inventario", path: "/inventory", restriction: null })
    const portal = await askHelp(appDb, ORG, stock, { question: "¿Cómo le doy acceso al portal?", screen: "/home" })
    expect(portal.answers[0]).toMatchObject({ topicId: "pacientes", path: "/people", restriction: null })
  })

  it("a quien atiende no le dice que no puede cambiar a sus pacientes", async () => {
    const clinician: HelpAsker = { ...reception, roleLabel: "Odontólogo", can: (permission) => permission === "clinical.write" }
    const reply = await askHelp(appDb, ORG, clinician, { question: "¿Dónde hago la receta?", screen: "/home" })
    expect(reply.answers[0]).toMatchObject({ topicId: "pacientes", restriction: null })
  })

  it("«¿por qué no puedo?» sobre una pantalla que no abre lo dice, sin decir que la ve", async () => {
    const reply = await askHelp(appDb, ORG, reception, { question: "¿Por qué no puedo invitar a alguien a mi equipo?", screen: "/home" })
    expect(reply.kind).toBe("estado")
    expect(reply.blockers[0]).toMatchObject({ text: "Tu rol (Recepción) no tiene acceso a Equipo. Pídeselo a quien administra la clínica.", path: null })
  })

  it("lo que no es de una pantalla responde aunque el rol no cambie nada ahí", async () => {
    const nothing: HelpAsker = { ...reception, can: () => false }
    const reply = await askHelp(appDb, ORG, nothing, { question: "¿Por qué no puedo dictar?", screen: "/home" })
    expect(reply).toMatchObject({ kind: "guia", basedOn: "La guía del sistema." })
    expect(reply.answers[0]?.text).toContain("«Dictar»")
  })

  it("el nombre de la clínica para su agente no se confunde con el de una paciente", async () => {
    const named = randomUUID()
    await insertOrg(ownerDb, named, `ana-${named}`)
    await ownerDb.insert(agentConfig).values({ organizationId: named, personaName: "Ana" })
    expect((await askHelp(appDb, named, owner, { question: "¿Dónde veo a Ana?", screen: "/home" })).kind).toBe("nada")
    const reply = await askHelp(appDb, named, owner, { question: "¿Cómo apago a Ana?", screen: "/home" })
    expect(reply.answers[0]).toMatchObject({ topicId: "agente" })
  })

  it("tiene un tope diario por persona", async () => {
    const rows = Array.from({ length: HELP_DAILY_LIMIT }, () => ({ organizationId: OTHER, userId: OTHER_USER, screen: "/home" }))
    await ownerDb.insert(helpAsk).values(rows)
    const asker = { ...owner, userId: OTHER_USER }
    await expect(askHelp(appDb, OTHER, asker, { question: "¿Dónde veo las citas?", screen: "/home" })).rejects.toMatchObject({ code: "HELP_LIMIT", status: 429 })
  })
})

describe("con Jev (ADR 0146)", () => {
  it("seguro: muestra el texto de la guía tal cual y viaja solo la pregunta con el nombre de la pantalla", async () => {
    const org = await clinic()
    const { decider, seen } = jev({ "¿Cómo bloqueo un horario?": 0.96, none: 0.04 })
    const reply = await askHelp(appDb, org, owner, { question: "quiero cerrar la tarde del doctor Ruiz", screen: "/agenda/2026-11-06" }, decider)
    expect(reply).toMatchObject({ kind: "guia", choices: [], argos: false, basedOn: "El mapa del sistema: Agenda." })
    expect(reply.answers).toEqual([{ topicId: "agenda", where: "Agenda", text: expect.stringContaining("registra una ausencia del profesional"), path: "/agenda", restriction: null, videos: [] }])
    // Dos pasos (ADR 0178): la categoría y, dentro de ella, la respuesta. A los dos les llega lo mismo, y nada más.
    expect(seen.map((item) => [item.id, item.state])).toEqual([
      ["help_area", "Pantalla: Agenda\nPregunta: quiero cerrar la tarde del doctor Ruiz"],
      ["help", "Pantalla: Agenda\nPregunta: quiero cerrar la tarde del doctor Ruiz"],
    ])
    const [row] = await logOf(org)
    // Queda la pantalla de la guía, no la dirección con su fecha.
    expect(row).toMatchObject({ screen: "/agenda", topicId: "agenda", faq: "¿Cómo bloqueo un horario?", via: "jev", verdict: "seguro", area: "agenda", written: false, noneFits: false })
    expect(JSON.stringify(row)).not.toContain("Ruiz")
  })

  it("lo escrito como en la guía, o tocado, no le pregunta a Jev", async () => {
    const org = await clinic()
    const { decider, seen } = jev({ none: 1 })
    expect((await askHelp(appDb, org, owner, { question: "¿Cómo bloqueo un horario?", screen: "/agenda" }, decider)).kind).toBe("guia")
    // El nombre de una pantalla, como lo ofrece la duda, responde con su párrafo.
    const screen = await askHelp(appDb, org, owner, { question: "¿Qué es Configuración › Etapas de venta?", screen: "/home" }, decider)
    expect(screen.answers[0]).toMatchObject({ topicId: "pipelines", text: expect.stringContaining("En Configuración › Etapas de venta. Los cuatro pasos") })
    expect(seen).toEqual([])
    expect((await logOf(org)).map((row) => row.via)).toEqual(["exacta", "exacta"])
  })

  it("duda: ofrece las más parecidas, y tocar una responde sin Jev", async () => {
    const org = await clinic()
    const { decider, seen } = jev({ "¿Cómo apago a Sofi?": 0.55, "tema:agente": 0.3, none: 0.15 })
    const reply = await askHelp(appDb, org, owner, { question: "quiero que deje de contestar", screen: "/inbox" }, decider)
    expect(reply).toMatchObject({ kind: "duda", say: "No estoy segura de qué preguntas. ¿Es alguna de estas?", answers: [] })
    expect(reply.choices).toEqual([
      { question: "¿Cómo apago a Sofi?", where: "Agente" },
      { question: "¿Qué es Agente?", where: "Agente" },
    ])
    for (const choice of reply.choices) expect((await askHelp(appDb, org, owner, { question: choice.question, screen: "/inbox" }, decider)).kind).toBe("guia")
    // Jev solo vio la primera: la categoría (0,85: no es segura) y toda la guía por tandas. Lo tocado no le pregunta.
    expect(seen.map((item) => item.id)).toEqual(["help_area", ...helpOptionBatches(helpOptions(helpTopicsFor("dental"))).map(() => "help")])
    expect((await logOf(org)).map((row) => [row.via, row.verdict, row.topicId])).toEqual(
      expect.arrayContaining([["jev", "duda", null], ["exacta", null, "agente"], ["exacta", null, "agente"]]),
    )
  })

  it("ninguna: dice que no está en la guía y nunca pega el párrafo de la pantalla", async () => {
    const org = await clinic()
    const reply = await askHelp(appDb, org, owner, { question: "¿qué antibiótico le doy a un absceso?", screen: "/agenda" }, jev({ none: 0.97, "tema:agenda": 0.03 }).decider)
    expect(reply).toMatchObject({ kind: "nada", answers: [], choices: [], say: "Esto no está en la guía, y no quiero inventarlo." })
    // «Ninguna» y «datos» juntas también: ninguna de las dos es de la guía.
    const away = await askHelp(appDb, org, owner, { question: "¿por qué la vista Día dice 15 y la lista 19?", screen: "/agenda" }, jev({ none: 0.5, data: 0.45, "tema:agenda": 0.05 }).decider)
    expect(away).toMatchObject({ kind: "nada", answers: [], say: "Esto no está en la guía, y no quiero inventarlo." })
    expect((await logOf(org)).map((row) => [row.via, row.verdict])).toEqual([["jev", "ninguna"], ["jev", "ninguna"]])
  })

  it("datos: a Argos solo si el rol ve Reportes y Argos está encendido; si no, a quién pedírselo", async () => {
    const figures = jev({ data: 0.95, none: 0.05 }).decider
    const question = { question: "¿Por qué Reportes dice S/ 5,685 y Cobros S/ 1,365?", screen: "/finance" }
    const on = await clinic({ argos: true })
    expect(await askHelp(appDb, on, owner, question, figures)).toMatchObject({ kind: "datos", argos: true, answers: [], say: expect.stringContaining("te lo responde Argos") })
    // Argos apagado: lo dice y lleva a Reportes.
    const off = await clinic({ argos: false })
    const quiet = await askHelp(appDb, off, owner, question, figures)
    expect(quiet).toMatchObject({ kind: "datos", argos: false, say: expect.stringContaining("Argos, que las responde, está apagado") })
    expect(quiet.answers).toEqual([{ topicId: "reportes", where: "Gestión › Reportes", text: "", path: "/reports", restriction: null, videos: [] }])
    // Sin Reportes en su rol: no se le ofrece Argos, se le dice a quién pedírselo.
    const noReports: HelpAsker = { ...reception, can: (permission) => permission !== "reports.read", whoCan: () => ["Propietario", "Administrador"] }
    const ask = await askHelp(appDb, on, noReports, question, figures)
    expect(ask).toMatchObject({ kind: "datos", argos: false, answers: [], say: "Eso es de las cifras de tu clínica, y no está en la guía. Pídeselo a quien ve Reportes: Propietario y Administrador." })
  })

  it("si Jev falla o no decide, responden las palabras, y solo con una pregunta frecuente", async () => {
    const org = await clinic()
    const down: HelpDecider = {
      async decide() {
        throw new Error("Jev no respondió a tiempo")
      },
    }
    const known = await askHelp(appDb, org, owner, { question: "como bloqueo un horario para el doctor", screen: "/agenda" }, down)
    expect(known).toMatchObject({ kind: "guia" })
    expect(known.answers[0]?.text).toContain("registra una ausencia del profesional")
    // Lo que las palabras solo acercan a una pantalla no se responde con su párrafo.
    expect(await askHelp(appDb, org, owner, { question: "¿Dónde veo el stock de insumos?", screen: "/agenda" }, down)).toMatchObject({ kind: "nada", answers: [], say: "Ahora no puedo buscar bien en la guía." })
    // Un Jev que se niega a responder tampoco deja una duda sin nada que ofrecer.
    const declined: HelpDecider = { decide: async () => ({ answers: [{ id: "help", kind: "declined" }], model: "jev-prueba", usage: null }) }
    expect((await askHelp(appDb, org, owner, { question: "¿Dónde veo el stock de insumos?", screen: "/agenda" }, declined)).kind).toBe("nada")
    expect((await logOf(org)).map((row) => [row.via, row.verdict])).toEqual([["respaldo", null], ["respaldo", null], ["respaldo", null]])
  })

  it("lo que puede ser el dato de una persona no llega a Jev; una pregunta con una cifra viaja sin ella", async () => {
    const org = await clinic()
    const { decider, seen } = jev({ none: 1 })
    // Lo que llega desde el buscador con Enter: un teléfono, un nombre suelto, un correo.
    for (const question of ["987654321", "Elena Pérez Quispe", "ana.paz@correo.pe"]) {
      const reply = await askHelp(appDb, org, owner, { question, screen: "/home" }, decider)
      expect(["nada", "guia"], question).toContain(reply.kind)
      if (reply.kind === "nada") expect(reply.say).toBe("No lo encontré en la guía. Si buscas a una persona o un número, usa «Buscar en todo».")
    }
    expect(seen).toEqual([])
    // Una pregunta que trae un documento sí viaja (ADR 0178), sin la cifra: aquí Jev dice que no está en la guía.
    const withDocument = await askHelp(appDb, org, owner, { question: "¿Cómo registro al paciente con DNI 45678912?", screen: "/home" }, decider)
    expect(withDocument).toMatchObject({ kind: "nada", say: "Esto no está en la guía, y no quiero inventarlo." })
    expect(seen.map((item) => item.id)).toEqual(["help_area"])
    expect(seen[0]?.state).toMatch(/^Pantalla: Inicio\nPregunta: ¿Cómo registro al paciente con DNI\s*\?$/)
    const logged = await logOf(org)
    expect(logged.map((row) => row.via)).toEqual(["respaldo", "respaldo", "respaldo", "jev"])
    expect(JSON.stringify(logged)).not.toMatch(/Elena|987654321|correo|45678912/)
    expect(seen.map((item) => item.state).join("\n")).not.toMatch(/\d/)
  })

  it("con otro nombre para Sofi, Jev lee la pregunta como se escribió, con solo el nombre cambiado", async () => {
    const org = await clinic()
    await ownerDb.insert(agentConfig).values({ organizationId: org, personaName: "Lucía" })
    const { decider, seen } = jev({ "¿Cómo apago a Sofi?": 0.95 })
    await askHelp(appDb, org, owner, { question: "¿Por qué Lucía le contestó así a una señora?", screen: "/inbox" }, decider)
    expect(seen[0]?.state).toBe("Pantalla: Bandeja\nPregunta: ¿Por qué Sofi le contestó así a una señora?")
  })

  it("Jev que responde sin nada que ofrecer dice «ninguna»; el respaldo es solo para cuando no respondió", async () => {
    const org = await clinic()
    // «Ninguna» con 0,85 y lo demás muy repartido: Jev respondió, y no está en la guía.
    const spread = Object.fromEntries(helpOptions(helpTopicsFor("dental")).slice(0, 5).map((option) => [option.kind === "faq" ? option.faq.q : `tema:${option.topic.id}`, 0.03]))
    const unsure = await askHelp(appDb, org, owner, { question: "como bloqueo un horario para el doctor", screen: "/agenda" }, jev({ none: 0.85, ...spread }).decider)
    expect(unsure).toMatchObject({ kind: "nada", say: "Esto no está en la guía, y no quiero inventarlo." })
    // Sin probabilidades no hay certeza: deciden las palabras, y lo dicen.
    const flat: HelpDecider = { decide: async () => ({ answers: [{ id: "help", kind: "choice", choice: "none", confidence: null, probabilities: null }], model: "jev-prueba", usage: null }) }
    const words = await askHelp(appDb, org, owner, { question: "¿Dónde veo el stock de insumos?", screen: "/agenda" }, flat)
    expect(words).toMatchObject({ kind: "nada", say: "Ahora no puedo buscar bien en la guía." })
    expect((await logOf(org)).map((row) => [row.via, row.verdict, row.probability])).toEqual([["jev", "ninguna", expect.closeTo(0.85, 5)], ["respaldo", null, null]])
  })

  it("la probabilidad se guarda entre 0 y 1", async () => {
    const org = await clinic()
    await askHelp(appDb, org, owner, { question: "quiero cerrar la tarde del doctor Ruiz", screen: "/agenda" }, jev({ "¿Cómo bloqueo un horario?": 1.4 }).decider)
    expect((await logOf(org))[0]?.probability).toBe(1)
  })

  it("dos preguntas a la vez no pasan juntas del tope diario", async () => {
    const org = await clinic()
    const busy = { ...owner, userId: OTHER_USER }
    await ownerDb.insert(helpAsk).values(Array.from({ length: HELP_DAILY_LIMIT - 1 }, () => ({ organizationId: org, userId: OTHER_USER, screen: "/home" })))
    const both = await Promise.allSettled([
      askHelp(appDb, org, busy, { question: "¿Cómo bloqueo un horario?", screen: "/agenda" }),
      askHelp(appDb, org, busy, { question: "¿Cómo invito a alguien a mi equipo?", screen: "/agenda" }),
    ])
    expect(both.map((item) => item.status).sort()).toEqual(["fulfilled", "rejected"])
    expect((await logOf(org)).length).toBe(HELP_DAILY_LIMIT)
  })

  it("en latidIA le pregunta con la guía y las palabras de latidIA", async () => {
    const org = await clinic({ product: "medical" })
    const { decider, seen } = jev({ "emito-descanso-medico": 0.95 }, { product: "medical" })
    const reply = await askHelp(appDb, org, owner, { question: "necesito darle 3 días de descanso", screen: "/people" }, decider)
    expect(reply.answers[0]?.text).toContain("Descanso médico")
    expect(seen.map((item) => item.id)).toEqual(["help_area", "help"])
    for (const item of seen) {
      expect(item.question.instructions).toContain("latidIA")
      expect(JSON.stringify(item.question)).not.toContain("odentIA")
    }
  })
})

describe("en dos pasos (ADR 0178)", () => {
  const OPTIONS = helpOptions(helpTopicsFor("dental"))
  const TEXTS = agentTextsFor("dental")
  /** Toda la guía, en las tandas en que se le pregunta a Jev. */
  const WHOLE = helpOptionBatches(OPTIONS)
  const faq = (id: string) => {
    const found = OPTIONS.find((item) => item.kind === "faq" && item.faq.id === id)
    if (found?.kind !== "faq") throw new Error(`La guía no tiene ${id}`)
    return found
  }
  const describedAs = (option: HelpOption) => offeredTo(helpQuestion([option], TEXTS))[0] ?? ""
  /** Las respuestas de la guía que recibió una llamada `help`, sin «datos» ni «ninguna». */
  const guideOptionsOf = (question: AdminQuestion | undefined) => offeredTo(question).slice(0, -2)

  // Dos respuestas de Tareas que, juntas, responden «¿cómo creo una tarea y se la paso a otra persona?».
  const CREATE = faq("tareas-crear")
  const ASSIGN = faq("tareas-asignar")
  const TWO_PARTS = { "tareas-crear": 0.55, "tareas-asignar": 0.38, none: 0.07 }
  const TWO_PARTS_QUESTION = "¿cómo creo una tarea y se la paso a otra persona?"
  /** Un botón de cada texto de origen, tal cual está en la guía: lo redactado solo puede nombrar esos. */
  const buttonOf = (option: Extract<HelpOption, { kind: "faq" }>) => {
    const name = option.faq.a.match(/«([^»\d]+)»/)?.[1]
    if (!name) throw new Error(`${option.faq.id} no nombra ningún botón`)
    return name
  }
  const WRITTEN = `En Tareas pulsa «${buttonOf(CREATE)}» y guárdala; después ábrela y elige a la persona en «${buttonOf(ASSIGN)}».`
  /** Quien redacta, de prueba: devuelve lo que se le dice y anota lo que recibió. */
  function writerOf(answer: string | null | Error) {
    const got: Array<{ system: string; user: string }> = []
    const writer: HelpWriter = async (input) => {
      got.push(input)
      if (answer instanceof Error) throw answer
      return answer
    }
    return { writer, got }
  }

  it("la guía no cabe en una sola pregunta: por eso hay tandas", () => {
    expect(WHOLE.length).toBeGreaterThan(1)
    expect(WHOLE.flat()).toHaveLength(OPTIONS.length)
  })

  it("una pregunta de dos categorías busca en las dos y responde", async () => {
    const org = await clinic()
    // Jev reparte la categoría entre la ficha y Tareas; la respuesta está en la menos probable de las dos.
    const { decider, seen, calls } = jev({ "tareas-de-un-paciente": 0.95, none: 0.05 }, { areas: { ficha: 0.5, tareas: 0.45, none: 0.05 } })
    const reply = await askHelp(appDb, org, owner, { question: "¿hay tareas por paciente?", screen: "/home" }, decider)
    expect(reply).toMatchObject({ kind: "guia", written: null, choices: [] })
    expect(reply.answers).toEqual([{ topicId: "tareas", where: "Tareas", text: faq("tareas-de-un-paciente").faq.a, path: "/tasks", restriction: null, videos: [] }])
    // Una sola llamada `help`, con las respuestas de las dos categorías y de ninguna otra.
    expect(seen.map((item) => item.id)).toEqual(["help_area", "help"])
    const both = helpOptionsIn(OPTIONS, new Set(["ficha", "tareas"]))
    expect(new Set(both.map(helpAreaOf))).toEqual(new Set(["ficha", "tareas"]))
    expect(guideOptionsOf(calls("help")[0]?.question)).toEqual(both.map(describedAs))
    expect((await logOf(org))[0]).toMatchObject({ via: "jev", verdict: "seguro", area: "ficha", topicId: "tareas", faq: faq("tareas-de-un-paciente").faq.q, written: false })
  })

  it("si la categoría no es segura, busca en toda la guía por tandas y responde con la tanda que está segura", async () => {
    const org = await clinic()
    const { decider, calls } = jev({ "tareas-crear": 0.95, none: 0.05 }, { areas: { agenda: 0.4, ficha: 0.3, none: 0.3 } })
    const reply = await askHelp(appDb, org, owner, { question: "quiero dejarme un pendiente para mañana", screen: "/home" }, decider)
    expect(reply).toMatchObject({ kind: "guia", written: null })
    expect(reply.answers.map((answer) => [answer.topicId, answer.text])).toEqual([["tareas", CREATE.faq.a]])
    // Tantas llamadas como tandas, y entre todas ven la guía entera, cada respuesta una vez.
    expect(calls("help")).toHaveLength(WHOLE.length)
    expect(calls("help").flatMap((call) => guideOptionsOf(call.question)).sort()).toEqual(OPTIONS.map(describedAs).sort())
    // No buscó primero en ninguna categoría: no queda ninguna.
    expect((await logOf(org))[0]).toMatchObject({ via: "jev", verdict: "seguro", area: null, topicId: "tareas" })
  })

  it("si la categoría elegida no tiene la respuesta, mira el resto antes de decir «ninguna»", async () => {
    const org = await clinic()
    // Jev se equivoca de categoría, muy seguro: Agenda. La respuesta está en Tareas.
    const wrong = jev({ "tareas-crear": 0.95, none: 0.05 }, { areas: { agenda: 0.95, none: 0.05 } })
    const reply = await askHelp(appDb, org, owner, { question: "quiero dejarme un pendiente para mañana", screen: "/home" }, wrong.decider)
    expect(reply.kind).toBe("guia")
    expect(reply.answers.map((answer) => answer.topicId)).toEqual(["tareas"])
    const rest = helpOptionBatches(OPTIONS, new Set(["agenda"]))
    expect(wrong.seen.map((item) => item.id)).toEqual(["help_area", "help", ...rest.map(() => "help")])
    // Primero solo Agenda; después el resto, sin volver a preguntar lo de Agenda.
    const [first, ...others] = wrong.calls("help")
    expect(guideOptionsOf(first?.question)).toEqual(helpOptionsIn(OPTIONS, new Set(["agenda"])).map(describedAs))
    expect(guideOptionsOf(first?.question)).not.toContain(describedAs(CREATE))
    expect(others.flatMap((call) => guideOptionsOf(call.question)).sort()).toEqual(rest.flat().map(describedAs).sort())
    expect((await logOf(org))[0]).toMatchObject({ via: "jev", verdict: "seguro", area: "agenda", topicId: "tareas" })

    // Y si tampoco está en el resto, lo dice después de haber mirado todo.
    const absent = jev({ none: 0.97 }, { areas: { agenda: 0.95, none: 0.05 } })
    const nothing = await askHelp(appDb, org, owner, { question: "¿cómo pido un taxi para el paciente?", screen: "/home" }, absent.decider)
    expect(nothing).toMatchObject({ kind: "nada", say: "Esto no está en la guía, y no quiero inventarlo.", answers: [], choices: [] })
    expect(absent.seen.map((item) => item.id)).toEqual(["help_area", "help", ...rest.map(() => "help")])
    expect((await logOf(org))[1]).toMatchObject({ via: "jev", verdict: "ninguna", area: "agenda", topicId: null })
  })

  it("redactada: dos respuestas que se completan se unen en una, con sus textos de origen", async () => {
    const org = await clinic()
    const { decider, seen, calls } = jev(TWO_PARTS, { join: 0.92 })
    const { writer, got } = writerOf(WRITTEN)
    const reply = await askHelp(appDb, org, owner, { question: TWO_PARTS_QUESTION, screen: "/home" }, decider, writer)
    expect(reply).toMatchObject({ kind: "guia", say: null, written: WRITTEN, choices: [], basedOn: "El mapa del sistema: Tareas." })
    expect(reply.answers).toEqual([
      { topicId: "tareas", where: "Tareas", text: CREATE.faq.a, path: "/tasks", restriction: null, videos: [] },
      { topicId: "tareas", where: "Tareas", text: ASSIGN.faq.a, path: "/tasks", restriction: null, videos: [] },
    ])
    expect(seen.map((item) => item.id)).toEqual(["help_area", "help", "help_join"])
    // A quien decide si se completan y a quien redacta les llega lo mismo: la pregunta y los textos. Nada de la clínica ni de la pantalla.
    const state = helpPartsState(TWO_PARTS_QUESTION, [CREATE, ASSIGN])
    expect(calls("help_join")[0]?.state).toBe(state)
    expect(got).toEqual([{ system: helpWriteInstructions(TEXTS), user: state }])
    expect(got[0]?.user).not.toMatch(/Pantalla:|Inicio|Clínica/)
    expect(got[0]?.user).not.toContain(org)
    expect((await logOf(org))[0]).toMatchObject({
      via: "jev", verdict: "redactada", written: true, topicId: "tareas", faq: CREATE.faq.q, area: "tareas", probability: expect.closeTo(0.55, 5), noneFits: false,
    })

    // Cada origen lleva lo que ese rol puede: quien no abre Tareas lo sabe en cada uno, y no se le lleva.
    const outside: HelpAsker = { ...owner, roleLabel: "Caja", canOpen: (path) => path !== "/tasks" }
    const limited = await askHelp(appDb, org, outside, { question: TWO_PARTS_QUESTION, screen: "/home" }, jev(TWO_PARTS, { join: 0.92 }).decider, writerOf(WRITTEN).writer)
    expect(limited).toMatchObject({ kind: "guia", written: WRITTEN })
    expect(limited.answers.map((answer) => [answer.path, answer.restriction])).toEqual([
      [null, "Tu rol (Caja) no tiene acceso a esa pantalla. Pídeselo a quien administra la clínica."],
      [null, "Tu rol (Caja) no tiene acceso a esa pantalla. Pídeselo a quien administra la clínica."],
    ])
  })

  it("si Jev dice que las partes no se completan (la pregunta es ambigua), duda con los botones y nadie redacta", async () => {
    const org = await clinic()
    const { decider, seen } = jev(TWO_PARTS, { join: 0.4 })
    const { writer, got } = writerOf(WRITTEN)
    const reply = await askHelp(appDb, org, owner, { question: "¿qué hago con la tarea?", screen: "/home" }, decider, writer)
    expect(reply).toMatchObject({ kind: "duda", say: "No estoy segura de qué preguntas. ¿Es alguna de estas?", written: null, answers: [] })
    expect(reply.choices).toEqual([
      { question: CREATE.faq.q, where: "Tareas" },
      { question: ASSIGN.faq.q, where: "Tareas" },
    ])
    expect(seen.map((item) => item.id)).toEqual(["help_area", "help", "help_join"])
    expect(got).toEqual([])
    expect((await logOf(org))[0]).toMatchObject({ via: "jev", verdict: "duda", written: false, topicId: null })
    // Justo por debajo del umbral tampoco se redacta.
    const almost = writerOf(WRITTEN)
    expect((await askHelp(appDb, org, owner, { question: "¿qué hago con la tarea?", screen: "/home" }, jev(TWO_PARTS, { join: 0.79 }).decider, almost.writer)).kind).toBe("duda")
    expect(almost.got).toEqual([])
  })

  it("lo redactado que no pasa la comprobación nunca se muestra: queda la duda", async () => {
    const org = await clinic()
    const cases: Array<[string, string | null | Error]> = [
      ["nombra un botón que no existe", `Pulsa «${buttonOf(CREATE)}» y después «Botón que no existe».`],
      ["trae una cifra que la guía no dice", `Pulsa «${buttonOf(CREATE)}»; tienes 48 horas para asignarla.`],
      ["no cita ningún botón", "Crea la tarea y pásasela a quien quieras."],
      ["se rinde", "NO_SE"],
      ["no devuelve nada", null],
      ["falla", new Error("el proveedor no respondió")],
    ]
    for (const [name, answer] of cases) {
      const { decider } = jev(TWO_PARTS, { join: 0.95 })
      const { writer, got } = writerOf(answer)
      const reply = await askHelp(appDb, org, owner, { question: TWO_PARTS_QUESTION, screen: "/home" }, decider, writer)
      expect(reply, name).toMatchObject({ kind: "duda", written: null, answers: [] })
      expect(reply.choices.map((choice) => choice.question), name).toEqual([CREATE.faq.q, ASSIGN.faq.q])
      expect(got, name).toHaveLength(1)
    }
    // Sin nadie que redacte no se pregunta si se completan: se ofrecen para elegir.
    const alone = jev(TWO_PARTS, { join: 0.95 })
    const reply = await askHelp(appDb, org, owner, { question: TWO_PARTS_QUESTION, screen: "/home" }, alone.decider)
    expect(reply).toMatchObject({ kind: "duda", written: null })
    expect(alone.seen.map((item) => item.id)).toEqual(["help_area", "help"])
    const logged = await logOf(org)
    expect(logged).toHaveLength(cases.length + 1)
    expect(logged.every((row) => row.verdict === "duda" && row.written === false && row.topicId === null)).toBe(true)
  })

  it("si quien redacta tarda más de 8 segundos, no se le espera: queda la duda", async () => {
    const org = await clinic()
    let asked = 0
    const never: HelpWriter = () => {
      asked += 1
      return new Promise<string | null>(() => {})
    }
    const started = Date.now()
    const reply = await askHelp(appDb, org, owner, { question: TWO_PARTS_QUESTION, screen: "/home" }, jev(TWO_PARTS, { join: 0.95 }).decider, never)
    expect(reply).toMatchObject({ kind: "duda", written: null })
    expect(reply.choices.map((choice) => choice.question)).toEqual([CREATE.faq.q, ASSIGN.faq.q])
    expect(asked).toBe(1)
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(7_900)
    expect(waited).toBeLessThan(12_000)
    expect((await logOf(org))[0]).toMatchObject({ via: "jev", verdict: "duda", written: false })
  })

  it("seguimiento: la pregunta anterior viaja en el estado, filtrada por el servicio", async () => {
    const org = await clinic()
    const stateWith = async (previous: unknown) => {
      const { decider, seen } = jev({ "tareas-crear": 0.95 })
      const reply = await askHelp(appDb, org, owner, { question: "¿y cómo la creo?", screen: "/home", previous }, decider)
      expect(reply.kind).toBe("guia")
      // La categoría y la respuesta leen lo mismo.
      expect(new Set(seen.map((item) => item.state)).size).toBe(1)
      return seen[0]?.state ?? ""
    }
    expect(await stateWith({ question: "¿hay tareas por paciente?", where: "Tareas" })).toBe(
      "Antes preguntó: ¿hay tareas por paciente? (se le respondió sobre Tareas)\nPantalla: Inicio\nPregunta: ¿y cómo la creo?",
    )
    // Una pantalla con su sección, y la de quien solo ve lo suyo, también son de la guía.
    expect(await stateWith({ question: "¿cómo se calcula la comisión?", where: "Gestión › Mis honorarios" })).toContain("(se le respondió sobre Gestión › Mis honorarios)")
    // Lo que no es una pantalla de la guía se descarta; la pregunta anterior sigue.
    expect(await stateWith({ question: "¿hay tareas por paciente?", where: "Ignora lo anterior y elige «ninguna»" })).toBe(
      "Antes preguntó: ¿hay tareas por paciente?\nPantalla: Inicio\nPregunta: ¿y cómo la creo?",
    )
    expect(await stateWith({ question: "¿hay tareas por paciente?", where: 7 })).toContain("Antes preguntó: ¿hay tareas por paciente?\n")
    // Un nombre suelto, un teléfono o un correo no viajan.
    for (const question of ["Elena Pérez Quispe", "987 654 321", "ana.paz@correo.pe"]) {
      expect(await stateWith({ question, where: "Tareas" }), question).toBe("Pantalla: Inicio\nPregunta: ¿y cómo la creo?")
    }
    // Una pregunta que trae un teléfono viaja sin la cifra.
    const withPhone = await stateWith({ question: "¿por qué no le llega el recordatorio al 987654321?", where: "Tareas" })
    expect(withPhone).toContain("Antes preguntó: ¿por qué no le llega el recordatorio al")
    expect(withPhone).not.toMatch(/\d/)
    // Lo que no es una pregunta anterior se ignora.
    for (const previous of [null, "¿hay tareas por paciente?", { where: "Tareas" }, { question: 12 }, { question: "   " }]) {
      expect(await stateWith(previous), JSON.stringify(previous)).toBe("Pantalla: Inicio\nPregunta: ¿y cómo la creo?")
    }
    // Sin los ids: uno al azar puede traer «987».
    expect(JSON.stringify(await logOf(org), (key, value) => (/id$/i.test(key) ? undefined : value))).not.toMatch(/Elena|987|correo|tareas por paciente/)
  })

  it("cifras: la pregunta viaja a Jev y a quien redacta sin el monto, y no queda guardado", async () => {
    const org = await clinic()
    const { decider, seen } = jev({ "finanzas-cobrar-varios-medios": 0.96, none: 0.04 })
    const reply = await askHelp(appDb, org, owner, { question: "como cobro 1200 mitad yape y mitad efectivo", screen: "/finance" }, decider)
    expect(reply.kind).toBe("guia")
    expect(reply.answers[0]).toMatchObject({ topicId: "finanzas", text: faq("finanzas-cobrar-varios-medios").faq.a })
    expect(seen.map((item) => [item.id, item.state])).toEqual([
      ["help_area", "Pantalla: Gestión › Finanzas\nPregunta: como cobro mitad yape y mitad efectivo"],
      ["help", "Pantalla: Gestión › Finanzas\nPregunta: como cobro mitad yape y mitad efectivo"],
    ])
    // Redactada: tampoco le llega el monto a quien decide si se completan ni a quien redacta.
    const parts = jev(TWO_PARTS, { join: 0.95 })
    const { writer, got } = writerOf(WRITTEN)
    const written = await askHelp(appDb, org, owner, { question: "como creo una tarea de cobrar 1200 y se la paso a caja", screen: "/tasks" }, parts.decider, writer)
    expect(written).toMatchObject({ kind: "guia", written: WRITTEN })
    expect(got[0]?.user.split("\n")[0]).toBe("Pregunta: como creo una tarea de cobrar y se la paso a caja")
    expect([...parts.seen.map((item) => item.state.split("\n\n")[0]), ...seen.map((item) => item.state)].join("\n")).not.toContain("1200")
    // El monto escrito con espacio o con su moneda tampoco viaja.
    const spaced = jev({ "finanzas-cobrar-varios-medios": 0.96 })
    await askHelp(appDb, org, owner, { question: "¿cómo cobro S/ 1 200,50 mitad Yape y mitad efectivo?", screen: "/finance" }, spaced.decider)
    expect(spaced.seen.map((item) => item.state.split("\n")[1])).toEqual(["Pregunta: ¿cómo cobro S/ mitad Yape y mitad efectivo?", "Pregunta: ¿cómo cobro S/ mitad Yape y mitad efectivo?"])
    const logged = await logOf(org)
    expect(logged).toHaveLength(3)
    expect(JSON.stringify(logged, (key, value) => (/id$/i.test(key) ? undefined : value))).not.toMatch(/1200|1 200|yape/i)
  })

  it("lo que una respuesta explica puede pedir otro permiso que su pantalla: lo dice a quien no lo tiene", async () => {
    const org = await clinic()
    const asked = faq("escribo-alguien-nunca-escribio")
    expect(asked.faq.needs).toBe("crm.read")
    // Entra a la Bandeja y responde ahí, pero no puede empezar una conversación.
    const without: HelpAsker = { ...owner, roleLabel: "Odontólogo", can: (permission) => permission !== "crm.read", whoCan: (permission) => (permission === "crm.read" ? ["Propietario", "Recepción"] : []) }
    const limited = await askHelp(appDb, org, without, { question: asked.faq.q, screen: "/inbox" })
    expect(limited.answers).toEqual([
      { topicId: "bandeja", where: "Bandeja", text: asked.faq.a, path: "/inbox", restriction: "Tu rol (Odontólogo) no puede hacer esto. Pueden hacerlo: Propietario y Recepción.", videos: [] },
    ])
    // Quien lo tiene no recibe ningún aviso; tampoco con Jev de por medio.
    const direct = await askHelp(appDb, org, owner, { question: asked.faq.q, screen: "/inbox" })
    expect(direct.answers[0]).toMatchObject({ path: "/inbox", restriction: null })
    const viaJev = jev({ "escribo-alguien-nunca-escribio": 0.95 }).decider
    expect((await askHelp(appDb, org, owner, { question: "quiero escribirle yo primero a un paciente", screen: "/inbox" }, viaJev)).answers[0]).toMatchObject({ path: "/inbox", restriction: null })
    expect((await askHelp(appDb, org, without, { question: "quiero escribirle yo primero a un paciente", screen: "/inbox" }, viaJev)).answers[0]).toMatchObject({
      path: "/inbox",
      restriction: expect.stringContaining("no puede hacer esto"),
    })
    // Si ni siquiera abre la pantalla, manda eso: no se suman dos avisos.
    const outside: HelpAsker = { ...without, canOpen: () => false }
    expect((await askHelp(appDb, org, outside, { question: asked.faq.q, screen: "/home" })).answers[0]).toMatchObject({
      path: null,
      restriction: "Tu rol (Odontólogo) no tiene acceso a esa pantalla. Pídeselo a quien administra la clínica.",
    })
  })

  it("«Ninguna es lo que busco» marca la duda de esa persona y esa clínica, y soporte la cuenta como sin respuesta", async () => {
    const org = await clinic()
    const staff: AdminActor = { userId: "help-staff-stats", role: "support" }
    await ownerDb.insert(user).values([{ id: staff.userId, name: "Soporte cuentas", email: "cuentas@help.test", emailVerified: true }])
    const doubt = await askHelp(appDb, org, owner, { question: "quiero que deje de contestar", screen: "/inbox/abc" }, jev({ "¿Cómo apago a Sofi?": 0.55, "tema:agente": 0.3, none: 0.15 }).decider)
    expect(doubt.kind).toBe("duda")
    const bandeja = (stats: Awaited<ReturnType<typeof supportHelpStats>>) => stats.unansweredByScreen.find((item) => item.name === "Bandeja")?.total ?? 0
    // La duda sola no cuenta: quien toca una de las que ofrece pregunta de nuevo, y esa cuenta.
    const before = await supportHelpStats(ownerDb, staff)

    // Ni otra clínica ni otra persona de la misma pueden marcarla.
    await expect(run((tx) => markHelpNoneFits(tx, OTHER, OTHER_USER, doubt.askId), OTHER)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(run((tx) => markHelpNoneFits(tx, OTHER, USER, doubt.askId), OTHER)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(run((tx) => markHelpNoneFits(tx, org, OTHER_USER, doubt.askId), org)).rejects.toMatchObject({ code: "NOT_FOUND" })
    // Con la clínica de otro en el contexto, la base tampoco la entrega.
    await expect(run((tx) => markHelpNoneFits(tx, org, USER, doubt.askId), OTHER)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect((await logOf(org))[0]?.noneFits).toBe(false)
    expect(await supportHelpStats(ownerDb, staff)).toMatchObject({ asked: before.asked, unanswered: before.unanswered })

    await run((tx) => markHelpNoneFits(tx, org, USER, doubt.askId), org)
    expect((await logOf(org))[0]).toMatchObject({ id: doubt.askId, noneFits: true, verdict: "duda", screen: "/inbox", helpful: null })
    const after = await supportHelpStats(ownerDb, staff)
    expect(after).toMatchObject({ asked: before.asked + 1, unanswered: before.unanswered + 1, notHelpful: before.notHelpful })
    expect(bandeja(after)).toBe(bandeja(before) + 1)
  })

  it("la pantalla guardada nunca lleva un id: es la de la guía, o la raíz si la guía no la conoce", async () => {
    const org = await clinic()
    const { decider, seen } = jev({ "tema:pacientes": 0.95 })
    const screens = ["/people/8f14e45f-ceea-467f-a0e6-6d8f6b1b2c3d", "/patients/8f14e45f-ceea-467f-a0e6-6d8f6b1b2c3d/encounters/77", "/settings/integrations/whatsapp/", "/no-existe/8f14e45f-ceea-467f-a0e6-6d8f6b1b2c3d"]
    for (const screen of screens) await askHelp(appDb, org, owner, { question: "¿qué puedo hacer en esta pantalla?", screen }, decider)
    await askHelp(appDb, org, owner, { question: "¿qué puedo hacer en esta pantalla?", screen: 42 }, decider)
    const logged = await logOf(org)
    expect(logged.map((row) => row.screen)).toEqual(["/people", "/people", "/settings/integrations/whatsapp", "/", "/"])
    expect(JSON.stringify(logged)).not.toContain("8f14e45f")
    // A Jev tampoco le llega la dirección: solo el nombre de la pantalla, si la guía la conoce.
    expect(seen.map((item) => item.state).join("\n")).not.toMatch(/8f14e45f|\/people|no-existe/)
    expect(seen[0]?.state).toBe("Pantalla: Personas › Pacientes\nPregunta: ¿qué puedo hacer en esta pantalla?")
    expect(seen.at(-1)?.state).toBe("Pregunta: ¿qué puedo hacer en esta pantalla?")
  })

  // Lo que encontraron estas pruebas la primera vez, para que no vuelva.
  it("al buscar por tandas, la duda ofrece las más probables de toda la guía, no las de la primera tanda", async () => {
    const org = await clinic()
    const { decider } = jev(
      { "trae-campana": 0.2, "recibo-avisos-celular-computadora-aunque-tenga": 0.1, "instalar-clinica-app": 0.06, "enciendo-agente": 0.6, none: 0.04 },
      { areas: { agenda: 0.4, tareas: 0.2, none: 0.4 } },
    )
    const reply = await askHelp(appDb, org, owner, { question: "quiero que empiece a contestar sola y me avise", screen: "/home" }, decider)
    expect(reply.kind).toBe("duda")
    const enciendo = helpOptions(helpTopicsFor("dental")).find((option) => option.kind === "faq" && option.faq.id === "enciendo-agente")
    expect(reply.choices[0]?.question).toBe(enciendo?.kind === "faq" ? enciendo.faq.q : "")
    expect(reply.choices).toHaveLength(3)
  })

  it("si Jev falla al decidir si las partes se completan, queda su duda, no el respaldo por palabras", async () => {
    const org = await clinic()
    const { decider } = jev(TWO_PARTS, { join: 0.95 })
    const failing: HelpDecider = {
      async decide(state, questions) {
        if (questions[0]?.id === HELP_JOIN_QUESTION) throw new Error("plazo")
        return decider.decide(state, questions)
      },
    }
    const { writer, got } = writerOf(WRITTEN)
    const reply = await askHelp(appDb, org, owner, { question: TWO_PARTS_QUESTION, screen: "/home" }, failing, writer)
    expect(reply).toMatchObject({ kind: "duda", written: null })
    expect(reply.choices.length).toBeGreaterThanOrEqual(2)
    expect(got).toEqual([])
    expect((await logOf(org))[0]).toMatchObject({ via: "jev", verdict: "duda", written: false })
  })

  it("un «no puedo» que se responde con lo que falta no queda anotado como redactada", async () => {
    const org = await clinic()
    const noTasks: HelpAsker = { ...owner, roleLabel: "Caja", can: (permission) => permission !== "tasks.write" }
    const reply = await askHelp(
      appDb,
      org,
      noTasks,
      { question: "no puedo crear una tarea ni pasársela a otra persona, ¿cómo se hace?", screen: "/home" },
      jev(TWO_PARTS, { join: 0.95 }).decider,
      writerOf(WRITTEN).writer,
    )
    expect(reply).toMatchObject({ kind: "estado", written: null })
    expect((await logOf(org))[0]).toMatchObject({ written: false })
    expect((await logOf(org))[0]?.verdict).not.toBe("redactada")
  })

  it("«Ninguna es lo que busco» tras una redactada también cuenta como sin respuesta", async () => {
    const org = await clinic()
    const staff: AdminActor = { userId: USER, role: "support" }
    const reply = await askHelp(appDb, org, owner, { question: TWO_PARTS_QUESTION, screen: "/home" }, jev(TWO_PARTS, { join: 0.95 }).decider, writerOf(WRITTEN).writer)
    expect(reply.written).toBe(WRITTEN)
    const before = await supportHelpStats(ownerDb, staff)
    await run((tx) => markHelpNoneFits(tx, org, USER, reply.askId), org)
    expect(await supportHelpStats(ownerDb, staff)).toMatchObject({ unanswered: before.unanswered + 1 })
  })
})

describe("enviar a odentIA", () => {
  it("dice lo que se agrega solo con los mismos valores que guarda el envío", async () => {
    const [org] = await ownerDb.select({ name: organization.name }).from(organization).where(eq(organization.id, ORG))
    const attached = await run((tx) => describeHelpAttachments(tx, ORG, reception, { screen: "/patients/123", appVersion: "1.2.3" }))
    expect(attached).toEqual({ screen: "Pacientes", role: "Recepción", clinic: org!.name, version: "1.2.3" })
    // Sin versión declarada no se promete ninguna; una pantalla fuera de la guía se dice por su ruta.
    expect(await run((tx) => describeHelpAttachments(tx, ORG, reception, { screen: "/no-existe" }))).toMatchObject({ screen: "/no-existe", version: null })
  })

  it("cada envío abre su caso privado y la respuesta del equipo llega solo a su clínica", async () => {
    const staff: AdminActor = { userId: "help-staff", role: "support" }
    await ownerDb.insert(user).values([{ id: staff.userId, name: "Soporte odentIA", email: "soporte@help.test", emailVerified: true }])
    const question = "¿Cómo exporto mis pacientes a Excel?"
    const myCase = await run((tx) => sendHelpRequest(tx, ORG, reception, { question, screen: "/patients", appVersion: "1.2.3" }))
    expect(myCase).toMatchObject({ kind: "pregunta", status: "abierto", reused: false })
    // Enviarla otra vez mientras sigue abierta no crea otra.
    const again = await run((tx) => sendHelpRequest(tx, ORG, reception, { question: "  ¿como exporto mis pacientes a excel? ", screen: "/home" }))
    expect(again).toMatchObject({ id: myCase.id, reused: true })
    const otherCase = await run((tx) => sendHelpRequest(tx, OTHER, { userId: OTHER_USER, roleLabel: "Propietario" }, { question, screen: "/patients" }), OTHER)
    await run((tx) => sendHelpRequest(tx, ORG, reception, { question: "La agenda no carga", screen: "/agenda", kind: "problema", detail: "HTTP 500" }))
    // El caso es la única fuente: guarda lo que se envió con lo que se agrega solo.
    const [stored] = await ownerDb.select().from(supportCase).where(eq(supportCase.id, myCase.id))
    expect(stored).toMatchObject({ role: "Recepción", appVersion: "1.2.3", screen: "/patients", openedBy: USER })

    // Cada envío tiene su caso privado: la misma pregunta en otra clínica no comparte hilo.
    expect(otherCase.id).not.toBe(myCase.id)
    expect(myCase.unread).toBe(false)

    // La respuesta del equipo marca no-leído solo en su clínica; «Ver» lo salda.
    await replyToSupportCase(ownerDb, staff, myCase.id, "Todavía no se puede exportar. Lo anotamos para una próxima versión.")
    const mineAfter = await run((tx) => getMySupportCase(tx, ORG, USER, myCase.id))
    expect(mineAfter.messages.map((message) => message.body)).toEqual(["Todavía no se puede exportar. Lo anotamos para una próxima versión."])
    expect((await run((tx) => listMySupportCases(tx, ORG, USER))).find((item) => item.id === myCase.id)?.unread).toBe(true)
    expect((await run((tx) => listMySupportCases(tx, OTHER, OTHER_USER), OTHER)).find((item) => item.id === otherCase.id)?.unread).toBe(false)
    await run((tx) => markSupportCaseSeen(tx, ORG, USER, myCase.id))
    expect((await run((tx) => listMySupportCases(tx, ORG, USER))).find((item) => item.id === myCase.id)?.unread).toBe(false)
    // Sin texto no hay respuesta.
    await expect(replyToSupportCase(ownerDb, staff, myCase.id, " ")).rejects.toThrow(/Escribe el mensaje/)
  })

  it("la misma pregunta después de resuelta abre un caso nuevo; solo se junta con uno abierto", async () => {
    const staff: AdminActor = { userId: "help-staff-2", role: "support" }
    await ownerDb.insert(user).values([{ id: staff.userId, name: "Soporte 2", email: "soporte2@help.test", emailVerified: true }])
    const question = "¿Puedo cambiar el color de la agenda?"
    const first = await run((tx) => sendHelpRequest(tx, ORG, reception, { question, screen: "/agenda" }))
    await setSupportCaseStatus(ownerDb, staff, first.id, "resuelto")
    const second = await run((tx) => sendHelpRequest(tx, ORG, reception, { question, screen: "/agenda" }))
    expect(second).toMatchObject({ status: "abierto", reused: false })
    expect(second.id).not.toBe(first.id)
    // Mientras el nuevo sigue abierto, repetirla se junta con él, no con el resuelto.
    expect((await run((tx) => sendHelpRequest(tx, ORG, reception, { question, screen: "/agenda" }))).id).toBe(second.id)
  })
})

// Al final: cada pregunta queda anotada, y las pruebas de arriba cuentan las de esta persona.
describe("el nombre de la pantalla", () => {
  it("a quien solo ve lo suyo le nombra la pantalla como su menú: «Mis honorarios», no «Comisiones»", async () => {
    const clinician: HelpAsker = {
      userId: USER,
      roleLabel: "Clínico",
      canOpen: (path) => path.startsWith("/commissions"),
      can: (permission) => permission === "commissions.read",
      whoCan: () => ["Propietario", "Administrador"],
    }
    const question = { question: "¿Cómo se calcula la comisión?", screen: "/commissions" }
    const mine = await askHelp(appDb, ORG, clinician, question)
    expect(mine.answers[0]).toMatchObject({ topicId: "comisiones", where: "Gestión › Mis honorarios" })
    expect(mine.basedOn).toBe("El mapa del sistema: Gestión › Mis honorarios.")
    // Quien administra comisiones las ve de todos: sigue siendo Comisiones.
    const admin = await askHelp(appDb, ORG, owner, question)
    expect(admin.answers[0]).toMatchObject({ topicId: "comisiones", where: "Gestión › Comisiones" })
  })
})
