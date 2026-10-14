import { Button } from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { CircleAlert, CircleCheck } from "lucide-react"
import type { FormEvent, ReactNode } from "react"
import type { AgentOverview } from "../../lib/agent"
import { apiFetch } from "../../lib/api"
import { channelLabel } from "../../lib/channels"
import { mutationErrorMessage } from "../../lib/query-error"

function Check({
  ok,
  title,
  detail,
  action,
}: {
  ok: boolean
  title: string
  detail: string
  action?: ReactNode
}) {
  return (
    <li className="flex flex-wrap items-start gap-2.5 rounded-xl border p-3">
      <span className={`mt-0.5 shrink-0 [&>svg]:size-5 ${ok ? "text-success" : "text-warning"}`}>
        {ok ? <CircleCheck aria-hidden /> : <CircleAlert aria-hidden />}
      </span>
      <span className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">{title}</span>
        <span className="sr-only">{ok ? " (listo)" : " (falta)"}</span>
        <span className="block text-muted-foreground">{detail}</span>
      </span>
      {action}
    </li>
  )
}

const LINK = "inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline sm:min-h-8"

/**
 * Encender Recepción por primera vez: cuatro comprobaciones (lo que falta
 * lleva a donde se resuelve). Lo que puede hacer lo dicen sus funciones, en la
 * página; no hay niveles que elegir (ADR 0021). Solo la falta de un
 * canal deja el botón sin efecto: sin canal no le llega ningún mensaje y
 * encender no cambiaría nada. Las otras tres avisan y dejan encender; el
 * servidor no exige ninguna.
 */
export function TurnOnDrawer({
  open,
  onClose,
  overview,
  onTest,
}: {
  open: boolean
  onClose: () => void
  overview: AgentOverview
  /** Lleva a «Probar» sin perder el encendido a medias. */
  onTest: () => void
}) {
  const queryClient = useQueryClient()
  const turnOn = useMutation({
    retry: false,
    mutationFn: () => apiFetch("/api/agent/config", { method: "PUT", body: JSON.stringify({ enabled: true }) }),
    onSuccess: () => {
      for (const key of ["agent-config", "agent-overview", "agent-panel"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
      onClose()
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!turnOn.isPending) turnOn.mutate()
  }

  const { readiness, knows } = overview
  const hasChannel = readiness.channels.length > 0
  return (
    <FormDrawer
      open={open}
      onClose={() => {
        turnOn.reset()
        onClose()
      }}
      title="Encender Recepción"
      description="Cuatro comprobaciones. Lo que falta te lleva a donde se resuelve."
      onSubmit={submit}
      isSubmitting={turnOn.isPending}
      error={mutationErrorMessage(turnOn.error)}
      submitLabel="Encender Recepción"
      cancelLabel="Ahora no"
      submitDisabled={!hasChannel}
    >
      <div className="flex flex-col gap-5">
      <ul className="flex flex-col gap-2">
        <Check
          ok={hasChannel}
          title="Un canal conectado"
          detail={
            hasChannel
              ? readiness.channels.map((channel) => channelLabel(channel)).join(", ")
              : "Sin un canal conectado no le llega ningún mensaje."
          }
          action={
            hasChannel ? undefined : (
              <Link to="/settings/integrations" className={LINK}>
                Conectar un canal
              </Link>
            )
          }
        />
        <Check
          ok={knows.basicsCovered === knows.basicsTotal}
          title={`Lo básico de tu clínica: ${knows.basicsCovered} de ${knows.basicsTotal}`}
          detail="Puedes encender así. Lo que no sepa, lo dice y lo pasa a una persona."
          action={
            knows.basicsCovered === knows.basicsTotal ? undefined : (
              <Link to="/agent/knowledge" className={LINK}>
                Completar
              </Link>
            )
          }
        />
        <Check
          ok={readiness.sandboxTurns > 0}
          title="Lo probaste"
          detail={
            readiness.sandboxTurns > 0
              ? `${readiness.sandboxTurns} ${readiness.sandboxTurns === 1 ? "mensaje de prueba" : "mensajes de prueba"}`
              : "Todavía no le escribiste ninguna prueba."
          }
          action={
            <Button type="button" variant="link" size="sm" className="h-auto min-h-11 p-0 sm:min-h-8" onClick={onTest}>
              {readiness.sandboxTurns > 0 ? "Probar otra" : "Probar"}
            </Button>
          }
        />
        <Check
          ok={readiness.receivers.length > 0}
          title="Alguien recibe lo que pasa a una persona"
          detail={
            readiness.receivers.length > 0
              ? readiness.receivers.join(", ")
              : "Nadie de tu equipo puede tomar los casos que pase."
          }
          action={
            readiness.receivers.length > 0 ? undefined : (
              <Link to="/settings/team" className={LINK}>
                Invitar a alguien
              </Link>
            )
          }
        />
      </ul>

      <p className="text-sm text-muted-foreground">Responde siempre al momento. Antes de reservar, mover o cancelar una cita le pide el «sí» al paciente. Lo apagas cuando quieras; lo que esté a medias pasa a tu equipo.</p>
      </div>
    </FormDrawer>
  )
}
