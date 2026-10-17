import { type Db, withOrgContext } from "@odentia/db"
import { scheduleChair } from "@odentia/db/schema/agenda"
import { member, organization, user } from "@odentia/db/schema/auth"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { branch } from "@odentia/db/schema/org"
import { supportCase } from "@odentia/db/schema/admin-support"
import { helpAsk } from "@odentia/db/schema/workspace"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { askHelp, describeHelpAttachments, describeHelpScreen, HELP_DAILY_LIMIT, type HelpAsker, rateHelp, sendHelpRequest } from "./help.js"
import type { AdminActor } from "./admin-core.js"
import { getMySupportCase, listMySupportCases, markSupportCaseSeen, replyToSupportCase, setSupportCaseStatus } from "./admin-support.js"
import { helpTopicForScreen, matchHelpTopics } from "./help-guide.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

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
    // Lo que no está en la guía no se inventa.
    expect(matchHelpTopics("¿Cómo exporto mis pacientes a Excel?")).toEqual([])
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
    const reply = await run((tx) => askHelp(tx, ORG, owner, { question: "¿Dónde configuro los horarios?", screen: "/agenda" }))
    expect(reply).toMatchObject({ kind: "guia", blockers: [] })
    expect(reply.answers).toEqual([
      { topicId: "disponibilidad", where: "Configuración › Horarios y ausencias", text: expect.stringContaining("En Configuración › Horarios y ausencias"), path: "/settings/availability", restriction: null },
    ])
    expect(reply.basedOn).toBe("El mapa del sistema: Configuración › Horarios y ausencias.")

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
      "No hay ninguna unidad dental creada. Sin unidad dental no se puede reservar una cita.",
      "Ningún profesional tiene horario de atención. Sin horario no aparecen en la agenda ni se les puede reservar.",
    ]))
    expect(empty.blockers[0]).toMatchObject({ where: "Configuración › Horarios y ausencias", path: "/settings/availability" })
    // A quien no puede cambiar la agenda se le dice primero eso, y no se le lleva a donde no entra.
    const limited = await run((tx) => askHelp(tx, ORG, reception, { question: "no me deja mover la cita", screen: "/agenda" }))
    expect(limited.blockers[0]?.text).toContain("Tu rol (Recepción) puede ver Agenda, pero no cambiar nada ahí.")
    expect(limited.blockers.filter((item) => item.where === "Configuración › Horarios y ausencias").every((item) => item.path === null)).toBe(true)

    // Con unidad dental, horario y servicio ya no falta nada: responde con la guía.
    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: "Sede Ayuda", timezone: "America/Lima" }).returning({ id: branch.id })
    await ownerDb.insert(scheduleChair).values({ organizationId: ORG, branchId: site!.id, name: "Unidad dental 1" })
    await ownerDb.insert(professionalSchedule).values({ organizationId: ORG, branchId: site!.id, dentistUserId: USER, weekday: 1, startMin: 540, endMin: 780 })
    const ready = await run((tx) => askHelp(tx, ORG, owner, { question: "¿Por qué no puedo mover esta cita?", screen: "/agenda" }))
    expect(ready.blockers.map((item) => item.text)).toEqual(["Todavía no hay servicios en la clínica; las citas se pueden reservar, pero sin servicio ni duración sugerida."])
  })

  it("tiene un tope diario por persona", async () => {
    const rows = Array.from({ length: HELP_DAILY_LIMIT }, () => ({ organizationId: OTHER, userId: OTHER_USER, screen: "/home" }))
    await ownerDb.insert(helpAsk).values(rows)
    const asker = { ...owner, userId: OTHER_USER }
    await expect(run((tx) => askHelp(tx, OTHER, asker, { question: "¿Dónde veo las citas?", screen: "/home" }), OTHER)).rejects.toMatchObject({ code: "HELP_LIMIT", status: 429 })
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
