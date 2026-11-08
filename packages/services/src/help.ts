import { createHash } from "node:crypto"
import { mayIdentifySomeone } from "@odentia/clinical"
import { type Db, withOrgContext } from "@odentia/db"
import { scheduleRoom } from "@odentia/db/schema/agenda"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { organization } from "@odentia/db/schema/auth"
import { agentConfig, channelConnection } from "@odentia/db/schema/crm"
import { type HELP_ASK_VERDICTS, type HELP_ASK_VIA, helpAsk } from "@odentia/db/schema/workspace"
import { and, count, eq, gte, sql } from "drizzle-orm"
import { getAdminSettings } from "./agent-admin.js"
import { openSupportCaseFromHelp, type SupportCaseListItem } from "./admin-support.js"
import { invalidField, notFound, ServiceError } from "./errors.js"
import {
  type HelpDecider,
  helpAnswerText,
  helpCandidates,
  type HelpOption,
  helpOptions,
  helpQuestion,
  helpScreenName,
  type HelpSelection,
  helpState,
  readHelpSelection,
} from "./help-decision.js"
import {
  type HelpTopic,
  helpSuggestions,
  helpTopic,
  helpTopicForScreen,
  helpTopicLabel,
  helpSmallTalk,
  helpWordCount,
  helpWritePermissions,
  matchHelpTopics,
} from "./help-guide.js"
import { normalizeForSearch } from "./knowledge.js"
import { AGENT_NAMES, RECEPTION_DEFAULT_NAME, receptionName } from "./agent-names.js"
import { roomWord } from "./locale.js"
import type { ProductAgentTexts } from "./product-agent.js"
import { productAgentTexts, productHelpTopics } from "./products.js"
import { getArgosPanelAllowance } from "./saas-included.js"

/* ---------- Ariadna, la que responde en Ayuda: dónde está cada cosa, qué se puede y por qué algo no ---------- */

/**
 * Ariadna responde con la guía del sistema (ADR 0146): lo escrito igual que en
 * la guía responde sin modelo; lo demás lo elige Jev entre las respuestas de la
 * guía (`help.v1`) y se muestra tal cual, porque el modelo no redacta. Si Jev
 * duda, ofrece las más parecidas; si no está en la guía, lo dice; si es de las
 * cifras de la clínica, la lleva a Argos. Sin Jev, solo responde una pregunta
 * frecuente que reconozcan las palabras. No cambia nada ni lee conversaciones,
 * historia clínica ni montos. Lo que cuesta Jev lo paga odentIA (origen
 * `ayuda`); el tope diario protege el servicio.
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

/** Una respuesta para elegir cuando Ariadna duda: tocarla la pregunta escrita como en la guía, sin modelo. */
export interface HelpChoice {
  question: string
  /** La pantalla de esa respuesta, para reconocerla; vacío si no es de una pantalla. */
  where: string
}

export interface HelpReply {
  askId: string
  /**
   * `guia`: respondió con la guía. `estado`: dijo qué falta en esa pantalla.
   * `duda`: no está segura y ofrece las más parecidas. `nada`: no está en la
   * guía. `datos`: es de las cifras de la clínica. `charla`: un saludo o un gracias.
   */
  kind: "guia" | "estado" | "duda" | "nada" | "datos" | "charla"
  /** Lo que dice cuando es `charla`, `duda` o `datos`. */
  say: string | null
  answers: HelpAnswer[]
  /** Lo que falta de verdad en la pantalla, cuando se preguntó por qué algo no se puede. */
  blockers: Array<{ text: string; where: string | null; path: string | null }>
  /** `duda`: hasta tres respuestas de la guía para elegir. */
  choices: HelpChoice[]
  /** `datos`: puede preguntárselo a Argos (ve Reportes y Argos está encendido). */
  argos: boolean
  /** `datos` con Argos: lo que cuesta preguntarle, dicho como está hoy; nulo si no tiene tope. */
  argosNote: string | null
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

const canChange = (topic: HelpTopic, asker: HelpAsker): boolean => {
  const needed = helpWritePermissions(topic)
  return needed.length === 0 || needed.some((permission) => asker.can(permission))
}

const whoCanChange = (topic: HelpTopic, asker: HelpAsker): string[] => [...new Set(helpWritePermissions(topic).flatMap((permission) => asker.whoCan(permission)))]

function restrictionFor(topic: HelpTopic, asker: HelpAsker): { path: string | null; restriction: string | null } {
  if (!asker.canOpen(topic.path)) {
    return { path: null, restriction: `Tu rol (${asker.roleLabel}) no tiene acceso a esa pantalla. Pídeselo a quien administra la clínica.` }
  }
  if (!canChange(topic, asker)) {
    const roles = whoCanChange(topic, asker)
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
async function screenBlockers(
  tx: Db,
  orgId: string,
  topic: HelpTopic | undefined,
  asker: HelpAsker,
  topics: readonly HelpTopic[],
): Promise<HelpReply["blockers"]> {
  const out: HelpReply["blockers"] = []
  const at = (id: string) => {
    const target = helpTopic(id, topics)
    return target && asker.canOpen(target.path) ? { where: helpTopicLabel(target), path: target.path } : { where: target ? helpTopicLabel(target) : null, path: null }
  }
  if (!topic) return out
  // Lo que preguntó puede ser una pantalla que no abre: no se le dice que la ve.
  if (!asker.canOpen(topic.path)) {
    out.push({ text: `Tu rol (${asker.roleLabel}) no tiene acceso a ${topic.title}. Pídeselo a quien administra la clínica.`, where: null, path: null })
  } else if (!canChange(topic, asker)) {
    const roles = whoCanChange(topic, asker)
    out.push({ text: `Tu rol (${asker.roleLabel}) puede ver ${topic.title}, pero no cambiar nada ahí.${roles.length ? ` Pueden hacerlo: ${list(roles)}.` : ""}`, where: null, path: null })
  }
  const total = async (query: Promise<Array<{ total: number }>>) => Number((await query)[0]?.total ?? 0)
  if (topic.id === "agenda" || topic.id === "disponibilidad") {
    const rooms = await total(tx.select({ total: count() }).from(scheduleRoom).where(and(eq(scheduleRoom.organizationId, orgId), eq(scheduleRoom.isActive, true))))
    if (rooms === 0) {
      const room = (await roomWord(tx, orgId)).one
      out.push({ text: `No hay ninguna ${room} creada. Sin ${room} no se puede reservar una cita.`, ...at("disponibilidad") })
    }
    // Solo el vigente: cambiar un horario deja cerrado el anterior (ADR 0060), y ese ya no reserva nada.
    const schedules = await total(
      tx.select({ total: count() }).from(professionalSchedule).where(and(eq(professionalSchedule.organizationId, orgId), eq(professionalSchedule.isActive, true))),
    )
    if (schedules === 0) out.push({ text: "Ningún profesional tiene horario de atención. Sin horario, ni el agente ni el enlace ofrecen citas; el equipo puede reservar igual, con una advertencia.", ...at("disponibilidad") })
    const services = await total(tx.select({ total: count() }).from(serviceCatalog).where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.isActive, true))))
    if (services === 0) out.push({ text: "Todavía no hay servicios en la clínica; las citas se pueden reservar, pero sin servicio ni duración sugerida.", ...at("servicios") })
  }
  if (topic.id === "bandeja" || topic.id === "canales") {
    const channels = await total(tx.select({ total: count() }).from(channelConnection).where(and(eq(channelConnection.organizationId, orgId), eq(channelConnection.status, "active"))))
    if (channels === 0) out.push({ text: "No hay ningún canal conectado: no pueden llegar ni salir mensajes.", ...at("canales") })
  }
  if (topic.id === "agente" || topic.id === "administrador") {
    const [cfg] = await tx.select({ enabled: agentConfig.enabled, personaName: agentConfig.personaName, advisor: agentConfig.advisor }).from(agentConfig).where(eq(agentConfig.organizationId, orgId)).limit(1)
    if (!cfg?.enabled) out.push({ text: `${receptionName(cfg?.personaName)} está apagada: no responde ni escribe hasta que la enciendas.`, ...at("agente") })
    if (topic.id === "administrador" && cfg?.advisor?.enabled !== true) out.push({ text: "Argos está apagado: no sale ningún recordatorio ni seguimiento hasta que lo enciendas.", ...at("administrador") })
  }
  return out
}

/**
 * Reserva la consulta antes de decidir: con el bloqueo de la persona, dos
 * preguntas a la vez no pasan juntas del tope diario. La fila se completa al
 * responder; si algo falla en medio, queda contada y sin respuesta.
 */
async function reserveAsk(tx: Db, orgId: string, userId: string, screen: string): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ayuda:${orgId}:${userId}`}))`)
  const since = new Date(Date.now() - 86_400_000)
  const [row] = await tx
    .select({ total: count() })
    .from(helpAsk)
    .where(and(eq(helpAsk.organizationId, orgId), eq(helpAsk.userId, userId), gte(helpAsk.createdAt, since)))
  if (Number(row?.total ?? 0) >= HELP_DAILY_LIMIT) {
    throw new ServiceError("HELP_LIMIT", 429, "Llegaste al tope de preguntas a Ariadna por hoy. Mañana vuelve a estar disponible.")
  }
  const [reserved] = await tx.insert(helpAsk).values({ organizationId: orgId, userId, screen }).returning({ id: helpAsk.id })
  if (!reserved) throw new Error("No se pudo registrar la consulta")
  return reserved.id
}

/**
 * La pregunta con «Sofi» donde la clínica dice el nombre que le puso a su
 * agente de recepción. Cambia solo el nombre: el resto queda como se escribió,
 * que es lo que lee Jev; la coincidencia exacta compara sin tildes ni signos.
 */
export function withGuideName(question: string, personaName: string | null | undefined): string {
  const name = normalizeForSearch(personaName ?? "").split(" ").filter(Boolean)
  if (name.length === 0 || name.join(" ") === normalizeForSearch(RECEPTION_DEFAULT_NAME)) return question
  // Solo con otras palabras: «¿Dónde veo a Ana?» también puede ser una paciente que se llama igual.
  if (helpWordCount(question) <= name.length) return question
  const words = [...question.matchAll(/[\p{L}\p{M}\p{N}]+/gu)]
  for (let at = 0; at + name.length <= words.length; at += 1) {
    const span = words.slice(at, at + name.length)
    if (span.every((word, index) => normalizeForSearch(word[0]) === name[index])) {
      const start = span[0]?.index ?? 0
      const last = span[span.length - 1]
      const end = (last?.index ?? 0) + (last?.[0].length ?? 0)
      return `${question.slice(0, start)}${RECEPTION_DEFAULT_NAME}${question.slice(end)}`
    }
  }
  return question
}

/** Lo que se le pregunta a una pantalla por su nombre: «Agenda», «¿Qué es Configuración › Etapas de venta?». */
const screenAsks = (topic: HelpTopic) =>
  [topic.title, helpTopicLabel(topic), ...(topic.menuLabel ? [topic.menuLabel] : [])]
    .flatMap((name) => [name, `¿Qué es ${name}?`])
    .map(normalizeForSearch)

/**
 * Lo escrito igual que en la guía responde sin modelo: una pregunta frecuente o
 * una de sus formas, o el nombre de una pantalla. Es lo que llega al tocar una
 * sugerencia o una de las respuestas que ofrece la duda.
 */
export function exactHelpOption(question: string, topics: readonly HelpTopic[]): HelpOption | null {
  const asked = normalizeForSearch(question)
  if (!asked) return null
  for (const topic of topics) {
    for (const faq of topic.faqs ?? []) {
      if ([faq.q, ...(faq.forms ?? [])].some((form) => normalizeForSearch(form) === asked)) return { kind: "faq", topic, faq }
    }
  }
  const topic = topics.find((item) => screenAsks(item).includes(asked))
  return topic ? { kind: "tema", topic } : null
}

/** Lo que se toca en la duda: escrito como en la guía, para que `exactHelpOption` lo reconozca. */
function choiceOf(option: HelpOption): HelpChoice {
  if (option.kind === "faq") return { question: option.faq.q, where: option.faq.general ? "" : helpTopicLabel(option.topic) }
  return { question: `¿Qué es ${helpTopicLabel(option.topic)}?`, where: helpTopicLabel(option.topic) }
}

const NOTHING: HelpSelection = { verdict: "ninguna", shown: [], offered: [], top: null }

/** Sin Jev, o si no respondió: solo una pregunta frecuente que las palabras reconozcan. Nunca el párrafo de la pantalla. */
function byWords(question: string, topics: readonly HelpTopic[]): HelpSelection {
  const [match] = matchHelpTopics(question, topics)
  return match?.faq ? { verdict: "seguro", shown: [{ kind: "faq", topic: match.topic, faq: match.faq }], offered: [], top: null } : NOTHING
}

/**
 * Cómo se decidió y, si no respondió nada, por qué: Jev dijo que no está
 * (`ninguna`), Jev no estaba o no pudo (`sin_jev`), o lo escrito puede ser el
 * dato de una persona y no se le preguntó (`dato`).
 */
type Decided = { via: (typeof HELP_ASK_VIA)[number]; selection: HelpSelection; why: "ninguna" | "sin_jev" | "dato" }

/** El código de un error, sin su texto: puede repetir lo que se preguntó. */
const errorCodeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : error instanceof Error ? error.name : "desconocido"
}

/**
 * Jev elige la respuesta de la guía con `help.v1`. Si falla, se niega o no da
 * probabilidades, deciden las palabras. Si da probabilidades y nada llega a
 * ofrecerse, es «ninguna»: Jev sí respondió.
 */
async function decideHelp(
  question: string,
  screenName: string | null,
  topics: readonly HelpTopic[],
  texts: ProductAgentTexts,
  decider: HelpDecider | null,
): Promise<Decided> {
  if (decider) {
    try {
      const candidates = helpCandidates(helpOptions(topics), question)
      const result = await decider.decide(helpState(question, screenName), [helpQuestion(candidates, texts)])
      const selection = readHelpSelection(result, candidates)
      if (selection.top !== null) {
        if (selection.verdict === "duda" && selection.offered.length === 0) return { via: "jev", selection: { ...NOTHING, top: selection.top }, why: "ninguna" }
        return { via: "jev", selection, why: "ninguna" }
      }
    } catch (error) {
      // La Ayuda sigue sin Jev; queda el código (una clave rechazada es CONFIG), nunca la pregunta.
      console.warn(`La Ayuda respondió sin Jev: ${errorCodeOf(error)}`)
    }
  }
  return { via: "respaldo", selection: byWords(question, topics), why: "sin_jev" }
}

/** Lo que dice cuando no responde, según por qué. */
const NOT_ANSWERED: Record<Decided["why"], string> = {
  ninguna: "Esto no está en la guía, y no quiero inventarlo.",
  sin_jev: "Ahora no puedo buscar bien en la guía.",
  dato: "No lo encontré en la guía. Si buscas a una persona o un número, usa «Buscar en todo».",
}

/** Lo que cuesta preguntarle a Argos desde la Ayuda (ADR 0085), dicho como está hoy. */
async function argosNoteOf(tx: Db, orgId: string): Promise<string | null> {
  // Es solo un aviso: si no se puede leer cuánto queda, no se promete nada y el botón sigue (en su propio
  // punto de guardado, para no dejar la transacción abortada).
  const allowance = await tx.transaction((point) => getArgosPanelAllowance(point, orgId)).catch(() => null)
  if (!allowance) return null
  if (!allowance.limited) return null
  if (allowance.remaining > 0) {
    return `Usa una de las preguntas a ${AGENT_NAMES.administrador} de este mes: ${allowance.remaining === 1 ? "te queda 1" : `te quedan ${allowance.remaining}`}.`
  }
  return allowance.autoPack
    ? `Ya usaste las preguntas a ${AGENT_NAMES.administrador} de este mes: al preguntarle se suma un paquete, como pidió la clínica.`
    : `Ya usaste las preguntas a ${AGENT_NAMES.administrador} de este mes: al preguntarle te dice cómo sumar más.`
}

const probabilityOf = (value: number | null): number | null =>
  value === null || !Number.isFinite(value) ? null : Math.min(1, Math.max(0, value))

/**
 * Responde una pregunta sobre cómo usar el sistema, con la guía del producto
 * de la clínica (ADR 0146). Lo que se lee de la clínica va en su transacción y
 * Jev responde fuera de ella. Lo que puede ser el dato de una persona (un
 * teléfono, un correo, un nombre suelto) no viaja a Jev. Deja constancia de la
 * pantalla, de la respuesta de la guía y de lo que decidió Jev, nunca del
 * texto de la pregunta.
 */
export async function askHelp(
  db: Db,
  orgId: string,
  asker: HelpAsker,
  input: { question: unknown; screen: unknown },
  decider: HelpDecider | null = null,
): Promise<HelpReply> {
  if (typeof input.question !== "string" || input.question.trim().length < 3) throw invalidField("question", "Escribe tu pregunta: al menos 3 caracteres.")
  const question = input.question.trim().slice(0, QUESTION_CHARS)
  const screen = typeof input.screen === "string" ? input.screen.slice(0, 200) : "/"
  const talk = helpSmallTalk(question)
  // Un saludo no es una consulta: no gasta del tope ni cuenta como algo que no supo.
  if (talk) return { askId: "", kind: "charla", say: talk, answers: [], blockers: [], choices: [], argos: false, argosNote: null, basedOn: "" }

  const ready = await withOrgContext(db, orgId, async (tx) => {
    const askId = await reserveAsk(tx, orgId, asker.userId, screen)
    const [config] = await tx.select({ personaName: agentConfig.personaName }).from(agentConfig).where(eq(agentConfig.organizationId, orgId)).limit(1)
    return { askId, topics: await productHelpTopics(tx, orgId), texts: await productAgentTexts(tx, orgId), personaName: config?.personaName }
  })
  const { topics, askId } = ready
  const here = helpTopicForScreen(screen, topics)
  // La guía dice «Sofi»: una clínica que le puso otro nombre pregunta con el suyo.
  const asked = withGuideName(question, ready.personaName)
  const exact = exactHelpOption(asked, topics)
  const decided: Decided = exact
    ? { via: "exacta", selection: { verdict: "seguro", shown: [exact], offered: [], top: null }, why: "ninguna" }
    : mayIdentifySomeone(question)
      ? { via: "respaldo", selection: byWords(asked, topics), why: "dato" }
      : await decideHelp(asked, helpScreenName(screen, topics), topics, ready.texts, decider)
  const { selection } = decided
  const first = selection.shown[0]

  return withOrgContext(db, orgId, async (tx) => {
    const log = async (topicId: string | null, faq: string | null = null) => {
      const verdict = decided.via === "jev" ? (selection.verdict satisfies (typeof HELP_ASK_VERDICTS)[number]) : null
      const [row] = await tx
        .update(helpAsk)
        .set({ topicId, faq, via: decided.via, verdict, probability: decided.via === "jev" ? probabilityOf(selection.top) : null })
        .where(and(eq(helpAsk.organizationId, orgId), eq(helpAsk.id, askId)))
        .returning({ id: helpAsk.id })
      if (!row) throw new Error("No se pudo registrar la consulta")
      return row.id
    }
    const reply = (kind: HelpReply["kind"], parts: Partial<HelpReply> & { askId: string }): HelpReply => ({
      kind,
      say: null,
      answers: [],
      blockers: [],
      choices: [],
      argos: false,
      argosNote: null,
      basedOn: "",
      ...parts,
    })

    // «¿Por qué no puedo…?»: lo que falta de verdad en lo que eligió Jev (o, si no eligió, en lo que reconocen las
    // palabras); si no nombró nada, en la pantalla donde está. Lo que no es de una pantalla (el dictado, su
    // contraseña) no depende de lo que falte en ella.
    const general = first?.kind === "faq" && first.faq.general
    if (WHY_NOT.test(normalizeForSearch(question)) && !general) {
      const about = first?.topic ?? selection.offered[0]?.topic ?? matchHelpTopics(asked, topics)[0]?.topic ?? here
      const blockers = await screenBlockers(tx, orgId, about, asker, topics)
      if (blockers.length > 0) {
        return reply("estado", {
          askId: await log(about?.id ?? null),
          blockers,
          basedOn: `Lo que tu clínica tiene configurado ahora y lo que tu rol puede hacer${about ? ` en ${about.title}` : ""}.`,
        })
      }
    }

    if (selection.verdict === "seguro" && first) {
      const answers = selection.shown.map((option): HelpAnswer => {
        // Lo que no es de una pantalla (quién es Ariadna, su contraseña) no lleva a ninguna.
        if (option.kind === "faq" && option.faq.general) return { topicId: option.topic.id, where: "", text: option.faq.a, path: null, restriction: null }
        const access = restrictionFor(option.topic, asker)
        // Quien solo ve lo suyo la encuentra con el nombre de su menú: «Gestión › Mis honorarios».
        const where = helpTopicLabel(option.topic, { own: asker.canOpen(option.topic.path) && !canChange(option.topic, asker) })
        return { topicId: option.topic.id, where, text: helpAnswerText(option, where), ...access }
      })
      const places = [...new Set(answers.map((answer) => answer.where).filter(Boolean))]
      return reply("guia", {
        askId: await log(first.topic.id, first.kind === "faq" ? first.faq.q : null),
        answers,
        basedOn: places.length > 0 ? `El mapa del sistema: ${places.join(" y ")}.` : "La guía del sistema.",
      })
    }

    if (selection.verdict === "duda") {
      return reply("duda", {
        askId: await log(null),
        say: "No estoy segura de qué preguntas. ¿Es alguna de estas?",
        choices: selection.offered.map(choiceOf),
      })
    }

    if (selection.verdict === "datos") {
      const reports = helpTopic("reportes", topics)
      const seesReports = asker.can("reports.read")
      const argosOn = seesReports && (await getAdminSettings(tx, orgId)).enabled
      await log(null)
      if (argosOn) {
        return reply("datos", {
          askId,
          argos: true,
          argosNote: await argosNoteOf(tx, orgId),
          say: `Eso es de las cifras de tu clínica: te lo responde ${AGENT_NAMES.administrador}, con las mismas cuentas de Reportes.`,
        })
      }
      if (seesReports && reports) {
        const access = restrictionFor(reports, asker)
        return reply("datos", {
          askId,
          say: `Eso es de las cifras de tu clínica, y no está en la guía. Las ves en Reportes; ${AGENT_NAMES.administrador}, que las responde, está apagado.`,
          answers: [{ topicId: reports.id, where: helpTopicLabel(reports), text: "", ...access }],
        })
      }
      const roles = asker.whoCan("reports.read")
      return reply("datos", {
        askId,
        say: `Eso es de las cifras de tu clínica, y no está en la guía.${roles.length ? ` Pídeselo a quien ve Reportes: ${list(roles)}.` : ""}`,
      })
    }

    return reply("nada", { askId: await log(null), say: NOT_ANSWERED[decided.why] })
  })
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
export function describeHelpScreen(
  screen: string,
  topics?: readonly HelpTopic[],
): { title: string | null; suggestions: string[] } {
  // En la pantalla se nombra como la llama su menú («Mis honorarios»), no como el tema.
  const topic = helpTopicForScreen(screen, topics)
  return { title: topic ? (topic.menuLabel ?? topic.title) : null, suggestions: helpSuggestions(screen, topics) }
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
  if (typeof input.question !== "string" || input.question.trim().length < 3) throw invalidField("question", "Escribe lo que quieres enviar: al menos 3 caracteres.")
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
