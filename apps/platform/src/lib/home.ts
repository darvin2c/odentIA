/**
 * Los textos de Inicio. El servidor entrega «Te espera» ya ordenado y lo de
 * hoy ya resumido (`/api/workspace/home`); aquí solo se escribe cada fila con
 * las palabras de la pantalla. Ninguna regla de qué espera o qué se debe vive
 * en este archivo.
 */
import { formatMoney } from "@odentia/clinical"
import { AGENT_CASE_ROW, urgencyWord } from "./agent"
import { channelLabel } from "./channels"
import { timeAgo } from "./crm"
import { dayKeyOf, daysBetween, formatClock, formatWeekdayDay } from "./finance-cash"
import type { WaitingRow, WorkspaceTodaySummary } from "./workspace"

/** Filas de «Te espera» a la vista en teléfono; el resto se abre con «Ver las otras N». */
export const PHONE_ROWS = 5

export interface HomeTextContext {
  /** Día de la clínica (`YYYY-MM-DD`), como lo entrega el servidor. */
  today: string
  timezone: string
  locale: string
  /** Quien mira ve las tareas de todo el equipo. */
  allTasks: boolean
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

/** Título, detalle y acción de una fila de «Te espera». */
export function waitingText(row: WaitingRow, context: HomeTextContext): { title: string; detail: string; action: string } {
  switch (row.kind) {
    case "staleEncounter": {
      const missing = row.missing.map((key) => CLOSING_WORDS[key] ?? key)
      return {
        title: `La atención de ${row.patientName} quedó sin cerrar`,
        detail: joined([
          `${daysAgo(row.startedAt, context)} ${formatClock(row.startedAt, context.locale, context.timezone)}`,
          missing.length > 0 ? `le falta ${listed(missing)}` : "lista para firmar",
        ]),
        action: "Continuar",
      }
    }
    case "case":
      return {
        title: row.contactName ? `${row.contactName} · ${row.reason}` : row.reason,
        // Un solo nombre y una sola escala: «Te lo pasó el agente hace 25 min · Ahora».
        detail: joined([`${AGENT_CASE_ROW} ${ago(row.createdAt)}`, urgencyWord(row.priority), row.channel ? channelLabel(row.channel) : null]),
        action: !row.conversationId ? "Revisar" : row.unclaimed ? "Tomar" : "Ver el caso",
      }
    case "unconfirmed":
      // Quien no recibe recordatorios se llama el día antes (ADR 0040).
      if (row.why === "sin_recordatorios") {
        return {
          title: `${row.patientName} no recibe recordatorios: llámala para confirmar su cita de mañana ${formatClock(row.startsAt, context.locale, context.timezone)}`,
          detail: joined([row.phone, row.serviceName, row.branchName]),
          action: "Ver la cita",
        }
      }
      return {
        title: `${row.patientName} no confirmó · llamar`,
        detail: joined([row.phone, `Cita ${appointmentWhen(row.startsAt, context)}`, row.serviceName, row.branchName]),
        action: "Ver la cita",
      }
    case "conversations":
      return {
        title: row.waiting === 1 ? "1 persona espera respuesta" : `${row.waiting} personas esperan respuesta`,
        detail: row.oldestAt ? `${row.waiting === 1 ? "Escribió" : "La más antigua,"} ${ago(row.oldestAt)}` : "Sin responder en la Bandeja",
        action: "Abrir Bandeja",
      }
    case "stillOpen":
      return {
        title: row.total === 1 && row.contactName
          ? `La conversación con ${row.contactName} sigue abierta`
          : `${row.total} conversaciones siguen abiertas`,
        detail: joined([
          row.quietSince ? `Sin mensajes desde ${ago(row.quietSince)}` : null,
          row.total === 1 ? "ciérrala con «Resolver» o escríbele" : "ciérralas con «Resolver» o escríbeles",
        ]),
        action: row.total === 1 ? "Abrir" : "Abrir Bandeja",
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
        // Dice quién lo haría si se prende: el agente o una persona del equipo.
        detail: joined(["Lo recomienda el administrador", row.actor === "agente" ? "puede escribirles el agente" : "le tocaría a tu equipo", row.detail]),
        action: row.actor === "agente" ? "Ver la propuesta" : "Ver la lista",
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
        action: "Ver cuáles",
      }
    case "unsentBudget":
      return {
        title: `Presupuesto de ${row.patientName} sin enviar`,
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
          title: `Alguien se registró con el documento de ${row.patientName}: revisa si es ella`,
          detail: joined([`Desde el registro en línea ${ago(row.createdAt)}`, row.detail]),
          action: `Ver a ${row.patientName}`,
        }
      }
      if (row.source === "representante") {
        return {
          title: `¿${row.personName ?? "Esta persona"} es representante de ${row.patientName}?`,
          detail: joined([`Desde el registro en línea ${ago(row.createdAt)}`, row.detail]),
          action: "Revisar",
        }
      }
      return {
        title: `Posible ficha repetida: ${row.patientName}`,
        detail: joined([`Desde su enlace ${ago(row.createdAt)}`, row.detail]),
        action: "Revisar",
      }
    case "portalReentry":
      return {
        title: `${row.contactName} quiere volver a entrar al portal`,
        detail: joined([`Lo pidió ${ago(row.createdAt)}`, "su acceso sigue vigente"]),
        action: "Enviar nuevo enlace",
      }
    case "consentToPublish":
      return {
        title: `Publicar el consentimiento de «${row.title}»`,
        detail: row.requestedByName ? `Lo pidió ${row.requestedByName}` : "Lo pidió una atención",
        action: "Abrir los consentimientos",
      }
    case "promotion":
      return {
        title: `WhatsApp considera "${row.title}" como promoción: solo se enviará a quien aceptó novedades.`,
        detail: "Cambia el texto para que sea solo el aviso.",
        action: "Cambiar el texto",
      }
    case "more":
      if (row.of === "cases") {
        return {
          title: row.count === 1 ? "1 caso más del agente" : `${row.count} casos más del agente`,
          detail: "Siguen sin resolver",
          action: "Ver todos",
        }
      }
      if (row.of === "unconfirmed") {
        return {
          title: row.count === 1 ? "1 cita más sin confirmar" : `${row.count} citas más sin confirmar`,
          detail: "Tras el recordatorio del agente",
          action: "Abrir la Agenda",
        }
      }
      if (row.of === "unsentBudgets") {
        return {
          title: row.count === 1 ? "1 presupuesto más sin enviar" : `${row.count} presupuestos más sin enviar`,
          detail: "Se envían desde el Plan de cada persona",
          action: "Ver personas",
        }
      }
      return {
        title: row.count === 1 ? "1 tarea más" : `${row.count} tareas más`,
        detail: context.allTasks ? "Abiertas en el equipo" : "Tuyas y de tu área",
        action: "Ver tareas",
      }
  }
}

/**
 * Lo que hace pulsar la fila cuando la acción rápida («Tomar», «Hecha») va en
 * su propio botón: la fila sigue nombrando a dónde lleva, también para el
 * lector de pantalla. Un caso se abre con «Ver el caso» aunque nadie lo haya
 * tomado: tomarlo es el botón de al lado.
 */
export function waitingOpenText(row: WaitingRow, context: HomeTextContext): string {
  if (row.kind === "case" && row.conversationId) return "Ver el caso"
  return waitingText(row, context).action
}

type DuplicateRow = Extract<WaitingRow, { kind: "possibleDuplicate" }>

/**
 * Los botones de una fila de documento repetido, además de la fila que lleva
 * a la persona: el representante por confirmar ofrece «Confirmar» y «No es
 * ella»; quien se registró con el documento de otra, «Descartar»; la posible
 * ficha repetida de «Su enlace», «Revisada».
 */
export function duplicateActions(row: DuplicateRow): { id: "confirmar" | "descartar" | "revisada"; label: string; primary: boolean }[] {
  if (row.source === "representante") {
    return [
      { id: "confirmar", label: "Confirmar", primary: true },
      { id: "descartar", label: "No es ella", primary: false },
    ]
  }
  if (row.source === "registro") return [{ id: "descartar", label: "Descartar", primary: false }]
  return [{ id: "revisada", label: "Revisada", primary: false }]
}

/** Identidad estable de una fila para React. */
export function waitingKey(row: WaitingRow): string {
  if (row.kind === "case" || row.kind === "task" || row.kind === "unconfirmed" || row.kind === "staleEncounter" || row.kind === "unsentBudget" || row.kind === "possibleDuplicate" || row.kind === "portalReentry") return `${row.kind}:${row.id}`
  if (row.kind === "advice") return `advice:${row.key}`
  if (row.kind === "consentToPublish") return `consentToPublish:${row.templateKey}`
  if (row.kind === "promotion") return `promotion:${row.messageId}`
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
