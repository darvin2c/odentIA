/**
 * Las pestañas de la ficha de una clínica y a cuáles entra cada rol. Las leen la
 * pantalla y su esqueleto, así que los dos ofrecen siempre las mismas.
 */

export const ORGANIZATION_TABS = ["resumen", "gastos", "precio", "equipo", "actividad", "carga"] as const
export type OrganizationTab = (typeof ORGANIZATION_TABS)[number]

export const ORGANIZATION_TAB_NAMES: Record<OrganizationTab, string> = {
  resumen: "Resumen",
  gastos: "Gastos",
  precio: "Precio y prueba",
  equipo: "Equipo",
  actividad: "Actividad",
  carga: "Cargar datos",
}

/** Lo que soporte no abre: importes y precios (decisión D4) y los datos de pacientes que se cargan. */
const ADMIN_TABS: readonly OrganizationTab[] = ["gastos", "precio", "carga"]

export function organizationTabsFor(isAdmin: boolean): OrganizationTab[] {
  return ORGANIZATION_TABS.filter((tab) => isAdmin || !ADMIN_TABS.includes(tab))
}

/** La pestaña de la dirección si ese rol la abre; si no, Resumen, aunque llegue con el enlace. */
export function openOrganizationTab(wanted: OrganizationTab | undefined, isAdmin: boolean): OrganizationTab {
  return wanted && organizationTabsFor(isAdmin).includes(wanted) ? wanted : "resumen"
}
