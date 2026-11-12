/**
 * Las pestañas de la ficha del cliente y quién entra a cada una. Las leen la
 * ficha y su esqueleto. Alta, Plan y pagos, Uso y Soporte son de la cuenta:
 * solo con cuenta. Plan y pagos es solo de Administración (la API también se
 * la niega a Soporte). Una pestaña que no toca, aunque llegue en el enlace,
 * abre el Resumen.
 */
import { CLIENT_TABS, type ClientTab } from "../../lib/list-search"

export const CLIENT_TAB_NAMES: Record<ClientTab, string> = {
  resumen: "Resumen",
  historial: "Historial",
  contactos: "Contactos",
  venta: "Venta",
  alta: "Alta",
  pagos: "Plan y pagos",
  uso: "Uso",
  soporte: "Soporte",
  documentos: "Documentos",
}

const ACCOUNT_TABS: readonly ClientTab[] = ["alta", "pagos", "uso", "soporte"]
const ADMIN_TABS: readonly ClientTab[] = ["pagos"]

export function clientTabsFor({
  hasAccount,
  isAdmin,
}: {
  hasAccount: boolean
  isAdmin: boolean
}): ClientTab[] {
  return CLIENT_TABS.filter(
    (tab) => (hasAccount || !ACCOUNT_TABS.includes(tab)) && (isAdmin || !ADMIN_TABS.includes(tab)),
  )
}

export function openClientTab(
  wanted: ClientTab | undefined,
  rules: { hasAccount: boolean; isAdmin: boolean },
): ClientTab {
  return wanted && clientTabsFor(rules).includes(wanted) ? wanted : "resumen"
}
