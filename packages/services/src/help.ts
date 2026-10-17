import { createHash } from "node:crypto"
import type { Db } from "@odentia/db"
import { scheduleChair } from "@odentia/db/schema/agenda"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { organization } from "@odentia/db/schema/auth"
import { agentConfig, channelConnection } from "@odentia/db/schema/crm"
import { helpAsk } from "@odentia/db/schema/workspace"
import { and, count, eq, gte } from "drizzle-orm"
import { openSupportCaseFromHelp, type SupportCaseListItem } from "./admin-support.js"
import { notFound, ServiceError, validation } from "./errors.js"
import {
  type HelpTopic,
  helpSuggestions,
  helpTopic,
  helpTopicForScreen,
  helpTopicLabel,
  matchHelpTopics,
} from "./help-guide.js"
import { normalizeForSearch } from "./knowledge.js"

/* ---------- Ayuda de odentIA: dónde está cada cosa, qué se puede y por qué algo no ---------- */

/**
 * La Ayuda responde con la guía del sistema, no con un modelo: el tema lo
 * eligen las palabras de la pregunta y la respuesta es un texto escrito y
 * revisado. No cambia nada, no lee conversaciones ni historia clínica y, si no
 * sabe, lo dice. El tope diario protege el servicio; hoy no hay coste por uso.
 */
export const HELP_DAILY_LIMIT = 200
const QUESTION_CHARS = 500

export interface HelpAnswer {
  topicId: string
  /** Nombre de la pantalla como en el menú: «Configuración › Disponibilidad». */
  where: string
  text: string
  /** Ruta para «Llévame»; nula si el rol de quien pregunta no puede entrar. */
  path: string | null
  /** Por qué no puede ir o cambiarlo, y quién sí, cuando su rol no alcanza. */
  restriction: string | null
}

export interface HelpReply {
  askId: string
  /** `guia`: respondió con un tema. `estado`: dijo qué falta en esa pantalla. `nada`: no lo sabe. */
  kind: "guia" | "estado" | "nada"
  answers: HelpAnswer[]
  /** Lo que falta de verdad en la pantalla, cuando se preguntó por qué algo no se puede. */
  blockers: Array<{ text: string; where: string | null; path: string | null }>
  basedOn: string
}

/** Lo que la Ayuda necesita saber de quien pregunta; lo calcula la API con la matriz de permisos. */
export interface HelpAsker {
  userId: string
  roleLabel: string
  /** ¿Puede entrar a esa pantalla? */
  canOpen: (path: string) => boolean
  can: (permission: string) => boolean
  /** Roles que sí tienen un permiso, para decir a quién pedírselo. */
  whoCan: (permission: string) => string[]
}

const WHY_NOT = /\b(por que no|porque no|no puedo|no me deja|no me permite|no aparece|no sale|no funciona|bloquead)/

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`)

function restrictionFor(topic: HelpTopic, asker: HelpAsker): { path: string | null; restriction: string | null } {
  if (!asker.canOpen(topic.path)) {
    return { path: null, restriction: `Tu rol (${asker.roleLabel}) no tiene acceso a esa pantalla. Pídeselo a quien administra la clínica.` }
  }
  if (topic.writePermission && !asker.can(topic.writePermission)) {
    const roles = asker.whoCan(topic.writePermission)
    return {
      path: topic.path,
      restriction: `Tu rol (${asker.roleLabel}) puede verla, pero no cambiarla.${roles.length ? ` Pueden hacerlo: ${list(roles)}.` : ""}`,
    }
  }
  return { path: topic.path, restriction: null }
}

/**
 * Lo que falta de verdad en una pantalla para que algo se pueda hacer. Son
 * comprobaciones del estado real de la clínica, no suposiciones: cada una
 * mira un dato y dice dónde se resuelve.
 */
async function screenBlockers(tx: Db, orgId: string, topic: HelpTopic | undefined, asker: HelpAsker): Promise<HelpReply["blockers"]> {
  const out: HelpReply["blockers"] = []
  const at = (id: string) => {
    const target = helpTopic(id)
    return target && asker.canOpen(target.path) ? { where: helpTopicLabel(target), path: target.path } : { where: target ? helpTopicLabel(target) : null, path: null }
  }
  if (!topic) return out
  if (topic.writePermission && !asker.can(topic.writePermission)) {
    const roles = asker.whoCan(topic.writePermission)
    out.push({ text: `Tu rol (${asker.roleLabel}) puede ver ${topic.title}, pero no cambiar nada ahí.${roles.length ? ` Pueden hacerlo: ${list(roles)}.` : ""}`, where: null, path: null })
  }
  const total = async (query: Promise<Array<{ total: number }>>) => Number((await query)[0]?.total ?? 0)
  if (topic.id === "agenda" || topic.id === "disponibilidad") {
    const chairs = await total(tx.select({ total: count() }).from(scheduleChair).where(and(eq(scheduleChair.organizationId, orgId), eq(scheduleChair.isActive, true))))
    if (chairs === 0) out.push({ text: "No hay ninguna unidad dental creada. Sin unidad dental no se puede reservar una cita.", ...at("disponibilidad") })
    const schedules = await total(tx.select({ total: count() }).from(professionalSchedule).where(eq(professionalSchedule.organizationId, orgId)))
    if (schedules === 0) out.push({ text: "Ningún profesional tiene horario de atención. Sin horario no aparecen en la agenda ni se les puede reservar.", ...at("disponibilidad") })
    const services = await total(tx.select({ total: count() }).from(serviceCatalog).where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.isActive, true))))
    if (services === 0) out.push({ text: "Todavía no hay servicios en la clínica; las citas se pueden reservar, pero sin servicio ni duración sugerida.", ...at("servicios") })
  }
  if (topic.id === "bandeja" || topic.id === "canales") {
    const channels = await total(tx.select({ total: count() }).from(channelConnection).where(and(eq(channelConnection.organizationId, orgId), eq(channelConnection.status, "active"))))
    if (channels === 0) out.push({ text: "No hay ningún canal conectado: no pueden llegar ni salir mensajes.", ...at("canales") })
  }
  if (topic.id === "agente" || topic.id === "bandeja") {
    const [cfg] = await tx.select({ enabled: agentConfig.enabled }).from(agentConfig).where(eq(agentConfig.organizationId, orgId)).limit(1)
    if (topic.id === "agente" && !cfg?.enabled) out.push({ text: "Recepción está apagado: el agente no responde hasta que lo enciendas.", ...at("agente") })
  }
  return out
}

async function requireDailyRoom(tx: Db, orgId: string, userId: string): Promise<void> {
  const since = new Date(Date.now() - 86_400_000)
  const [row] = await tx
    .select({ total: count() })
    .from(helpAsk)
    .where(and(eq(helpAsk.organizationId, orgId), eq(helpAsk.userId, userId), gte(helpAsk.createdAt, since)))
  if (Number(row?.total ?? 0) >= HELP_DAILY_LIMIT) {
    throw new ServiceError("HELP_LIMIT", 429, "Llegaste al tope de preguntas a la Ayuda por hoy. Mañana vuelve a estar disponible.")
  }
}

/**
 * Responde una pregunta sobre cómo usar odentIA. Deja constancia de la
 * pantalla y del tema que respondió, nunca del texto de la pregunta.
 */
export async function askHelp(tx: Db, orgId: string, asker: HelpAsker, input: { question: unknown; screen: unknown }): Promise<HelpReply> {
  if (typeof input.question !== "string" || input.question.trim().length < 3) throw validation("Escribe tu pregunta")
  const question = input.question.trim().slice(0, QUESTION_CHARS)
  const screen = typeof input.screen === "string" ? input.screen.slice(0, 200) : "/"
  await requireDailyRoom(tx, orgId, asker.userId)
  const here = helpTopicForScreen(screen)
  const log = async (topicId: string | null) => {
    const [row] = await tx.insert(helpAsk).values({ organizationId: orgId, userId: asker.userId, screen, topicId }).returning({ id: helpAsk.id })
    if (!row) throw new Error("No se pudo registrar la consulta")
    return row.id
  }

  // «¿Por qué no puedo…?»: primero lo que falta de verdad en la pantalla donde está.
  if (WHY_NOT.test(normalizeForSearch(question))) {
    const blockers = await screenBlockers(tx, orgId, here, asker)
    if (blockers.length > 0) {
      return {
        askId: await log(here?.id ?? null),
        kind: "estado",
        answers: [],
        blockers,
        basedOn: `Lo que tu clínica tiene configurado ahora y lo que tu rol puede hacer${here ? ` en ${here.title}` : ""}.`,
      }
    }
  }

  const matches = matchHelpTopics(question)
  if (matches.length === 0) {
    return { askId: await log(null), kind: "nada", answers: [], blockers: [], basedOn: "" }
  }
  const answers = matches.map(({ topic, faq }) => {
    const access = restrictionFor(topic, asker)
    return {
      topicId: topic.id,
      where: helpTopicLabel(topic),
      text: faq ? faq.a : `En ${helpTopicLabel(topic)}. ${topic.purpose}`,
      path: access.path,
      restriction: access.restriction,
    }
  })
  return {
    askId: await log(matches[0]?.topic.id ?? null),
    kind: "guia",
    answers,
    blockers: [],
    basedOn: `El mapa del sistema: ${answers.map((answer) => answer.where).join(" y ")}.`,
  }
}

/** «¿Te sirvió?»: un sí o un no sobre la respuesta, sin texto. */
export async function rateHelp(tx: Db, orgId: string, userId: string, askId: string, helpful: boolean): Promise<void> {
  const [row] = await tx
    .update(helpAsk)
    .set({ helpful })
    .where(and(eq(helpAsk.organizationId, orgId), eq(helpAsk.userId, userId), eq(helpAsk.id, askId)))
    .returning({ id: helpAsk.id })
  if (!row) throw notFound("Consulta de ayuda")
}

/** Lo que la Ayuda sabe de la pantalla donde está la persona: su nombre y qué suelen preguntar ahí. */
export function describeHelpScreen(screen: string): { title: string | null; suggestions: string[] } {
  return { title: helpTopicForScreen(screen)?.title ?? null, suggestions: helpSuggestions(screen) }
}

/* ---------- Enviar a odentIA ---------- */

/** Lo que acompaña a un envío sin que la persona lo escriba, dicho con sus valores. */
export interface HelpAttachments {
  /** Nombre de la pantalla en la guía; su ruta si la guía no la conoce. */
  screen: string
  role: string
  clinic: string | null
  /** Nula si este despliegue no declara versión: entonces no se envía ninguna. */
  version: string | null
}

/**
 * «Se agrega solo»: lo mismo que `sendHelpRequest` guarda junto a la pregunta
 * (pantalla, rol, clínica y versión), para mostrarlo antes de enviar. Un dato
 * nuevo en el envío se añade aquí en el mismo cambio.
 */
export async function describeHelpAttachments(
  tx: Db,
  orgId: string,
  asker: Pick<HelpAsker, "roleLabel">,
  input: { screen: string; appVersion?: string | null },
): Promise<HelpAttachments> {
  const [org] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId)).limit(1)
  const screen = input.screen.slice(0, 200)
  return {
    screen: helpTopicForScreen(screen)?.title ?? screen,
    role: asker.roleLabel,
    clinic: org?.name ?? null,
    version: input.appVersion?.trim() || null,
  }
}

/** Clave de agrupación de una pregunta: la usa el caso de soporte para juntar envíos repetidos. */
export const helpDedupeKeyOf = (question: string): string =>
  createHash("sha256").update(normalizeForSearch(question)).digest("hex").slice(0, 32)

/**
 * La persona decide enviar su pregunta (o un problema) a odentIA. Va su texto,
 * la pantalla, su rol y la versión; nada de pacientes. Abre su caso de soporte,
 * que es la única fuente: enviar dos veces la misma pregunta mientras su caso
 * sigue abierto no crea otro, y repetirla después de resuelta abre uno nuevo.
 */
export async function sendHelpRequest(
  tx: Db,
  orgId: string,
  asker: Pick<HelpAsker, "userId" | "roleLabel">,
  input: { question: unknown; screen: unknown; kind?: unknown; detail?: unknown; appVersion?: string | null },
): Promise<SupportCaseListItem & { reused: boolean }> {
  if (typeof input.question !== "string" || input.question.trim().length < 3) throw validation("Escribe lo que quieres preguntar")
  const question = input.question.trim().slice(0, QUESTION_CHARS)
  return openSupportCaseFromHelp(tx, orgId, {
    userId: asker.userId,
    kind: input.kind === "problema" ? "problema" : "pregunta",
    question,
    detail: typeof input.detail === "string" && input.detail.trim() ? input.detail.trim().slice(0, 500) : null,
    screen: typeof input.screen === "string" ? input.screen.slice(0, 200) : "/",
    role: asker.roleLabel,
    appVersion: input.appVersion ?? null,
    dedupeKey: helpDedupeKeyOf(question),
  })
}
