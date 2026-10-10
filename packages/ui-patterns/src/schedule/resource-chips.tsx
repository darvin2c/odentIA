/**
 * Fichas de recurso: de quién es la agenda que se está viendo. Una fila que se
 * desplaza de lado, con las iniciales de color de cada profesional o sillón.
 * Es la forma de cambiar de recurso en teléfono, donde solo cabe uno, y de
 * elegir «con quién» al reservar.
 */

import { cn } from "@odentia/ui"

import { ResourceAvatar } from "./tone.js"
import type { ScheduleColumn } from "./types.js"

export interface ScheduleResourceChipsProps {
  resources: ScheduleColumn[]
  /** Recurso elegido; null = todos (solo si hay `allLabel`). */
  value: string | null
  onChange: (id: string | null) => void
  /** Rótulo de la ficha que no elige a nadie («Todos», «Cualquiera»). */
  allLabel?: string
  /** Nombre accesible del grupo («Profesionales»). */
  label: string
  /** En formularios las fichas saltan de línea en vez de desplazarse. */
  wrap?: boolean
  /** Texto de la ficha cuando el nombre completo no cabe («Ana»). Las iniciales no cambian. */
  formatLabel?: (resource: ScheduleColumn) => string
  /** Segunda línea de la ficha: lo que conviene comparar entre recursos («Libre 11:00»). */
  detailOf?: (resource: ScheduleColumn) => string | undefined
  className?: string
}

export function ScheduleResourceChips({
  resources,
  value,
  onChange,
  allLabel,
  label,
  wrap = false,
  formatLabel,
  detailOf,
  className,
}: ScheduleResourceChipsProps) {
  const chip = "flex h-11 shrink-0 items-center gap-2 rounded-full border text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
  const on = "border-primary bg-primary-soft font-bold text-primary-soft-foreground ring-1 ring-primary"
  const off = "border-border bg-card font-semibold hover:border-primary"
  return (
    <fieldset
      className={cn(
        "flex min-w-0 gap-2 border-0 p-0",
        wrap
          ? "flex-wrap"
          : "shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      <legend className="sr-only">{label}</legend>
      {allLabel ? (
        <button
          type="button"
          aria-pressed={value === null}
          onClick={() => onChange(null)}
          className={cn(chip, "px-4", value === null ? on : off)}
        >
          {allLabel}
        </button>
      ) : null}
      {resources.map((resource) => {
        const chosen = resource.id === value
        const detail = detailOf?.(resource)
        return (
          <button
            key={resource.id}
            type="button"
            aria-pressed={chosen}
            title={resource.warning ?? (formatLabel ? resource.label : undefined)}
            onClick={() => onChange(resource.id)}
            className={cn(chip, "pr-3.5 pl-1.5", chosen ? on : off)}
          >
            <ResourceAvatar
              label={resource.label}
              tone={resource.tone}
              size="sm"
              className={cn(chosen && "ring-2 ring-card")}
            />
            <span className="flex flex-col items-start whitespace-nowrap">
              <span className={cn(detail && "leading-[17px]")}>
                {formatLabel ? formatLabel(resource) : resource.label}
              </span>
              {detail ? (
                <span className="text-xs leading-[14px] font-semibold text-primary-soft-foreground">
                  {detail}
                </span>
              ) : null}
            </span>
          </button>
        )
      })}
    </fieldset>
  )
}
