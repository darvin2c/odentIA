import { Button } from "@odentia/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ShieldAlert } from "lucide-react"
import { z } from "zod"
import { apiFetch } from "../lib/api"
import { mutationErrorMessage } from "../lib/query-error"

const activeGrant = z.object({
  id: z.string(),
  caseId: z.string(),
  scope: z.string(),
  expiresAt: z.string(),
  grantedBy: z.string(),
  createdAt: z.string(),
})
type ActiveGrant = z.infer<typeof activeGrant>

const activeGrantsEnvelope = z.object({ data: z.array(activeGrant) })

/**
 * Aviso global de la clínica mientras hay accesos diagnóstico vigentes a
 * odentIA. Vive en el layout de la organización (contexto de org por
 * cabeceras, sin caseId): muestra alcance y vencimiento por permiso. El botón
 * Revocar solo se ofrece con `canRevoke` (owner/admin); el servidor lo vuelve
 * a exigir. No afirma lectura en curso: el permiso puede estar concedido sin
 * usarse.
 */
export function SupportGrantBanner({ canRevoke }: { canRevoke: boolean }) {
  const queryClient = useQueryClient()
  const grants = useQuery({
    queryKey: ["support-active-grants"],
    queryFn: () => apiFetch("/api/help/grants/active").then((body: unknown) => activeGrantsEnvelope.parse(body).data),
    staleTime: 30_000,
    retry: false,
    refetchInterval: 60_000,
  })
  const revoke = useMutation({
    retry: false,
    mutationFn: (grant: ActiveGrant) =>
      apiFetch(`/api/help/cases/${grant.caseId}/grants/revoke`, {
        method: "POST",
        body: JSON.stringify({ grantId: grant.id }),
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["support-active-grants"] }),
  })

  if (grants.isError) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border px-3.5 py-2 text-sm text-muted-foreground">
        <p className="flex-1">No pude comprobar los accesos de soporte.</p>
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-sm font-semibold text-primary"
          onClick={() => void grants.refetch()}
        >
          Reintentar
        </Button>
      </div>
    )
  }
  const items = grants.data ?? []
  if (items.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      {items.map((grant) => (
        <div
          key={grant.id}
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-warning/40 bg-warning-soft px-3.5 py-2.5 text-sm"
        >
          <ShieldAlert className="size-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">
            La clínica autorizó acceso diagnóstico a odentIA hasta el {new Date(grant.expiresAt).toLocaleString()}.
            Solo configuración operacional, nunca pacientes ni secretos.
          </p>
          {canRevoke ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 shrink-0 sm:min-h-9"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(grant)}
            >
              Revocar
            </Button>
          ) : null}
        </div>
      ))}
      {revoke.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {mutationErrorMessage(revoke.error)}
        </p>
      ) : null}
    </div>
  )
}
