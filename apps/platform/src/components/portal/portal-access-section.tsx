import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useState } from "react"
import { usePermission } from "../../lib/crm"
import { listPortalGrantsApi, listPortalLinksApi } from "../../lib/portal"
import { PortalGrantsPanel } from "./portal-grants-panel"
import { PortalInvitePanel } from "./portal-invite-panel"

/**
 * Acceso al portal colapsado por defecto: la ficha clínica queda inmediata y
 * la gestión (verificar permiso y emitir enlace) se abre a pedido.
 */
export function PatientPortalAccessSection({ patientId }: { patientId: string }) {
  const canManage = usePermission("patients.write")
  const [open, setOpen] = useState(false)
  const grantsQuery = useQuery({
    queryKey: ["portal-grants", patientId],
    queryFn: () => listPortalGrantsApi(patientId),
    enabled: canManage,
    retry: false,
  })
  const linksQuery = useQuery({
    queryKey: ["portal-links", patientId],
    queryFn: () => listPortalLinksApi(patientId),
    enabled: canManage,
    retry: false,
  })
  if (!canManage) return null

  const loading = grantsQuery.isPending || linksQuery.isPending
  const activeGrants = grantsQuery.data?.filter((g) => g.status === "activo").length ?? 0
  const pendingLinks = linksQuery.data?.filter((l) => l.status === "pendiente").length ?? 0
  const status = loading
    ? "consultando accesos…"
    : activeGrants === 0 && pendingLinks === 0
      ? "sin accesos"
      : [
          `${activeGrants} permiso${activeGrants === 1 ? "" : "s"} activo${activeGrants === 1 ? "" : "s"}`,
          `${pendingLinks} enlace${pendingLinks === 1 ? "" : "s"} pendiente${pendingLinks === 1 ? "" : "s"}`,
        ].join(" · ")

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="grid gap-2 rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <CollapsibleTrigger className="text-sm font-medium">
            <span className="flex items-center gap-1">
              Gestionar acceso al portal <ChevronDown aria-hidden className="size-4" />
            </span>
          </CollapsibleTrigger>
          <span className="text-xs text-muted-foreground">{status}</span>
        </div>
        <CollapsibleContent>
          <div className="grid gap-3 pt-1">
            <p className="text-sm text-muted-foreground">
              En dos pasos: 1) verifica el permiso del representante, 2) emite el enlace asistido
              por su conversación.
            </p>
            <PortalGrantsPanel patientId={patientId} />
            <PortalInvitePanel patientId={patientId} />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
