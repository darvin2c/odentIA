/**
 * Plan y pagos de la clínica (ADR 0065): lo que la clínica paga a odentIA vive
 * dentro de la clínica, en Configuración › Plan y pagos. Usa las mismas rutas
 * de cuenta que antes usaba el panel (`/api/account/billing/*`, con `orgId`):
 * el servidor decide quién las ve (`seesBilling`: propietario y administrador)
 * y las deja abiertas en cualquier estado de la suscripción.
 */
import { useQuery } from "@tanstack/react-query"
import { getRouteApi } from "@tanstack/react-router"
import { apiFetch } from "./api"
import { BASE_DOMAIN } from "./host"

export const PLAN_PATH = "/settings/plan"
export const PLAN_ACTIONS_PATH = "/settings/plan/acciones"

const orgRouteApi = getRouteApi("/_org")

/** «Clínica Sonrisa · sonrisa.odentia32.com · 3 sedes»: de qué clínica es lo que se ve. */
export function useClinicLine(): string {
  const { org } = orgRouteApi.useRouteContext()
  const branches = useQuery({
    queryKey: ["branches", "activas"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string; isActive: boolean }> }>("/api/branches"),
    staleTime: 60_000,
  })
  const active = branches.data?.data.filter((branch) => branch.isActive).length ?? 0
  const parts = [org.name, `${org.slug}.${BASE_DOMAIN}`]
  if (active > 0) parts.push(active === 1 ? "1 sede" : `${active} sedes`)
  return parts.join(" · ")
}
