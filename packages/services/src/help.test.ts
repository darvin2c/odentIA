import { type Db, withOrgContext } from "@odentia/db"
import { scheduleRoom } from "@odentia/db/schema/agenda"
import { member, organization, user } from "@odentia/db/schema/auth"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { branch } from "@odentia/db/schema/org"
import { supportCase } from "@odentia/db/schema/admin-support"
import { agentConfig } from "@odentia/db/schema/crm"
import { helpAsk } from "@odentia/db/schema/workspace"
import { eq, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"
import { askHelp, describeHelpAttachments, describeHelpScreen, HELP_DAILY_LIMIT, type HelpAsker, rateHelp, sendHelpRequest } from "./help.js"
import type { AdminActor } from "./admin-core.js"
import type { AdminQuestion } from "./admin-request.js"
import { type HelpDecider, type HelpOption, helpOptions } from "./help-decision.js"
import { helpTopicsFor } from "./products.js"
import { getMySupportCase, listMySupportCases, markSupportCaseSeen, replyToSupportCase, setSupportCaseStatus } from "./admin-support.js"
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

/**
 * Un Jev de prueba: responde `help.v1` con estas probabilidades, nombradas por
 * la pregunta frecuente, la pantalla («tema:<id>»), «none» o «data». Anota lo
 * que recibió. Sin proveedor ni costo.
 */
function jev(picks: Record<string, number>, product: "dental" | "medical" = "dental") {
  const options = helpOptions(helpTopicsFor(product))
  const keyOf = (option: HelpOption) => (option.kind === "faq" ? option.faq.q : `tema:${option.topic.id}`)
  const seen: Array<{ state: string; question: AdminQuestion }> = []
  const decider: HelpDecider = {
    async decide(state, questions) {
      const question = questions[0]
      if (!question || question.kind !== "choice") throw new Error("help.v1 es una pregunta de elegir")
      seen.push({ state, question })
      const probabilities = Object.fromEntries(
        Object.entries(picks).map(([key, probability]) => {
          if (key === "none" || key === "data") return [key, probability]
          const at = options.findIndex((option) => keyOf(option) === key)
          if (at < 0) throw new Error(`La guía no tiene ${key}`)
          return [question.options[at]?.value ?? "", probability]
        }),
      )
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none"
      return { answers: [{ id: question.id, kind: "choice", choice, confidence: null, probabilities }], model: "jev-prueba", usage: null }
    },
  }
  return { decider, seen }
}

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
      { topicId: "disponibilidad", where: "Configuración › Horarios y ausencias", text: expect.stringContaining("En Configuración › Horarios y ausencias"), path: "/settings/availability", restriction: null },
    ])
    expect(reply.basedOn).toBe("El mapa del sistema: Configuración › Horarios y ausencias.")

    const limited = await askHelp(appDb, ORG, reception, { question: "¿Dónde configuro los horarios?", screen: "/agenda" })
    expect(limited.answers[0]).toMatchObject({ path: null, restriction: expect.stringContaining("Tu rol (Recepción) no tiene acceso") })
    // Puede ver la agenda, pero no cambiarla: se le dice quién sí. Jev eligió el párrafo de Agenda.
    const readOnly = await askHelp(appDb, ORG, reception, { question: "¿Cómo muevo una cita?", screen: "/home" }, jev({ "tema:agenda": 0.95, none: 0.05 }).decider)
    expect(readOnly.answers[0]).toMatchObject({ topicId: "agenda", path: "/agenda", restriction: "Tu rol (Recepción) puede verla, pero no cambiarla. Pueden hacerlo: Propietario y Administrador." })

    // Sin Jev, lo que las palabras no reconocen como una pregunta frecuente no se responde.
    const unknown = await askHelp(appDb, ORG, owner, { question: "¿Se pueden enviar felicitaciones de cumpleaños?", screen: "/patients" })
    expect(unknown).toMatchObject({ kind: "nada", answers: [] })

    const logged = await ownerDb.select().from(helpAsk).where(eq(helpAsk.userId, USER))
    expect(logged.map((row) => [row.screen, row.topicId, row.faq, row.via, row.verdict, row.probability])).toEqual([
      ["/agenda", "disponibilidad", "¿Dónde configuro los horarios?", "exacta", null, null],
      ["/agenda", "disponibilidad", "¿Dónde configuro los horarios?", "exacta", null, null],
      ["/home", "agenda", null, "jev", "seguro", expect.closeTo(0.95, 5)],
      ["/patients", null, null, "respaldo", null, null],
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
  /** Una clínica propia por prueba: el tope diario y el registro no se mezclan. */
  async function clinic(options: { argos?: boolean; product?: "dental" | "medical" } = {}) {
    const id = randomUUID()
    await insertOrg(ownerDb, id, `jev-${id}`)
    if (options.product === "medical") await ownerDb.execute(sql`update org_profile set product = 'medical' where organization_id = ${id}`)
    if (options.argos !== undefined) await ownerDb.insert(agentConfig).values({ organizationId: id, advisor: { enabled: options.argos } })
    return id
  }
  const logOf = async (org: string) => (await ownerDb.select().from(helpAsk).where(eq(helpAsk.organizationId, org)))

  it("seguro: muestra el texto de la guía tal cual y viaja solo la pregunta con el nombre de la pantalla", async () => {
    const org = await clinic()
    const { decider, seen } = jev({ "¿Cómo bloqueo un horario?": 0.96, none: 0.04 })
    const reply = await askHelp(appDb, org, owner, { question: "quiero cerrar la tarde del doctor Ruiz", screen: "/agenda/2026-11-06" }, decider)
    expect(reply).toMatchObject({ kind: "guia", choices: [], argos: false, basedOn: "El mapa del sistema: Agenda." })
    expect(reply.answers).toEqual([{ topicId: "agenda", where: "Agenda", text: expect.stringContaining("registra una ausencia del profesional"), path: "/agenda", restriction: null }])
    expect(seen.map((item) => item.state)).toEqual(["Pantalla: Agenda\nPregunta: quiero cerrar la tarde del doctor Ruiz"])
    expect(seen[0]?.question.id).toBe("help")
    const [row] = await logOf(org)
    expect(row).toMatchObject({ screen: "/agenda/2026-11-06", topicId: "agenda", faq: "¿Cómo bloqueo un horario?", via: "jev", verdict: "seguro" })
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
    expect(seen).toHaveLength(1)
    expect((await logOf(org)).map((row) => [row.via, row.verdict, row.topicId])).toEqual(
      expect.arrayContaining([["jev", "duda", null], ["exacta", null, "agente"], ["exacta", null, "agente"]]),
    )
  })

  it("ninguna: dice que no está en la guía y nunca pega el párrafo de la pantalla", async () => {
    const org = await clinic()
    const reply = await askHelp(appDb, org, owner, { question: "¿qué antibiótico le doy a un absceso?", screen: "/agenda" }, jev({ none: 0.97, "tema:agenda": 0.03 }).decider)
    expect(reply).toMatchObject({ kind: "nada", answers: [], choices: [] })
    // «Ninguna» y «datos» juntas también: ninguna de las dos es de la guía.
    const away = await askHelp(appDb, org, owner, { question: "¿por qué la vista Día dice 15 y la lista 19?", screen: "/agenda" }, jev({ none: 0.5, data: 0.45, "tema:agenda": 0.05 }).decider)
    expect(away).toMatchObject({ kind: "nada", answers: [] })
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
    expect(quiet.answers).toEqual([{ topicId: "reportes", where: "Gestión › Reportes", text: "", path: "/reports", restriction: null }])
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
    expect(await askHelp(appDb, org, owner, { question: "¿Dónde veo el stock de insumos?", screen: "/agenda" }, down)).toMatchObject({ kind: "nada", answers: [] })
    // Un Jev que se niega a responder tampoco deja una duda sin nada que ofrecer.
    const declined: HelpDecider = { decide: async () => ({ answers: [{ id: "help", kind: "declined" }], model: "jev-prueba", usage: null }) }
    expect((await askHelp(appDb, org, owner, { question: "¿Dónde veo el stock de insumos?", screen: "/agenda" }, declined)).kind).toBe("nada")
    expect((await logOf(org)).map((row) => [row.via, row.verdict])).toEqual([["respaldo", null], ["respaldo", null], ["respaldo", null]])
  })

  it("en latidIA le pregunta con la guía y las palabras de latidIA", async () => {
    const org = await clinic({ product: "medical" })
    const { decider, seen } = jev({ "¿Cómo emito un descanso médico?": 0.95 }, "medical")
    const reply = await askHelp(appDb, org, owner, { question: "necesito darle 3 días de descanso", screen: "/people" }, decider)
    expect(reply.answers[0]?.text).toContain("Descanso médico")
    expect(seen[0]?.question.instructions).toContain("latidIA")
    expect(JSON.stringify(seen[0]?.question)).not.toContain("odentIA")
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
