/**
 * Las pestañas de la ficha del cliente por su fase (ADR 0196) y quién entra a cada una. Las leen
 * la ficha y su esqueleto. A la vista: Resumen, Conversaciones (solo Administración: la Bandeja
 * es suya), Historial, la pestaña de su fase (Venta mientras se vende o se decidió, Alta en alta,
 * Uso activa), Plan y pagos (Administración, con cuenta), Soporte si tiene casos abiertos y
 * Documentos. En «Más», las de las otras fases que aplican: Venta siempre; Alta y Uso, con cuenta;
 * y Soporte con cuenta y sin casos abiertos. Una pestaña que no toca, aunque llegue en el enlace,
 * abre el Resumen; `contactos` abre el Resumen con sus personas al lado.
 */
import type { ClientTab } from "../../lib/list-search"
import type { ClientPhase } from "./inbox-api"

export const CLIENT_TAB_NAMES: Record<ClientTab, string> = {
  resumen: "Resumen",
  conversaciones: "Conversaciones",
  historial: "Historial",
  contactos: "Personas",
  venta: "Venta",
  alta: "Alta",
  pagos: "Plan y pagos",
  uso: "Uso",
  soporte: "Soporte",
  documentos: "Documentos",
}

export interface ClientTabRules {
  phase: ClientPhase
  hasAccount: boolean
  isAdmin: boolean
  /** Casos de soporte sin resolver: con alguno, Soporte va a la vista. */
  openSupportCases: number
}

export interface ClientTabLayout {
  /** Las pestañas a la vista, en su orden. */
  tabs: ClientTab[]
  /** Las que van en «Más»: las de las otras fases que aplican (y Soporte sin casos abiertos). */
  more: ClientTab[]
}

type PhaseTab = "venta" | "alta" | "uso"

/** La pestaña de la fase: Venta mientras se vende o se decidió, Alta en alta y Uso activa. */
export function phaseTab(phase: ClientPhase): PhaseTab {
  return phase === "en_alta" ? "alta" : phase === "activo" ? "uso" : "venta"
}

export function clientTabsFor(rules: ClientTabRules): ClientTabLayout {
  const own = phaseTab(rules.phase)
  const supportVisible = rules.hasAccount && rules.openSupportCases > 0
  const tabs: ClientTab[] = [
    "resumen",
    ...(rules.isAdmin ? (["conversaciones"] as const) : []),
    "historial",
    own,
    ...(rules.isAdmin && rules.hasAccount ? (["pagos"] as const) : []),
    ...(supportVisible ? (["soporte"] as const) : []),
    "documentos",
  ]
  const phases: PhaseTab[] = ["venta", "alta", "uso"]
  const more: ClientTab[] = [
    ...phases.filter((tab) => tab !== own && (tab === "venta" || rules.hasAccount)),
    ...(rules.hasAccount && !supportVisible ? (["soporte"] as const) : []),
  ]
  return { tabs, more }
}

/**
 * La pestaña que abre la dirección (`?tab=`): una de la vista o de «Más»; `contactos` y lo que no
 * toca (Plan y pagos sin ser Administración, lo de la cuenta sin cuenta), el Resumen.
 */
export function openClientTab(wanted: ClientTab | undefined, rules: ClientTabRules): ClientTab {
  if (!wanted) return "resumen"
  const { tabs, more } = clientTabsFor(rules)
  return tabs.includes(wanted) || more.includes(wanted) ? wanted : "resumen"
}

/**
 * Las pestañas que se dibujan: las de la vista y, si la abierta es de «Más», también ella, junto
 * a la de su fase (así se ve dónde se está). «Más» no repite la que ya se ve.
 */
export function shownClientTabs(
  layout: ClientTabLayout,
  open: ClientTab,
): { tabs: ClientTab[]; more: ClientTab[] } {
  if (!layout.more.includes(open)) return layout
  const tabs = [...layout.tabs]
  const after = tabs.findIndex((tab) => tab === "venta" || tab === "alta" || tab === "uso")
  tabs.splice(after + 1, 0, open)
  return { tabs, more: layout.more.filter((tab) => tab !== open) }
}
