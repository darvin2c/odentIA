import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { type Db, withOrgContext } from "@odentia/db"
import { scheduleChair } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { branch } from "@odentia/db/schema/org"
import { helpAsk, helpRequest } from "@odentia/db/schema/workspace"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { answerHelpCase, askHelp, describeHelpScreen, HELP_DAILY_LIMIT, type HelpAsker, listHelpCases, listMyHelpRequests, markHelpRequestsSeen, rateHelp, sendHelpRequest } from "./help.js"
import { HELP_TOPICS, helpTopicForScreen, matchHelpTopics } from "./help-guide.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/** Ayuda: la guía coincide con el código, responde sin inventar y lo que no sabe se puede enviar a odentIA. */
setupTestDb()
const ORG = "org_a"
const OTHER = "org_b"
const USER = "help-user"
const OTHER_USER = "help-user-b"

const platform = (file: string) => readFileSync(fileURLToPath(new URL(`../../../apps/platform/src/${file}`, import.meta.url)), "utf8")

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
  canOpen: (path) => !path.startsWith("/settings") && path !== "/branches" && path !== "/members",
  can: (permission) => !["settings.write", "appointments.write", "agent.write"].includes(permission),
  whoCan: () => ["Propietario", "Administrador"],
}

describe("la guía coincide con el código", () => {
  it("cada tema apunta a una pantalla que existe y la llama como el menú", () => {
    const routes = new Set([...platform("routeTree.gen.ts").matchAll(/fullPath: '([^']+)'/g)].map((match) => (match[1] ?? "").replace(/\/$/, "") || "/"))
    for (const topic of HELP_TOPICS) expect(routes.has(topic.path), `${topic.id} → ${topic.path} ya no es una pantalla`).toBe(true)
    expect(new Set(HELP_TOPICS.map((topic) => topic.id)).size).toBe(HELP_TOPICS.length)
    expect(new Set(HELP_TOPICS.map((topic) => topic.path)).size).toBe(HELP_TOPICS.length)
    for (const topic of HELP_TOPICS) {
      expect(topic.purpose.length, topic.id).toBeGreaterThan(30)
      expect(topic.terms.length, topic.id).toBeGreaterThanOrEqual(3)
    }
  })

  it("toda pantalla del menú y de Configuración tiene su tema, con el mismo nombre", () => {
    const entries = (source: string) =>
      [...source.matchAll(/label: "([^"]+)", to: "([^"]+)"/g)].map((match) => ({ label: match[1] ?? "", to: match[2] ?? "" }))
    const menu = [...entries(platform("routes/_org.tsx")), ...entries(platform("routes/_org/settings.tsx"))]
    expect(menu.length).toBeGreaterThan(20)
    for (const item of menu) {
      const topic = HELP_TOPICS.find((candidate) => candidate.path === item.to)
      expect(topic, `Falta el tema de ${item.label} (${item.to})`).toBeTruthy()
      // La entrada «Configuración» del menú lleva a su primera sección: vale el nombre de la sección o el del grupo.
      expect([topic?.title, topic?.parent], item.to).toContain(item.label)
    }
  })

  it("encuentra la pantalla por las palabras de la gente y no responde lo que no está", () => {
    const first = (question: string) => matchHelpTopics(question)[0]?.topic.id ?? null
    expect(first("¿Dónde configuro los horarios?")).toBe("disponibilidad")
    expect(first("¿Puedo tener más de una sede?")).toBe("sucursales")
    expect(first("como conecto whatsapp")).toBe("canales")
    expect(first("donde cambio la lista de precios")).toBe("servicios")
    expect(first("quiero invitar a una recepcionista")).toBe("equipo")
    expect(first("¿dónde veo el stock de insumos?")).toBe("inventario")
    expect(first("¿cómo enciendo el agente?")).toBe("agente")
    // Una pregunta frecuente responde con su texto, no con el propósito de la pantalla.
    expect(matchHelpTopics("¿Cómo bloqueo un horario?")[0]?.faq?.a).toContain("Bloquear horario")
    // Lo que no está en la guía no se inventa.
    expect(matchHelpTopics("¿Cómo exporto mis pacientes a Excel?")).toEqual([])
    expect(matchHelpTopics("¿Qué tiempo hará mañana?")).toEqual([])
    expect(helpTopicForScreen("/settings/availability")?.id).toBe("disponibilidad")
    expect(helpTopicForScreen("/patients/123/encounters/456")?.id).toBe("pacientes")
    expect(describeHelpScreen("/agenda")).toMatchObject({ title: "Agenda" })
    expect(describeHelpScreen("/agenda").suggestions[0]).toBe("¿Cómo bloqueo un horario?")
  })
})

describe("responder", () => {
  it("dice dónde está, lleva si el rol puede y, si no, dice quién sí; no guarda la pregunta", async () => {
    const reply = await run((tx) => askHelp(tx, ORG, owner, { question: "¿Dónde configuro los horarios?", screen: "/agenda" }))
    expect(reply).toMatchObject({ kind: "guia", blockers: [] })
    expect(reply.answers).toEqual([
      { topicId: "disponibilidad", where: "Configuración › Disponibilidad", text: expect.stringContaining("En Configuración › Disponibilidad"), path: "/settings/availability", restriction: null },
    ])
    expect(reply.basedOn).toBe("El mapa del sistema: Configuración › Disponibilidad.")

    const limited = await run((tx) => askHelp(tx, ORG, reception, { question: "¿Dónde configuro los horarios?", screen: "/agenda" }))
    expect(limited.answers[0]).toMatchObject({ path: null, restriction: expect.stringContaining("Tu rol (Recepción) no tiene acceso") })
    // Puede ver la agenda, pero no cambiarla: se le dice quién sí.
    const readOnly = await run((tx) => askHelp(tx, ORG, reception, { question: "¿Cómo muevo una cita?", screen: "/home" }))
    expect(readOnly.answers[0]).toMatchObject({ topicId: "agenda", path: "/agenda", restriction: "Tu rol (Recepción) puede verla, pero no cambiarla. Pueden hacerlo: Propietario y Administrador." })

    const unknown = await run((tx) => askHelp(tx, ORG, owner, { question: "¿Cómo exporto mis pacientes a Excel?", screen: "/patients" }))
    expect(unknown).toMatchObject({ kind: "nada", answers: [] })

    const logged = await ownerDb.select().from(helpAsk).where(eq(helpAsk.userId, USER))
    expect(logged.map((row) => [row.screen, row.topicId])).toEqual([["/agenda", "disponibilidad"], ["/agenda", "disponibilidad"], ["/home", "agenda"], ["/patients", null]])
    expect(JSON.stringify(logged)).not.toContain("Excel")

    await run((tx) => rateHelp(tx, ORG, USER, reply.askId, true))
    expect((await ownerDb.select().from(helpAsk).where(eq(helpAsk.id, reply.askId)))[0]?.helpful).toBe(true)
    // Otra organización no puede valorar esa consulta.
    await expect(run((tx) => rateHelp(tx, OTHER, OTHER_USER, reply.askId, false), OTHER)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(run((tx) => askHelp(tx, ORG, owner, { question: " ", screen: "/home" }))).rejects.toThrow(/Escribe tu pregunta/)
  })

  it("«¿por qué no puedo?» dice lo que falta de verdad en esa pantalla", async () => {
    const empty = await run((tx) => askHelp(tx, ORG, owner, { question: "¿Por qué no puedo reservar una cita?", screen: "/agenda" }))
    expect(empty.kind).toBe("estado")
    expect(empty.blockers.map((item) => item.text)).toEqual(expect.arrayContaining([
      "No hay ningún sillón creado. Sin sillón no se puede reservar una cita.",
      "Ningún profesional tiene horario de atención. Sin horario no aparecen en la agenda ni se les puede reservar.",
    ]))
    expect(empty.blockers[0]).toMatchObject({ where: "Configuración › Disponibilidad", path: "/settings/availability" })
    // A quien no puede cambiar la agenda se le dice primero eso, y no se le lleva a donde no entra.
    const limited = await run((tx) => askHelp(tx, ORG, reception, { question: "no me deja mover la cita", screen: "/agenda" }))
    expect(limited.blockers[0]?.text).toContain("Tu rol (Recepción) puede ver Agenda, pero no cambiar nada ahí.")
    expect(limited.blockers.filter((item) => item.where === "Configuración › Disponibilidad").every((item) => item.path === null)).toBe(true)

    // Con sillón, horario y servicio ya no falta nada: responde con la guía.
    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Sede Ayuda", timezone: "America/Lima" }).returning({ id: branch.id })
    await ownerDb.insert(scheduleChair).values({ organizationId: ORG, branchId: site!.id, name: "Sillón 1" })
    await ownerDb.insert(professionalSchedule).values({ organizationId: ORG, branchId: site!.id, dentistUserId: USER, weekday: 1, startMin: 540, endMin: 780 })
    const ready = await run((tx) => askHelp(tx, ORG, owner, { question: "¿Por qué no puedo mover esta cita?", screen: "/agenda" }))
    expect(ready.blockers.map((item) => item.text)).toEqual(["Todavía no hay servicios en el tarifario; las citas se pueden reservar, pero sin servicio ni duración sugerida."])
  })

  it("tiene un tope diario por persona", async () => {
    const rows = Array.from({ length: HELP_DAILY_LIMIT }, () => ({ organizationId: OTHER, userId: OTHER_USER, screen: "/home" }))
    await ownerDb.insert(helpAsk).values(rows)
    const asker = { ...owner, userId: OTHER_USER }
    await expect(run((tx) => askHelp(tx, OTHER, asker, { question: "¿Dónde veo las citas?", screen: "/home" }), OTHER)).rejects.toMatchObject({ code: "HELP_LIMIT", status: 429 })
  })
})

describe("enviar a odentIA", () => {
  it("la misma pregunta de dos clínicas es un solo caso, y la respuesta llega a las dos", async () => {
    const question = "¿Cómo exporto mis pacientes a Excel?"
    const mine = await run((tx) => sendHelpRequest(tx, ORG, reception, { question, screen: "/patients", appVersion: "1.2.3" }))
    expect(mine).toMatchObject({ kind: "pregunta", status: "abierta", answer: null, screen: "/patients", seen: false })
    // Enviarla otra vez mientras sigue abierta no crea otra.
    expect((await run((tx) => sendHelpRequest(tx, ORG, reception, { question: "  ¿como exporto mis pacientes a excel? ", screen: "/home" }))).id).toBe(mine.id)
    await run((tx) => sendHelpRequest(tx, OTHER, { userId: OTHER_USER, roleLabel: "Propietario" }, { question, screen: "/patients" }), OTHER)
    await run((tx) => sendHelpRequest(tx, ORG, reception, { question: "La agenda no carga", screen: "/agenda", kind: "problema", detail: "HTTP 500" }))
    const [stored] = await ownerDb.select().from(helpRequest).where(eq(helpRequest.id, mine.id))
    expect(stored).toMatchObject({ role: "Recepción", appVersion: "1.2.3" })

    // Cada clínica ve solo lo suyo.
    expect((await run((tx) => listMyHelpRequests(tx, ORG, USER))).map((item) => item.question)).toEqual(["La agenda no carga", question])
    expect(await run((tx) => listMyHelpRequests(tx, OTHER, OTHER_USER), OTHER)).toHaveLength(1)

    // El equipo de odentIA ve los casos juntos, con su contador.
    const cases = await listHelpCases(ownerDb)
    const exportCase = cases.find((item) => item.question === question)
    expect(exportCase).toMatchObject({ count: 2, organizations: 2, kind: "pregunta", screens: ["/patients"] })
    expect(cases.find((item) => item.question === "La agenda no carga")).toMatchObject({ count: 1, kind: "problema" })

    expect(await answerHelpCase(ownerDb, exportCase!.dedupeKey, "Todavía no se puede exportar. Lo anotamos para una próxima versión.")).toBe(2)
    const answered = (await run((tx) => listMyHelpRequests(tx, ORG, USER))).find((item) => item.id === mine.id)
    expect(answered).toMatchObject({ status: "respondida", answer: expect.stringContaining("Todavía no se puede exportar"), seen: false })
    expect((await run((tx) => listMyHelpRequests(tx, OTHER, OTHER_USER), OTHER))[0]?.status).toBe("respondida")
    await run((tx) => markHelpRequestsSeen(tx, ORG, USER))
    expect((await run((tx) => listMyHelpRequests(tx, ORG, USER))).find((item) => item.id === mine.id)?.seen).toBe(true)
    // Respondido, el caso sale de la lista del equipo; una pregunta nueva igual abre otro.
    expect((await listHelpCases(ownerDb)).some((item) => item.question === question)).toBe(false)
    await expect(answerHelpCase(ownerDb, exportCase!.dedupeKey, " ")).rejects.toThrow(/Escribe la respuesta/)
  })
})
