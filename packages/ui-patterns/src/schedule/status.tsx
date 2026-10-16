/**
 * El estado de la cita dicho una sola vez: punto, etiqueta, icono y clases del
 * bloque, con los tokens semánticos del tema. Un nombre por estado en toda la
 * aplicación (ADR 0032): «programada» se nombra por lo que le falta («Por
 * confirmar»), la inasistencia es «No vino», y llegar o estar en atención se
 * dicen aunque no sean estados guardados.
 */

import { cn } from "@odentia/ui"
import { Ban, Check, CheckCheck, Clock, DoorOpen, Stethoscope, UserX } from "lucide-react"

import type { ScheduleEntry, ScheduleState, ScheduleStatus } from "./types.js"

/** El nombre de cada estado, el mismo en la Agenda, Inicio, la ficha y el portal. */
export const SCHEDULE_STATE_LABELS: Record<ScheduleState, string> = {
  programada: "Por confirmar",
  confirmada: "Confirmada",
  llego: "Llegó",
  en_atencion: "En atención",
  atendida: "Atendida",
  no_asistio: "No vino",
  cancelada: "Cancelada",
}

/** Los estados guardados con su nombre (los mismos de `SCHEDULE_STATE_LABELS`). */
export const SCHEDULE_AGENDA_LABELS: Record<ScheduleStatus, string> = {
  programada: SCHEDULE_STATE_LABELS.programada,
  confirmada: SCHEDULE_STATE_LABELS.confirmada,
  atendida: SCHEDULE_STATE_LABELS.atendida,
  no_asistio: SCHEDULE_STATE_LABELS.no_asistio,
  cancelada: SCHEDULE_STATE_LABELS.cancelada,
}

/** Antes tenía otros nombres («Programada», «No asistió»): ahora es el mismo de toda la aplicación. */
export const SCHEDULE_STATUS_LABELS = SCHEDULE_AGENDA_LABELS

/** El estado que se dice de una cita: llegó o en atención mandan sobre el guardado. */
export function entryState(entry: Pick<ScheduleEntry, "status" | "stage">): ScheduleState {
  return entry.stage ?? entry.status
}

/** Lo que se lee de la cita: la etiqueta con su hora si la hay, o el nombre del estado. */
export function entryStateLabel(entry: Pick<ScheduleEntry, "status" | "stage" | "stateLabel">): string {
  return entry.stateLabel ?? SCHEDULE_STATE_LABELS[entryState(entry)]
}

/** Punto de estado: relleno en juego, anillo cerrado, discontinuo fuera de juego. */
export function StatusDot({ status, className }: { status: ScheduleState; className?: string }) {
  return (
    <span
      aria-hidden
      data-status={status}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        status === "programada" && "bg-warning",
        status === "confirmada" && "bg-success",
        status === "llego" && "bg-info",
        status === "en_atencion" && "bg-primary",
        status === "atendida" && "bg-muted-foreground",
        status === "no_asistio" && "border-2 border-destructive bg-transparent",
        status === "cancelada" && "border-2 border-dashed border-muted-foreground bg-transparent",
        className,
      )}
    />
  )
}

/** Orden en que se leen los estados en resúmenes y filtros. */
export const SCHEDULE_STATUS_ORDER: ScheduleStatus[] = [
  "programada",
  "confirmada",
  "atendida",
  "no_asistio",
  "cancelada",
]

const STATUS_ICONS = {
  programada: Clock,
  confirmada: Check,
  llego: DoorOpen,
  en_atencion: Stethoscope,
  atendida: CheckCheck,
  no_asistio: UserX,
  cancelada: Ban,
} as const

/** Color del icono y del texto de estado, con los tokens semánticos del tema. */
export function statusTextClass(status: ScheduleState): string {
  return cn(
    status === "programada" && "text-warning",
    status === "confirmada" && "text-success",
    status === "llego" && "text-info",
    status === "en_atencion" && "text-primary",
    status === "atendida" && "text-muted-foreground",
    status === "no_asistio" && "text-destructive",
    status === "cancelada" && "text-muted-foreground",
  )
}

/**
 * Superficie de la cita en rejilla y lista: el fondo dice el estado de un
 * vistazo (verde confirmada, ámbar por confirmar, azul llegó, petróleo en
 * atención, gris atendida) y el icono lo repite, para que nunca dependa solo
 * del color.
 */
export function statusSurfaceClass(status: ScheduleState): string {
  return cn(
    status === "programada" && "bg-warning-soft text-foreground",
    status === "confirmada" && "bg-success-soft text-foreground",
    status === "llego" && "bg-info-soft text-foreground",
    status === "en_atencion" && "bg-primary-soft text-foreground",
    status === "atendida" && "bg-secondary text-muted-foreground",
    status === "no_asistio" && "bg-danger-soft text-foreground",
    status === "cancelada" &&
      "border border-dashed border-border bg-transparent text-muted-foreground line-through",
  )
}

/** Icono del estado; decorativo salvo que se le dé nombre. */
export function StatusIcon({
  status,
  label,
  className,
}: {
  status: ScheduleState
  /** Nombre accesible cuando el icono va solo, sin el texto del estado al lado. */
  label?: string
  className?: string
}) {
  const Icon = STATUS_ICONS[status]
  return (
    <Icon
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      data-status={status}
      className={cn("size-4 shrink-0", statusTextClass(status), className)}
    />
  )
}
