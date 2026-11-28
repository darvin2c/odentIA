import type { FilterDef } from "@odentia/ui-patterns"
import { Banknote, MapPin, Truck } from "lucide-react"
import { cuentas, type Pedido } from "./modelo"

/**
 * Los filtros que Pedidos y Despachos comparten, para que las dos pantallas filtren igual:
 * Repartidor, Cobro y Zona. Cada opción lleva su número, contado sobre lo que se está mirando.
 */
export type Rep = "Kevin" | "Jhon" | "agencia" | "sin"
export const REP_LABEL: Record<Rep, string> = {
  Kevin: "Kevin",
  Jhon: "Jhon",
  agencia: "Por agencia",
  sin: "Sin repartidor",
}
export function repDe(p: Pedido): Rep | null {
  const x = p.entrega
  if (x.tipo === "recojo") return null
  if (x.tipo === "agencia") return "agencia"
  return (x.repartidor as Rep | null) ?? "sin"
}

export type CobroF = "al_recibir" | "pagado" | "falta"
export const COBRO_LABEL: Record<CobroF, string> = {
  al_recibir: "Al recibir",
  pagado: "Pagado",
  falta: "Falta cobrar",
}
/** «Al recibir»: lo cobra el repartidor en la puerta. «Falta cobrar»: lo demás que no está pagado. */
export function cobroF(p: Pedido): CobroF | null {
  if (p.paso === "anulado") return null
  const k = cuentas(p)
  if (k.pagado) return "pagado"
  return k.alRecibir && !p.rechazo ? "al_recibir" : "falta"
}

export const zonaDe = (p: Pedido) => p.entrega.zona.split(",")[0] ?? p.entrega.zona

/** Lo elegido en cada filtro: `?rep=`, `?cobro=` y `?zona=` (varias, separadas por coma). */
export function pasaFiltros(p: Pedido, f: { rep?: string; cobro?: string; zona?: string }) {
  if (f.rep && repDe(p) !== f.rep) return false
  if (f.cobro && cobroF(p) !== f.cobro) return false
  if (f.zona && !f.zona.split(",").includes(zonaDe(p))) return false
  return true
}

/** Las definiciones del FilterBar, con el número de cada opción sobre `list`. */
export function filtrosComunes(list: Pedido[], conZona = true): FilterDef[] {
  const cuenta = (fn: (p: Pedido) => boolean) => list.filter(fn).length
  const zonas = [...new Set(list.filter((p) => p.entrega.tipo === "moto").map(zonaDe))].sort((a, b) =>
    a.localeCompare(b, "es"),
  )
  return [
    {
      key: "rep",
      label: "Repartidor",
      icon: Truck,
      type: "select",
      options: (Object.keys(REP_LABEL) as Rep[]).map((r) => ({
        value: r,
        label: REP_LABEL[r],
        count: cuenta((p) => repDe(p) === r),
      })),
    },
    {
      key: "cobro",
      label: "Cobro",
      icon: Banknote,
      type: "select",
      options: (Object.keys(COBRO_LABEL) as CobroF[]).map((c) => ({
        value: c,
        label: COBRO_LABEL[c],
        count: cuenta((p) => cobroF(p) === c),
      })),
    },
    ...(conZona
      ? ([
          {
            key: "zona",
            label: "Zona",
            icon: MapPin,
            type: "multi",
            placement: "overflow",
            options: zonas.map((z) => ({ value: z, label: z, count: cuenta((p) => zonaDe(p) === z) })),
          },
        ] satisfies FilterDef[])
      : []),
  ]
}
