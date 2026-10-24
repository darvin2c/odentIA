import { Button } from "@odentia/ui"
import { PageNotice } from "@odentia/ui-patterns"
import { Link } from "@tanstack/react-router"
import { useReceptionName, withReceptionName } from "../../lib/agent-names"
import { usePermission } from "../../lib/crm"
import { useAgentPanelSummary } from "../agent-panel"
import { useClinicNotices, useRaiseCap } from "../clinic-notices"

/**
 * «Sofi no está atendiendo», para la Bandeja: quien atiende sabe que nadie más
 * responde. El estado sale del resumen del panel del agente (la misma consulta
 * que ya mantiene el layout), así que lo ve quien decide o supervisa al agente.
 * La acción solo aparece para quien lo administra; el resto lee a quién pedirlo.
 * Mientras no se sabe el estado no se dice nada. Es un aviso de esta pantalla
 * (`PageNotice`), no de la franja: solo importa donde se atienden conversaciones.
 */
export function ReceptionOffNotice({ className }: { className?: string }) {
  const canSee = usePermission("agent.read")
  const canDecide = usePermission("agent.decide")
  const canManage = usePermission("agent.write")
  const receptionName = useReceptionName()
  const summary = useAgentPanelSummary(canSee || canDecide)
  if (summary.data?.data.enabled !== false) return null
  return (
    <PageNotice
      tone="aviso"
      label={`${receptionName} no está atendiendo`}
      className={className}
      action={
        canManage ? (
          <Button variant="outline" size="sm" className="min-h-11 sm:min-h-9" render={<Link to="/agent/recepcion" />}>
            Ver y encender
          </Button>
        ) : undefined
      }
    >
      {canManage
        ? "Tu equipo responde todas las conversaciones."
        : "Tu equipo responde todo. Para encenderla, habla con quien administra la clínica."}
    </PageNotice>
  )
}

/**
 * Llegaron al tope de gasto (ADR 0065): Sofi deja de atender casos nuevos
 * y le llegan al equipo. Lo dice en la Bandeja y en el Agente, con el texto que
 * el servidor da a cada uno; «Subir tope» solo para quien ve Plan y pagos.
 */
export function CapReachedNotice({ className }: { className?: string }) {
  const notices = useClinicNotices()
  const raiseCap = useRaiseCap()
  const receptionName = useReceptionName()
  const cap = notices.data?.find((notice) => notice.topic === "tope" && notice.tone === "limite")
  if (!cap) return null
  return (
    <PageNotice
      tone="limite"
      label="Tope de gasto"
      className={className}
      action={
        cap.action?.kind === "subir_tope" ? (
          <Button variant="outline" size="sm" className="min-h-11 sm:min-h-9" onClick={raiseCap}>
            Subir tope
          </Button>
        ) : undefined
      }
    >
      {withReceptionName(cap.message, receptionName)}
    </PageNotice>
  )
}
