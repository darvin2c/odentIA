import { createContext, useContext } from "react"
import type { MyStore } from "../lib/api"
import type { Draft, RubroTemplate, Sheet } from "../lib/ficha"
import type { FichaStore, SaveStatus } from "./borrador"

/** Lo que comparten las tarjetas de la ficha: la ficha guardada, el borrador y quién la mira. */
export interface Ficha {
  store: MyStore
  sheet: Sheet
  base: Draft
  draft: Draft
  errors: Record<string, string>
  /** Cambia la ficha (`configuracion`): Dueño y Administrador. */
  edit: boolean
  /** Ve lo que costó (`costos.ver`): a Ventas ni se le dibuja. */
  costs: boolean
  /** La plantilla del rubro del producto (o la de calzado para nombrar filas y columnas). */
  rubro: RubroTemplate | null
  change: FichaStore["change"]
  status: SaveStatus
  /** El motivo para bajar el stock (ADR 0206): con él se guarda la cuadrícula. */
  setReason: (reason: string) => void
  /** Cómo se cuentan sus unidades: «pares» y «par», o «unidades». */
  unit: string
  unitOne: string
}

export const FichaContext = createContext<Ficha | null>(null)

export function useFichaContext(): Ficha {
  const value = useContext(FichaContext)
  if (!value) throw new Error("Fuera de la ficha")
  return value
}
