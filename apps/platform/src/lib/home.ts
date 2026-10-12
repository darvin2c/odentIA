/**
 * Los textos de Inicio. El servidor entrega «Te espera» ya ordenado y lo de
 * hoy ya resumido (`/api/workspace/home`); aquí solo se escribe cada fila con
 * las palabras de la pantalla. Ninguna regla de qué espera o qué se debe vive
 * en este archivo.
 */
import { ACTION_LABEL } from "./agent"
import { channelLabel } from "./channels"
import { timeAgo } from "./crm"
import { dayKeyOf, daysBetween } from "./finance-cash"
import type { WaitingRow, WorkspaceToday } from "./workspace"

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

/** De quién o para quién es lo que propone el agente, dicho como tarea. */
function proposalTitle(row: Extract<WaitingRow, { kind: "proposal" }>): string {
  const patient = row.patientName ?? row.contactName
  const label = ACTION_LABEL[row.action] ?? row.action
  if (row.action === "enviar_mensaje") return row.contactName ? `Mensaje para ${row.contactName}` : label
  if (!patient) return label
  if (row.action === "reservar_cita") return `Reservar una cita para ${patient}`
  if (row.action === "reprogramar_cita") return `Cambiar la cita de ${patient}`
  if (row.action === "cancelar_cita") return `Cancelar la cita de ${patient}`
  return `${label}: ${row.contactName ?? patient}`
}

/** Título, detalle y acción de una fila de «Te espera». */
export function waitingText(row: WaitingRow, context: HomeTextContext): { title: string; detail: string; action: string } {
  switch (row.kind) {
    case "case":
      return {
        title: row.contactName ? `${row.contactName}: ${row.reason}` : row.reason,
        detail: joined(["Caso que pasó el agente", row.channel ? channelLabel(row.channel) : null, timeAgo(row.createdAt)]),
        action: row.conversationId ? "Ver el caso" : "Revisar",
      }
    case "proposal":
      return {
        title: proposalTitle(row),
        detail: joined(["El agente espera tu aprobación", row.summary, timeAgo(row.createdAt)]),
        action: "Revisar",
      }
    case "conversations":
      return {
        title: row.waiting === 1 ? "1 persona espera respuesta" : `${row.waiting} personas esperan respuesta`,
        detail: row.oldestAt ? `${row.waiting === 1 ? "Escribió" : "La más antigua escribió"} ${timeAgo(row.oldestAt)}` : "Sin responder en la Bandeja",
        action: "Abrir la Bandeja",
      }
    case "task":
      return {
        title: row.title,
        detail: joined([
          row.mine ? "Tarea tuya" : "Tarea",
          dueText(row, context),
          row.mine ? null : (row.assigneeName ?? "Sin responsable"),
          row.more > 0 ? `y ${plural(row.more, "tarea", "tareas")} más${context.allTasks ? " del equipo" : ""}` : null,
        ]),
        action: row.more > 0 ? "Ver tareas" : "Abrir",
      }
    case "advice":
      return { title: row.title, detail: joined(["Lo recomienda el asesor", row.detail]), action: "Ver la lista" }
    case "budgets":
      return {
        title: row.total === 1 ? "1 presupuesto espera respuesta" : `${row.total} presupuestos esperan respuesta`,
        detail: row.oldestPresentedAt
          ? `${row.total === 1 ? "Se presentó" : "El más antiguo se presentó"} ${daysAgo(row.oldestPresentedAt, context)}`
          : "Aún sin fecha de presentación",
        action: "Ver cuáles",
      }
    case "more":
      if (row.of === "proposals") {
        return {
          title: row.count === 1 ? "1 cambio más espera tu aprobación" : `${row.count} cambios más esperan tu aprobación`,
          detail: "Los propuso el agente",
          action: "Ver todos",
        }
      }
      if (row.of === "cases") {
        return {
          title: row.count === 1 ? "1 caso más que pasó el agente" : `${row.count} casos más que pasó el agente`,
          detail: "Siguen sin resolver",
          action: "Ver todos",
        }
      }
      return {
        title: row.count === 1 ? "1 tarea más" : `${row.count} tareas más`,
        detail: context.allTasks ? "Abiertas en el equipo" : "Abiertas y asignadas a ti",
        action: "Ver tareas",
      }
  }
}

/** Identidad estable de una fila para React. */
export function waitingKey(row: WaitingRow): string {
  if (row.kind === "case" || row.kind === "proposal" || row.kind === "task") return `${row.kind}:${row.id}`
  if (row.kind === "advice") return `advice:${row.key}`
  if (row.kind === "more") return `more:${row.of}`
  return row.kind
}

/** «24 citas · 6 atendidas · 18 por venir, 2 sin confirmar». */
export function agendaSummary(summary: WorkspaceToday["summary"]): string {
  const upcoming = `${summary.upcoming} por venir${summary.unconfirmed > 0 ? `, ${summary.unconfirmed} sin confirmar` : ""}`
  return joined([plural(summary.total, "cita", "citas"), plural(summary.attended, "atendida", "atendidas"), upcoming])
}

/** «8 pacientes · 2 atendidos · 6 por venir». */
export function patientsSummary(summary: WorkspaceToday["summary"]): string {
  return joined([plural(summary.total, "paciente", "pacientes"), plural(summary.attended, "atendido", "atendidos"), `${summary.upcoming} por venir`])
}

/** Parte del día ya atendida, para la barra decorativa (0 a 100). */
export function attendedPercent(summary: WorkspaceToday["summary"]): number {
  return summary.total > 0 ? Math.round((summary.attended / summary.total) * 100) : 0
}

/** El estado de una cita en pie, con palabras: nunca solo con color. */
export function appointmentState(status: string): string {
  if (status === "atendida") return "Atendida"
  return status === "confirmada" ? "Confirmada" : "Sin confirmar"
}

/** «Lunes 12 de octubre» a partir del día de la clínica, sin desplazarlo por zona. */
export function longDay(day: string, locale: string): string {
  const date = new Date(`${day}T12:00:00`)
  if (Number.isNaN(date.getTime())) return day
  const text = date.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" }).replace(",", "")
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1)
}
