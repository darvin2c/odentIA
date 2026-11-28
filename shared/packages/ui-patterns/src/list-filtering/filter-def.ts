import type { Badge } from "@odentia/ui"
import type { LucideIcon } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"

/**
 * El tono de una opción, el mismo de su `Badge` (`variant`): en la tira, el punto de color de
 * la etapa. Nunca es la única señal: el nombre va escrito al lado.
 */
export type FilterTone = Exclude<NonNullable<ComponentProps<typeof Badge>["variant"]>, "ghost" | "link">

export type FilterOption = {
  value: string
  label: string
  count?: number
  /** Indicador visual complementario; label conserva el nombre textual accesible. */
  leading?: ReactNode
  /** El punto de color de la opción en la tira (`type: "strip"`), el de su `Badge`. */
  tone?: FilterTone
}

export type FilterPlacement = "primary" | "overflow"

type FilterBase = {
  key: string
  label: string
  icon?: LucideIcon
  placement?: FilterPlacement
}

export type FilterDef =
  | (FilterBase & {
      type: "select"
      options: FilterOption[]
    })
  | (FilterBase & {
      type: "multi"
      options: FilterOption[]
      /** Sin parámetro selecciona todos; `none` representa ninguno (valor reservado). */
      emptyMeansAll?: boolean
    })
  | (FilterBase & {
      type: "number-range"
      /**
       * El rango es un importe y viaja en la unidad menor de su moneda. El patrón
       * no conoce la moneda de la clínica: la app le dice cuántos decimales tiene
       * (ISO 4217: ninguno en CLP, dos en PEN, tres en KWD). Nunca se asumen dos.
       */
      money?: { fractionDigits: number }
    })
  | (FilterBase & {
      type: "date"
    })
  | (FilterBase & {
      type: "date-range"
    })
  | (Omit<FilterBase, "placement"> & {
      /**
       * La tira: una ficha por opción, con su punto de color, su nombre y cuántas hay
       * (`count`), más «Todas» con el total. Tocar una filtra; tocarla otra vez, o «Todas»,
       * lo quita. Las opciones sin ninguna no se ofrecen (salvo la elegida). En el teléfono
       * se desliza de lado. Cuenta como los demás filtros: «Limpiar» la quita.
       */
      type: "strip"
      options: FilterOption[]
      /** La ficha sin filtro: «Todas» (predeterminado), «Todos». */
      allLabel?: string
      /**
       * `below` (predeterminado): el `FilterBar` la pinta en su propia fila, bajo los demás.
       * `apart`: la página la pinta donde la necesita con `FilterStrip` (bajo el día que mira);
       * el `FilterBar` igual la cuenta en «Limpiar».
       */
      placement?: "below" | "apart"
    })

export type SortOption = { value: string; label: string }

export function paramKeys(filter: FilterDef): string[] {
  switch (filter.type) {
    case "number-range":
      return [`${filter.key}_min`, `${filter.key}_max`]
    case "date":
      return [`${filter.key}_on`]
    case "date-range":
      return [`${filter.key}_from`, `${filter.key}_to`]
    default:
      return [filter.key]
  }
}
