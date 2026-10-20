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

/**
 * Las condiciones comerciales que rigen hoy (ADR 0074): plazos y porcentajes
 * que acompañan al precio. Las escribe la administración de odentIA; ninguna
 * pantalla las repite a mano. Solo para quien ve Facturación.
 */
export interface SaasTerms {
  conversationWindowHours: number
  recoveryWindowDays: number
  reviewAutoPercent: number
  reviewAnswerDays: number
  reviewReadDays: number
  halfCycleDays: number
  warnPercent: number
  alarmPercent: number
  /** Días antes del fin de las condiciones de Fundador en que se avisa. */
  guaranteeNoticeDays: number
}

export function useSaasTerms() {
  const { org } = orgRouteApi.useRouteContext()
  return useQuery({
    queryKey: ["billing", org.id, "terms"],
    queryFn: () => apiFetch<{ data: SaasTerms }>(`/api/account/billing/terms?orgId=${encodeURIComponent(org.id)}`).then((res) => res.data),
    staleTime: 60_000,
    retry: false,
  })
}

/** «24 horas», «1 hora». */
export const hoursWords = (n: number) => `${n} ${n === 1 ? "hora" : "horas"}`
/** «2 días hábiles», «1 día hábil». */
export const businessDaysWords = (n: number) => `${n} ${n === 1 ? "día hábil" : "días hábiles"}`
/** «Una por persona cada 24 horas, aunque escriba diez mensajes o cambie de canal». */
export const conversationRule = (terms: SaasTerms) =>
  `Una por persona cada ${hoursWords(terms.conversationWindowHours)}, aunque escriba diez mensajes o cambie de canal`
