/**
 * Aviso de suscripción en el layout de la clínica.
 * - Prueba/gracia como plan: solo owner/admin.
 * - Restricción/pausa/cancelación: todos, sin importes, sin ocultar
 *   permanente (no se deja acciones 403 sin contexto).
 * - Nunca rompe la pantalla por error: muestra reintento explícito.
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { apiFetch } from "../lib/api"
import { panelUrl } from "../lib/host"
import { useOrgProfile } from "../lib/org"

interface SaasStatus {
  status: "prueba" | "activa" | "gracia" | "restringida" | "pausada" | "cancelada" | "sin_suscripcion"
  isDemo: boolean
  trialEndsAt: string | null
  graceEndsAt: string | null
}

function dateLabel(iso: string | null, locale: string, timeZone: string): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

export function SaasStatusBanner({ organizationId, role }: { organizationId: string; role: string }) {
  const [dismissed, setDismissed] = useState(false)
  const profile = useOrgProfile()
  const locale = profile.data?.locale ?? "es-PE"
  const timeZone = profile.data?.timezone ?? "UTC"
  const status = useQuery({
    queryKey: ["saas", organizationId, "status"],
    queryFn: () =>
      apiFetch<{ data: SaasStatus }>(
        `/api/account/billing/status?orgId=${encodeURIComponent(organizationId)}`,
      ).then((res) => res.data),
    retry: false,
    staleTime: 60_000,
  })
  if (status.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-4 text-sm">
        <p className="min-w-0 flex-1">No pudimos consultar el estado de tu plan.</p>
        <button type="button" className="font-medium underline" onClick={() => void status.refetch()}>
          Reintentar
        </button>
      </div>
    )
  }
  const data = status.data
  if (!data || data.isDemo) return null
  const blocked = data.status === "restringida" || data.status === "pausada" || data.status === "cancelada"
  const canPay = role === "owner" || role === "admin"
  // Plan (prueba/gracia) solo para quien administra; restricción para todos.
  if (!blocked && !canPay) return null
  if (dismissed && !blocked) return null
  let message: string | null = null
  if (data.status === "restringida") {
    message = "El acceso está restringido por falta de pago. Puedes ver tu plan y registrar tu comprobante en el panel."
  } else if (data.status === "pausada") {
    message = "La suscripción está en pausa. Escribe a soporte para reanudarla."
  } else if (data.status === "cancelada") {
    message = "La suscripción está cancelada. Escribe a soporte si necesitas retomarla."
  } else if (data.status === "gracia") {
    const fromTrial =
      data.trialEndsAt !== null && Date.now() - new Date(data.trialEndsAt).getTime() < 8 * 86400000
    message = fromTrial
      ? `Tu prueba terminó: tienes hasta el ${dateLabel(data.graceEndsAt, locale, timeZone)} para confirmar tu plan.`
      : "Hay un pago pendiente: regularízalo antes de que el acceso se restrinja."
  } else if (data.status === "prueba" && data.trialEndsAt !== null) {
    if (new Date(data.trialEndsAt).getTime() - Date.now() > 3 * 86400000) return null
    message = `Tu prueba termina el ${dateLabel(data.trialEndsAt, locale, timeZone)}.`
  }
  if (!message) return null
  return (
    <div
      role="status"
      className={
        blocked
          ? "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm"
          : "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-2 text-sm"
      }
    >
      <p className="min-w-0 flex-1">{message}</p>
      {canPay ? (
        <a className="font-medium underline" href={panelUrl(`/billing/${organizationId}`)}>
          Ver mi plan
        </a>
      ) : null}
      {!blocked ? (
        <button
          type="button"
          className="text-muted-foreground underline"
          aria-label="Ocultar aviso"
          onClick={() => setDismissed(true)}
        >
          Ocultar
        </button>
      ) : null}
    </div>
  )
}
