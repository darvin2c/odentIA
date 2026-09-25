/**
 * El estado de la cita dicho una sola vez: punto, etiqueta y clases del
 * bloque. Los colores semánticos siguen la convención de `badge` de
 * @odentia/ui (paleta Tailwind con par dark explícito) porque el theme no
 * tiene tokens info/success/warning; `primary` y `destructive` sí son tokens.
 */

import { cn } from "@odentia/ui"

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
 * Clases del bloque de cita: fondo suave con borde al color del estado; lo
 * cancelado se lee como tachado y atenuado, no como otro color más.
 */
export function statusBlockClasses(status: ScheduleStatus): string {
  return cn(
    "border",
    status === "programada" &&
      "border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-100",
    status === "confirmada" &&
      "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-100",
    status === "atendida" && "border-primary/40 bg-primary/10 text-foreground",
    status === "no_asistio" &&
      "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100",
    status === "cancelada" &&
      "border-dashed border-destructive/40 bg-muted/40 text-muted-foreground line-through decoration-destructive/60",
  )
}

