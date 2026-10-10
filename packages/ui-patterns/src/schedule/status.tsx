/**
 * El estado de la cita dicho una sola vez: punto, etiqueta y clases del
 * bloque. Los colores semánticos siguen la convención de `badge` de
 * @odentia/ui (paleta Tailwind con par dark explícito) porque el theme no
 * tiene tokens info/success/warning; `primary` y `destructive` sí son tokens.
 */

import { cn } from "@odentia/ui"
import { Ban, Check, CheckCheck, Clock, UserX } from "lucide-react"

import type { ScheduleStatus } from "./types.js"

export const SCHEDULE_STATUS_LABELS: Record<ScheduleStatus, string> = {
  programada: "Programada",
  confirmada: "Confirmada",
  atendida: "Atendida",
  no_asistio: "No asistió",
  cancelada: "Cancelada",
}

/** Punto de estado: relleno en juego, anillo cerrado, discontinuo fuera de juego. */
export function StatusDot({ status, className }: { status: ScheduleStatus; className?: string }) {
  return (
    <span
      aria-hidden
      data-status={status}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        status === "programada" && "bg-sky-500",
        status === "confirmada" && "bg-emerald-500",
        status === "atendida" && "bg-primary",
        status === "no_asistio" && "border-2 border-amber-500 bg-transparent",
        status === "cancelada" && "border-2 border-dashed border-destructive bg-transparent",
        className,
      )}
    />
  )
}

/**
 * El estado como se dice en la agenda: «programada» se nombra por lo que le
 * falta, que es lo que recepción necesita saber de un vistazo.
 */
export const SCHEDULE_AGENDA_LABELS: Record<ScheduleStatus, string> = {
  programada: "Por confirmar",
  confirmada: "Confirmada",
  atendida: "Atendida",
  no_asistio: "No asistió",
  cancelada: "Cancelada",
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
  atendida: CheckCheck,
  no_asistio: UserX,
  cancelada: Ban,
} as const

/** Color del icono y del texto de estado, con los tokens semánticos del tema. */
export function statusTextClass(status: ScheduleStatus): string {
  return cn(
    status === "programada" && "text-warning",
    status === "confirmada" && "text-success",
    status === "atendida" && "text-muted-foreground",
    status === "no_asistio" && "text-destructive",
    status === "cancelada" && "text-muted-foreground",
  )
}

/**
 * Superficie de la cita en rejilla y lista: el fondo dice el estado de un
 * vistazo (verde confirmada, ámbar por confirmar, gris atendida) y el icono lo
 * repite, para que nunca dependa solo del color.
 */
export function statusSurfaceClass(status: ScheduleStatus): string {
  return cn(
    status === "programada" && "bg-warning-soft text-foreground",
    status === "confirmada" && "bg-success-soft text-foreground",
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
  status: ScheduleStatus
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

