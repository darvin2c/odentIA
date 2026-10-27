/**
 * La búsqueda de la lista de organizaciones, recordada en esta pestaña: al
 * volver de la ficha de una clínica con «← Organizaciones», la lista sigue
 * como estaba (lienzo «Gastos por organización», decisión D3). Es solo una
 * comodidad de quien mira: sin almacenamiento, la lista abre limpia.
 */
export interface OrganizationsSearch {
  q?: string
  producto?: "dental" | "medical"
  precio?: "negociado"
  clase?: "real" | "demo"
}

const KEY = "admin.organizations.search"

export function rememberOrganizationsSearch(search: OrganizationsSearch): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(search))
  } catch {
    // Sin almacenamiento (ventana privada, bloqueado): la lista abre limpia.
  }
}

export function rememberedOrganizationsSearch(): OrganizationsSearch {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Record<string, unknown>
    return {
      ...(typeof raw.q === "string" && raw.q ? { q: raw.q } : {}),
      ...(raw.producto === "dental" || raw.producto === "medical"
        ? { producto: raw.producto }
        : {}),
      ...(raw.precio === "negociado" ? { precio: "negociado" as const } : {}),
      ...(raw.clase === "real" || raw.clase === "demo" ? { clase: raw.clase } : {}),
    }
  } catch {
    return {}
  }
}
