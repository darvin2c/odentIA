/**
 * Los textos de Inicio. El servidor entrega «Te espera» ya ordenado y lo de
 * hoy ya resumido (`/api/workspace/home`); aquí solo se escribe cada fila con
 * las palabras de la pantalla. Ninguna regla de qué espera o qué se debe vive
 * en este archivo.
 */
import { formatMoney } from "@odentia/clinical"
import { agentCaseRow } from "./agent"
import { ADMIN_NAME, withReceptionName } from "./agent-names"
import { channelLabel } from "./channels"
import { dayWords } from "./data-requests"
import { timeAgo } from "./crm"
import { dayKeyOf, daysBetween, formatClock, formatWeekdayDay } from "./finance-cash"
import type { WaitingRow, WorkspaceTodaySummary } from "./workspace"

/** Filas de «Hoy» a la vista en teléfono; el resto se abre con «Ver los otros N de hoy». */
export const PHONE_ROWS = 3

/** Lo que pidió, dicho en la fila de «Te espera»: «Rosa Quispe pidió una copia de su historia». */
const DATA_REQUEST_PHRASE = {
  copia: "una copia de su historia",
  corregir: "corregir un dato",
  mensajes: "no recibir mensajes",
  borrar: "borrar sus datos",
} as const

export interface HomeTextContext {
  /** Día de la clínica (`YYYY-MM-DD`), como lo entrega el servidor. */
  today: string
  timezone: string
  locale: string
  /** Quien mira ve las tareas de todo el equipo. */
  allTasks: boolean
  /** El nombre del agente de recepción en esta clínica (`useReceptionName`). */
  receptionName: string
  /** Puede registrar una atención; a quien no, la cita sin cerrar le dice quién la registra. */
  canAttend?: boolean
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
const joined = (parts: Array<string | null | false | undefined>) => parts.filter(Boolean).join(" · ")

/** «hoy», «ayer» o «hace N días», contando días de calendario de la clínica. */
export function daysAgo(iso: string, context: Pick<HomeTextContext, "today" | "timezone">): string {
  const days = daysBetween(dayKeyOf(iso, context.timezone), context.today)
  if (days <= 0) return "hoy"
  return days === 1 ? "ayer" : `hace ${days} días`
}

function dueText(row: Extract<WaitingRow, { kind: "task" }>, context: HomeTextContext): string {
  if (row.due === "none" || !row.dueAt) return "sin fecha"
  if (row.due === "overdue") return `venció ${daysAgo(row.dueAt, context)}`
  if (row.due === "today") return "para hoy"
  if (daysBetween(context.today, dayKeyOf(row.dueAt, context.timezone)) === 1) return "para mañana"
  return `para el ${new Date(row.dueAt).toLocaleDateString(context.locale, { day: "numeric", month: "long", timeZone: context.timezone })}`
}

/** «hace 25 min», «ayer»…, o «hace un momento» si acaba de pasar. */
function ago(iso: string): string {
  const text = timeAgo(iso)
  return !text || text === "ahora" ? "hace un momento" : text
}

/** «hoy 10:30», «mañana 10:30» o «jueves 17 de octubre, 10:30», con la hora y la zona de la clínica. */
export function appointmentWhen(iso: string, context: Pick<HomeTextContext, "today" | "timezone" | "locale">): string {
  const time = formatClock(iso, context.locale, context.timezone)
  const days = daysBetween(context.today, dayKeyOf(iso, context.timezone))
  if (days === 0) return `hoy ${time}`
  if (days === 1) return `mañana ${time}`
  return `${formatWeekdayDay(iso, context.locale, context.timezone)}, ${time}`
}

/** Lo que le falta a una atención para cerrarse, con las palabras del cierre. */
const CLOSING_WORDS: Record<string, string> = {
  reason: "el motivo",
  diagnosis: "el diagnóstico",
  evolution: "la evolución",
  signature: "tu colegiatura",
}

/** «el diagnóstico y la evolución». */
function listed(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ""
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`
}

/** Lo que se escribe en una fila: quién, qué pidió o qué pasa, lo demás y su único botón. */
export interface WaitingText {
  title: string
  /** Lo que pidió o lo que pasa, en una frase. */
  ask?: string | null
  detail: string
  /** Lo que dice su botón; vacío si quien mira no puede hacer nada (lo tiene otra persona). */
  action: string
}

/** Lo que dice cada fila de «Te espera». */
export function waitingText(row: WaitingRow, context: HomeTextContext): WaitingText {
  switch (row.kind) {
    case "registrationDone":
      return {
        title: row.patientName,
        ask: "Terminó su registro",
        detail: `Tiene cita hoy a las ${formatClock(row.startsAt, context.locale, context.timezone)}${row.professionalName ? ` con ${row.professionalName}` : ""}`,
        action: "Llegó",
      }
    case "staleEncounter": {
      const missing = row.missing.map((key) => CLOSING_WORDS[key] ?? key)
      return {
        title: row.patientName,
        ask: `Su atención de ${daysAgo(row.startedAt, context)} ${formatClock(row.startedAt, context.locale, context.timezone)} quedó sin firmar`,
        detail: missing.length > 0 ? `Falta ${listed(missing)}` : "Lista para firmar",
        action: "Revisar",
      }
    }
    case "case":
      return {
        title: row.contactName ?? withReceptionName(row.reason, context.receptionName),
        // Lo que preguntó dice más que el motivo; el motivo lo escribe el servidor y nombra a «Sofi».
        ask: row.quote ?? (row.contactName ? withReceptionName(row.reason, context.receptionName) : null),
        // «Te lo pasó Sofi hace 25 min · WhatsApp»; la urgencia ya la dice el grupo.
        detail: joined([`${agentCaseRow(context.receptionName)} ${ago(row.createdAt)}`, row.channel ? channelLabel(row.channel) : null, row.assigneeName ? `Con ${row.assigneeName}` : null]),
        action: !row.conversationId ? "Ver la tarea" : row.canReply ? "Responder" : row.windowClosed && !row.assigneeName ? "Escribirle" : row.assigneeName ? "" : "Ver el caso",
      }
    case "person":
      return {
        title: row.contactName ?? "Persona sin nombre",
        ask: row.quote,
        detail: joined([`Escribió ${ago(row.since)}`, row.channel ? channelLabel(row.channel) : null]),
        action: row.windowClosed ? "Escribirle" : "Responder",
      }
    case "unconfirmed":
      // Quien no recibe recordatorios se llama el día antes (ADR 0040).
      return {
        title: row.patientName,
        ask:
          row.why === "sin_recordatorios"
            ? `No recibe recordatorios: confirma su cita de ${appointmentWhen(row.startsAt, context)}`
            : `No confirmó su cita de ${appointmentWhen(row.startsAt, context)}`,
        detail: joined([row.phone, row.serviceName, row.branchName]),
        action: "Llamar",
      }
    case "unclosed": {
      // Sin cerrar, la cita no cuenta ni como atendida ni como «no vino».
      const who = context.canAttend === false && row.professionalName ? `Si vino, la registra ${row.professionalName}` : row.professionalName
      return {
        title: row.patientName,
        ask: `Su cita de ${daysAgo(row.startsAt, context)} a las ${formatClock(row.startsAt, context.locale, context.timezone)} quedó sin cerrar`,
        detail: joined([who, row.serviceName]),
        action: "¿Vino?",
      }
    }
    case "acceptedUnbooked":
      return {
        title: plural(row.patients, "persona aceptó su presupuesto y no tiene cita", "personas aceptaron su presupuesto y no tienen cita"),
        detail: `${formatMoney(row.cents, row.currency, context.locale)} por hacer`,
        action: "Agendar",
      }
    case "stillOpen":
      return row.total === 1 && row.contactName
        ? {
            title: row.contactName,
            ask: "Su conversación sigue abierta",
            detail: joined([row.quietSince ? `Sin mensajes desde ${ago(row.quietSince)}` : null, "escríbele o ciérrala"]),
            action: "Revisar",
          }
        : {
            title: `${row.total} conversaciones siguen abiertas`,
            detail: joined([row.quietSince ? `Sin mensajes desde ${ago(row.quietSince)}` : null, "escríbeles o ciérralas"]),
            action: "Abrir la Bandeja",
          }
    case "task":
      return {
        title: row.title,
        detail: joined([
          dueText(row, context).replace(/^./, (first) => first.toUpperCase()),
          row.opportunityTitle ? `Oportunidad «${row.opportunityTitle}»` : null,
          row.mine ? null : (row.assigneeName ?? "Sin responsable"),
          row.more > 0 ? `y ${plural(row.more, "tarea", "tareas")} más${context.allTasks ? " del equipo" : ""}` : null,
        ]),
        action: row.more > 0 ? "Ver tareas" : "Abrir",
      }
    case "advice":
      return {
        title: row.title,
        // Dice quién lo haría si se prende: Argos (con sus líneas) o una persona del equipo.
        detail: joined([`Lo recomienda ${ADMIN_NAME}`, row.actor === "agente" ? `puede escribirles ${context.receptionName}` : "le tocaría a tu equipo", row.detail]),
        action: "Ver",
      }
    case "unreached":
      return {
        title: row.total === 1 ? "El agente no pudo escribirle a 1 persona" : `El agente no pudo escribirle a ${row.total} personas`,
        detail: joined([row.byCause.map((item) => `${item.total} ${item.reason}`).join(", "), "dice cómo habilitar a cada una"]),
        action: "Ver",
      }
    case "budgets":
      return {
        title: row.total === 1 ? "1 presupuesto espera respuesta" : `${row.total} presupuestos esperan respuesta`,
        detail: row.oldestPresentedAt
          ? `${row.total === 1 ? "Se presentó" : "El más antiguo se presentó"} ${daysAgo(row.oldestPresentedAt, context)}`
          : "Aún sin fecha de presentación",
        action: "Ver",
      }
    case "unsentBudget":
      return {
        title: row.patientName,
        ask: "Su presupuesto sigue sin enviar",
        detail: joined([
          `Armado ${daysAgo(row.since, context)}`,
          plural(row.itemCount, "tratamiento", "tratamientos"),
          row.totalCents != null ? formatMoney(row.totalCents, row.currency, context.locale) : null,
          row.options > 1 ? `${row.options} opciones` : null,
        ]),
        action: "Enviar",
      }
    case "possibleDuplicate":
      if (row.source === "registro") {
        return {
          title: row.patientName,
          ask: row.held ? "Se registró por el código QR: ¿es la misma persona?" : "Alguien se registró con su documento: revisa si es la misma persona",
          detail: `${row.held ? "Desde el código QR" : "Desde el registro en línea"} ${ago(row.createdAt)}`,
          action: "Revisar",
        }
      }
      if (row.source === "representante") {
        return {
          title: row.personName ?? "Esta persona",
          ask: `¿Es representante de ${row.patientName}?`,
          detail: `Desde el registro en línea ${ago(row.createdAt)}`,
          action: "Revisar",
        }
      }
      return {
        title: row.patientName,
        ask: "Posible ficha repetida",
        detail: `Desde su enlace ${ago(row.createdAt)}`,
        action: "Revisar",
      }
    case "dataRequest":
      return {
        title: row.patientName,
        ask: `Pidió ${DATA_REQUEST_PHRASE[row.request]}`,
        detail: joined([
          row.dueOn < context.today ? `Venció el ${dayWords(row.dueOn, context.locale)}` : `Responder hasta el ${dayWords(row.dueOn, context.locale)}`,
          row.verified ? null : "falta comprobar que es ella",
        ]),
        action: "Atender el pedido",
      }
    case "portalReentry":
      return {
        title: row.contactName,
        ask: "Quiere volver a entrar al portal",
        detail: joined([`Lo pidió ${ago(row.createdAt)}`, "su acceso sigue vigente"]),
        action: "Enviar nuevo enlace",
      }
    case "consentToPublish":
      return {
        title: `Activar el consentimiento de «${row.title}»`,
        detail: row.requestedByName ? `Lo pidió ${row.requestedByName}` : "Lo pidió una atención",
        action: "Activar",
      }
    case "inventory": {
      const needed = row.needed > 0 ? `${plural(row.needed, "producto hace falta", "productos hacen falta")}` : null
      const expired = row.expiredLots > 0 ? `${plural(row.expiredLots, "lote venció", "lotes vencieron")}` : null
      return {
        title: `Inventario de ${row.branchName}`,
        detail: listed([needed, expired].filter((part): part is string => part !== null)),
        action: row.needed > 0 ? "Pedir" : "Ver",
      }
    }
    case "promotions":
      return {
        title: row.items.length === 1 ? "1 mensaje automático no le llega a todos" : `${row.items.length} mensajes automáticos no le llegan a todos`,
        detail: "WhatsApp los clasificó como publicidad",
        action: "Arreglar",
      }
    case "more":
      if (row.of === "cases") {
        return {
          title: row.count === 1 ? `1 caso más de ${context.receptionName}` : `${row.count} casos más de ${context.receptionName}`,
          detail: "Siguen sin resolver",
          action: `Ver ${row.count} más`,
        }
      }
      if (row.of === "conversations") {
        return {
          title: row.count === 1 ? "1 persona más espera respuesta" : `${row.count} personas más esperan respuesta`,
          detail: "En la Bandeja",
          action: `Ver ${row.count} más`,
        }
      }
      if (row.of === "unconfirmed") {
        return {
          title: row.count === 1 ? "1 cita más sin confirmar" : `${row.count} citas más sin confirmar`,
          detail: "Tras el recordatorio del agente",
          action: `Ver ${row.count} más`,
        }
      }
      if (row.of === "unclosed") {
        return {
          title: row.count === 1 ? "1 cita más sin cerrar" : `${row.count} citas más sin cerrar`,
          detail: "De días anteriores: ¿vinieron?",
          action: `Ver ${row.count} más`,
        }
      }
      if (row.of === "unsentBudgets") {
        return {
          title: row.count === 1 ? "1 presupuesto más sin enviar" : `${row.count} presupuestos más sin enviar`,
          detail: "Se envían desde el Plan de cada persona",
          action: `Ver ${row.count} más`,
        }
      }
      return {
        title: row.count === 1 ? "1 tarea más" : `${row.count} tareas más`,
        detail: context.allTasks ? "Abiertas en el equipo" : "Tuyas y de tu área",
        action: `Ver ${row.count} más`,
      }
  }
}

/** Cierra una frase sin repetir el punto: «09:00 a. m.» y «¿es la misma persona?» ya terminan. */
export const sentence = (words: string): string => (/[.?!]$/.test(words) ? words : `${words}.`)

/** Lo que se dice de una fila plegada en otra: «también su cita sin cerrar». */
export function alsoWords(row: WaitingRow): string {
  switch (row.kind) {
    case "case":
    case "person":
      return "una pregunta"
    case "unclosed":
      return "su cita sin cerrar"
    case "unconfirmed":
      return "su cita sin confirmar"
    case "staleEncounter":
      return "su atención sin firmar"
    case "unsentBudget":
      return "su presupuesto sin enviar"
    case "registrationDone":
      return "su registro"
    case "portalReentry":
      return "volver al portal"
    case "possibleDuplicate":
      return "una revisión"
    case "task":
      return "una tarea"
    default:
      return "algo más"
  }
}

/** ¿Quien mira puede responder a esta fila? Sobre ella va «Siguiente» al enviar. */
export function repliable(row: WaitingRow): boolean {
  return (row.kind === "case" && row.canReply === true) || (row.kind === "person" && !row.windowClosed)
}

/** El nombre con que se dice a quién: «Responder: Carlos Paredes». */
export function replyName(row: WaitingRow): string | null {
  return row.kind === "case" || row.kind === "person" ? row.contactName : null
}

/** Identidad estable de una fila para React. */
export function waitingKey(row: WaitingRow): string {
  if (row.kind === "case" || row.kind === "task" || row.kind === "unconfirmed" || row.kind === "unclosed" || row.kind === "staleEncounter" || row.kind === "unsentBudget" || row.kind === "possibleDuplicate" || row.kind === "portalReentry" || row.kind === "dataRequest") return `${row.kind}:${row.id}`
  if (row.kind === "registrationDone") return `registrationDone:${row.appointmentId}`
  if (row.kind === "person") return `person:${row.conversationId}`
  if (row.kind === "advice") return `advice:${row.key}`
  if (row.kind === "consentToPublish") return `consentToPublish:${row.templateKey}`
  if (row.kind === "inventory") return `inventory:${row.branchId}`
  if (row.kind === "more") return `more:${row.of}`
  return row.kind
}

/** «12 citas · 2 en sala · 4 atendidas · 6 por venir»; «en atención» solo si hay alguien. */
export function agendaSummary(summary: WorkspaceTodaySummary): string {
  return joined([
    plural(summary.total, "cita", "citas"),
    `${summary.waiting} en sala`,
    summary.attending > 0 ? `${summary.attending} en atención` : null,
    plural(summary.attended, "atendida", "atendidas"),
    `${summary.upcoming} por venir`,
  ])
}

/** «8 pacientes · 1 en sala · 2 atendidos · 5 por venir». */
export function patientsSummary(summary: WorkspaceTodaySummary): string {
  return joined([
    plural(summary.total, "paciente", "pacientes"),
    summary.waiting > 0 ? `${summary.waiting} en sala` : null,
    plural(summary.attended, "atendido", "atendidos"),
    `${summary.upcoming} por venir`,
  ])
}

/** Parte del día ya atendida, para la barra decorativa (0 a 100). */
export function attendedPercent(summary: Pick<WorkspaceTodaySummary, "total" | "attended">): number {
  return summary.total > 0 ? Math.round((summary.attended / summary.total) * 100) : 0
}

/** «Lunes 12 de octubre» a partir del día de la clínica, sin desplazarlo por zona. */
export function longDay(day: string, locale: string): string {
  const date = new Date(`${day}T12:00:00`)
  if (Number.isNaN(date.getTime())) return day
  const text = date.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" }).replace(",", "")
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1)
}
