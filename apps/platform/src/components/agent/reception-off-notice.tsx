import { buttonVariants, cn } from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { usePermission } from "../../lib/crm"
import { useAgentPanelSummary } from "../agent-panel"

/**
 * «Recepción está apagada», para la Bandeja: quien atiende sabe que nadie más
 * responde. El estado sale del resumen del panel del agente (la misma consulta
 * que ya mantiene el layout), así que lo ve quien decide o supervisa al agente.
 * La acción solo aparece para quien lo administra; el resto lee a quién pedirlo.
 * Mientras no se sabe el estado no se dice nada.
 */
export function ReceptionOffNotice({ className }: { className?: string }) {
  const canSee = usePermission("agent.read")
  const canDecide = usePermission("agent.decide")
  const canManage = usePermission("agent.write")
  const summary = useAgentPanelSummary(canSee || canDecide)
  if (summary.data?.data.enabled !== false) return null
  return (
    <div role="status" className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-muted px-3.5 py-2.5", className)}>
      <div className="min-w-0 flex-1 basis-52">
        <p className="font-bold">Recepción está apagada</p>
        <p className="text-sm text-muted-foreground">
          {canManage
            ? "Tu equipo responde todas las conversaciones."
            : "Tu equipo responde todo. Para encenderla, habla con quien administra la clínica."}
        </p>
      </div>
      {canManage ? (
        <Link
          to="/agent/recepcion"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-11 border-primary bg-card text-primary-soft-foreground sm:min-h-9")}
        >
          Ver y encender
        </Link>
      ) : null}
    </div>
  )
}
