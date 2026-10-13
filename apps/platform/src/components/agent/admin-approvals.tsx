import { Button } from "@odentia/ui"
import { AgentMark, AgentSurface, ConfirmDialog } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { type AdminApproval, refreshAdmin } from "../../lib/admin"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { mutationErrorMessage } from "../../lib/query-error"

/**
 * Lo que el Administrador encargó a Recepción y espera aprobación porque el
 * agente está en «Supervisado». Va agrupado por línea: todos los mensajes de
 * una línea llevan el mismo texto aprobado, con los datos de cada persona. Los
 * recordatorios no pasan por aquí: prenderlos ya fue aprobarlos.
 */
export function AdminApprovals() {
  const queryClient = useQueryClient()
  const canDecide = usePermission("agent.decide")
  const canWrite = usePermission("conversations.write")
  const [confirm, setConfirm] = useState<{ item: AdminApproval; decision: "aprobar" | "rechazar" } | null>(null)
  const query = useQuery({
    queryKey: ["agent-admin-approvals"],
    queryFn: () => apiFetch<{ data: AdminApproval[] }>("/api/agent/admin/approvals"),
    enabled: canDecide,
    retry: false,
  })
  const decide = useMutation({
    retry: false,
    mutationFn: (input: { key: string; decision: "aprobar" | "rechazar" }) =>
      apiFetch(`/api/agent/admin/approvals/${input.key}`, { method: "POST", body: JSON.stringify({ decision: input.decision }) }),
    onSuccess: () => {
      setConfirm(null)
      refreshAdmin(queryClient)
    },
  })
  const items = query.data?.data ?? []
  if (!canDecide || items.length === 0) return null
  return (
    <AgentSurface aria-label="Mensajes que encargó el administrador" className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <AgentMark />
        <div className="min-w-0">
          <h2 className="font-semibold">Los encargó el administrador</h2>
          <p className="text-sm text-muted-foreground">
            Recepción está en «Supervisado»: estos mensajes esperan tu aprobación. Los recordatorios de cita y de control no pasan por aquí.
          </p>
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3 text-sm">
            <div className="min-w-0 flex-1 basis-64">
              <p className="font-semibold">
                {item.total} {item.total === 1 ? "mensaje" : "mensajes"}: {item.name.charAt(0).toLowerCase() + item.name.slice(1)}
              </p>
              <p className="text-muted-foreground">
                {item.total === 1 ? "Para" : "Mismo texto aprobado para"} {item.people.join(", ")}
                {item.total > item.people.length ? ` y ${item.total - item.people.length} más` : ""}.{" "}
                <Link to="/agent/administrador" search={{ linea: item.key }} className="font-semibold text-primary hover:underline">
                  Ver el mensaje y su flujo
                </Link>
              </p>
            </div>
            {canWrite ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" className="min-h-11 sm:min-h-9" disabled={decide.isPending} onClick={() => setConfirm({ item, decision: "aprobar" })}>
                  Aprobar y enviar
                </Button>
                <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" disabled={decide.isPending} onClick={() => setConfirm({ item, decision: "rechazar" })}>
                  Rechazar
                </Button>
              </div>
            ) : (
              <span className="text-muted-foreground">Lo aprueba quien atiende conversaciones.</span>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.decision === "aprobar" ? "Aprobar y enviar" : "Rechazar"}
        description={
          confirm
            ? confirm.decision === "aprobar"
              ? `Salen ${confirm.item.total === 1 ? "el mensaje" : `los ${confirm.item.total} mensajes`} de «${confirm.item.name}». Antes de cada uno se vuelve a comprobar que el motivo siga en pie, el permiso de la persona y el horario.`
              : `No se envía ${confirm.item.total === 1 ? "el mensaje" : `ninguno de los ${confirm.item.total} mensajes`} de «${confirm.item.name}». La línea sigue prendida para los casos que vengan.`
            : ""
        }
        confirmLabel={confirm?.decision === "aprobar" ? "Aprobar y enviar" : "Rechazar"}
        variant={confirm?.decision === "aprobar" ? "default" : "destructive"}
        pending={decide.isPending}
        onClose={() => {
          if (!decide.isPending) {
            decide.reset()
            setConfirm(null)
          }
        }}
        onConfirm={() => confirm && decide.mutate({ key: confirm.item.key, decision: confirm.decision })}
      >
        {decide.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {mutationErrorMessage(decide.error)}
          </p>
        ) : null}
      </ConfirmDialog>
    </AgentSurface>
  )
}
